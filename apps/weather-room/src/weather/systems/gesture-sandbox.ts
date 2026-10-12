/**
 * WEATHER//ROOM clap sandbox: direct-hand gesture detector that turns a
 * deliberate clap into the room's thunder moment and a deliberate one-hand
 * sweep into a directional gust, while the sandbox mode is on. Palm anchors
 * come from the framework hand model's own joint nodes
 * (`middle-finger-metacarpal`, falling back to `wrist`), and controller
 * sessions fall back to the grip spaces.
 *
 * The clap trigger emits the existing `WeatherEvent.Thunder`, so the audio
 * rumble (WeatherAudioSystem), the room-scale discharge (LightningBolt via
 * AtmosphereSystem) and the cloud/fog/light lift all answer through branches
 * that already existed. The sweep trigger stores a genuine directional gust
 * vector via `triggerSandboxGust` and emits `WeatherEvent.Gust` (new
 * vocabulary, same single bus) — the audible whoosh and controller haptic
 * are owned by that event's listener, never by the emitter, so gesture and
 * UI-button paths can never double-answer.
 *
 * Detection without false fires:
 * - clap distance: palm centers must close inside CLAP_TRIGGER_DISTANCE_M
 *   (10 cm). A real clap ends with palms 2–6 cm apart; tracked palm centers
 *   carry ~1 cm of jitter, so 10 cm tolerates tracking noise and palm-size
 *   variance while staying below any accidental near-touch.
 * - clap speed: the closing speed must exceed CLAP_MIN_CLOSING_SPEED_M_S
 *   (0.8 m/s). Casual gestures that happen to cross the body close at
 *   ~0.3–0.5 m/s; a deliberate clap strikes at 1–3+ m/s. The speed is an EMA
 *   over frames (α = 0.35) so single-frame jitter spikes cannot fire alone.
 * - clap cooldown: CLAP_COOLDOWN_S (2.0 s) matches the ~2 s thunder window —
 *   each clap owns one full rumble, and the recoil/re-approach of the same
 *   clap can never double-fire. Still allows a clap every 2 s.
 * - clap hysteresis: after a fire (or a cooldown expiry inside the zone) the
 *   palms must separate past CLAP_REARM_DISTANCE_M (18 cm) before the
 *   detector re-arms, so oscillating hands near the trigger radius cannot
 *   rattle the thunder.
 * - sweep: one hand's horizontal speed *relative to the head* must exceed
 *   SANDBOX_GUST_MIN_SPEED_M_S. Head-relative measurement means walking
 *   through the room with still hands can never fire a gust. A clap (or its
 *   recoil) is fast convergence and belongs to the clap path — sweeps are
 *   suppressed while the closing speed is high and for 0.35 s after any clap,
 *   so a single motion can only mean one thing. A sweep needs only its own hand:
 *   single-hand tracking allows gusts even when the opposite hand is lost.
 * - downward strike (controller-friendly thunder): one hand/grip driving down
 *   fast (>1.4 m/s) while the palms stay apart fires thunder instead of a
 *   gust — the explicit no-clash thunder path for controllers. No prompt ever
 *   asks the user to hit two controllers together (UI owner also exposes
 *   safe explicit buttons emitting the same events).
 * - cooldown/dt: gust per-hand cooldown 0.8 s; clap 2.0 s; all deltas clamped
 *   to [1e-4, 0.1] s so tab-switch hitches cannot mint ghost speed.
 *
 * Feedback follows the Meta hands guideline — hands have no haptics:
 * every accepted clap gets the clap cue (low sweep) + a contact impulse at
 * the palm midpoint (control-placement vocabulary); every accepted sweep gets
 * the Gust-event whoosh (same push-field voice). The thunder rumble and room
 * discharge ride the shared Thunder event, and controller sessions also get
 * the deep `Haptics.thunder` pulse.
 *
 * Tracking loss drops only the missing hand's baseline and disarms the clap.
 * The present hand keeps its head-relative velocity history. A replacement
 * anchor (including an input-mode switch) seeds a fresh sample before it can
 * strike or sweep; neither channel fires from a stale tracking pose.
 */

import { createSystem, Vector3 } from '@iwsdk/core';
import type { Object3D } from '@iwsdk/core';
import { WeatherEvent, weatherEvents, weatherStore } from '../weather-state.js';
import type { GustDetail, ThunderDetail } from '../weather-state.js';
import { Haptics, pulseHaptics } from '../feedback.js';
import { ContactImpulse, playClapCue, pulseHandHaptics } from '../control-placement.js';
import type { Handedness as ControlHandedness } from '../control-placement.js';
import { trackedInputKind } from '../capabilities.js';
import {
  SANDBOX_GUST_COOLDOWN_S,
  SANDBOX_GUST_FULL_SPEED_M_S,
  SANDBOX_GUST_MIN_SPEED_M_S,
  sandboxGustSetOrigin,
  stepSandboxGust,
  triggerSandboxGust,
  trySandboxThunder,
} from '../sandbox-gust.js';

/**
 * Palm centers closer than this (meters) qualify the distance half of a
 * clap. 2–6 cm is the physical end of a clap; +4 cm absorbs tracking jitter.
 */
export const CLAP_TRIGGER_DISTANCE_M = 0.1;
/**
 * Minimum closing speed (m/s) between the palm centers. Deliberate claps
 * strike at 1–3 m/s; incidental crossings stay under ~0.5 m/s.
 */
export const CLAP_MIN_CLOSING_SPEED_M_S = 0.8;
/**
 * Seconds after an accepted clap during which new claps are ignored. Set to
 * the thunder window so one clap = one complete rumble, with no overlap.
 */
export const CLAP_COOLDOWN_S = 2;
/**
 * Palms must separate past this distance (meters) before the detector
 * re-arms after a fire: hysteresis against oscillation inside the trigger
 * radius. Comfortably one hand-width; far below a re-clap wind-up.
 */
export const CLAP_REARM_DISTANCE_M = 0.18;
/** EMA factor on the per-frame closing speed; 1 = raw frame derivative. */
const CLAP_SPEED_EMA = 0.35;
/** Downward hand speed (m/s, head-relative) that counts as a thunder strike. */
const STRIKE_MIN_DOWN_SPEED_M_S = 1.4;
/** Strike cooldown, seconds: same thunder window as the clap. */
const STRIKE_COOLDOWN_S = 2;
/** Contact impulse color: warm lightning white. */
const CLAP_IMPULSE_COLOR = 0xfff3c4;

type Handedness = 'left' | 'right';

export class GestureSandboxSystem extends createSystem({}) {
  private readonly palmLeft = new Vector3();
  private readonly palmRight = new Vector3();
  private readonly clapPoint = new Vector3();
  private readonly sweepPrev: Record<Handedness, Vector3> = {
    left: new Vector3(),
    right: new Vector3(),
  };
  /** Additive flash at the clap midpoint; created once, reused. */
  private impulse: ContactImpulse | null = null;
  /** Smoothed closing speed in m/s; NaN while disarmed. */
  private closingSpeed = Number.NaN;
  /** Last frame's palm-center distance; NaN while disarmed. */
  private lastDistance = Number.NaN;
  private cooldown = 0;
  private strikeCooldown = 0;
  /** False between a fire and the palms separating past the re-arm radius. */
  private armed = true;
  /** Previous frame's palm anchors, for per-hand sweep speed. */
  private readonly lastPalm: Record<Handedness, Vector3> = {
    left: new Vector3(),
    right: new Vector3(),
  };
  /** Whether lastPalm holds a valid sample for this hand. */
  private readonly palmSeen: Record<Handedness, boolean> = { left: false, right: false };
  /** Smoothed horizontal sweep speed per hand (m/s). */
  private readonly sweepSpeed: Record<Handedness, number> = { left: 0, right: 0 };
  /** Smoothed horizontal sweep velocity per hand (m/s): EMA of dx/dt, dz/dt. */
  private readonly sweepVel: Record<Handedness, { x: number; z: number }> = {
    left: { x: 0, z: 0 },
    right: { x: 0, z: 0 },
  };
  /** Per-hand gust cooldown, seconds. */
  private readonly gustCooldown: Record<Handedness, number> = { left: 0, right: 0 };
  private readonly downSpeed: Record<Handedness, number> = { left: 0, right: 0 };
  private readonly strikeSeen: Record<Handedness, boolean> = { left: false, right: false };
  private readonly lastAnchor: Record<Handedness, Object3D | null> = { left: null, right: null };
  /** Seconds since the last accepted clap; a clap must not double as a gust. */
  private sinceClap = Number.POSITIVE_INFINITY;
  /** Head world position this frame and its per-frame delta (XZ used). */
  private readonly headNow = new Vector3();
  private readonly headPrev = new Vector3();
  private readonly headDelta = new Vector3();
  private headSeen = false;

  init(): void {
    this.impulse = new ContactImpulse(this.world, CLAP_IMPULSE_COLOR, 'Gesture Clap Impulse');
    this.cleanupFuncs.push(() => {
      this.impulse?.dispose();
      this.impulse = null;
    });
    // Gust is the single haptic owner for sweeps: one firm tap in the waving
    // hand only (Horizon rule: never buzz the idle hand). UI buttons emit the
    // same event, so both paths answer exactly once. Hands have no actuators
    // — the call is a silent no-op there; the whoosh carries it.
    this.cleanupFuncs.push(
      weatherEvents.on(WeatherEvent.Gust, (detail: unknown) => {
        let hand: ControlHandedness | null = null;
        if (detail != null && typeof detail === 'object' && 'source' in detail) {
          const source = detail.source;
          if (typeof source === 'string' && source.startsWith('sweep-')) {
            const which = source.slice('sweep-'.length);
            if (which === 'left' || which === 'right') hand = which;
          }
        }
        pulseHandHaptics(this.world, hand, Haptics.firmTap);
      }),
    );
  }

  /**
   * One hand's palm anchor: the framework hand model's metacarpal joint
   * (palm center), its wrist as fallback, or the controller grip space in
   * controller mode — the same anchors the hand occluder binds to.
   */
  private palmAnchor(hand: Handedness): Object3D | null {
    const kind = trackedInputKind(this.world, hand);
    if (kind === 'hand') {
      const model = this.input.xr.visualAdapters.hand[hand].visual?.model;
      return model?.getObjectByName('middle-finger-metacarpal') ?? model?.getObjectByName('wrist') ?? null;
    }
    if (kind === 'controller') return this.player.gripSpaces[hand];
    return null;
  }

  update(delta: number): void {
    const impulse = this.impulse;
    if (impulse != null) impulse.update(delta);
    // The gust envelope decays every frame, sandbox or not, so a flip of the
    // sandbox toggle can never leave a gust frozen mid-air.
    stepSandboxGust(delta);
    const dt = Number.isFinite(delta) ? Math.min(Math.max(delta, 1e-4), 0.1) : 0.016;
    this.sinceClap += dt;
    if (this.gustCooldown.left > 0) this.gustCooldown.left = Math.max(0, this.gustCooldown.left - dt);
    if (this.gustCooldown.right > 0) this.gustCooldown.right = Math.max(0, this.gustCooldown.right - dt);
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.strikeCooldown > 0) this.strikeCooldown = Math.max(0, this.strikeCooldown - dt);

    // Outside an immersive session there are no palm anchors at all; the
    // reset below also covers tracking loss for one or both hands.
    const left = this.palmAnchor('left');
    const right = this.palmAnchor('right');
    const hasLeft = left != null;
    const hasRight = right != null;
    if (left !== this.lastAnchor.left) {
      this.resetHand('left');
      this.lastAnchor.left = left;
    }
    if (right !== this.lastAnchor.right) {
      this.resetHand('right');
      this.lastAnchor.right = right;
    }
    if (!hasLeft && !hasRight) {
      this.reset();
      return;
    }
    if (!hasLeft || !hasRight) {
      this.resetHand(hasLeft ? 'right' : 'left');
      this.trackHead();
      const hand: Handedness = hasLeft ? 'left' : 'right';
      const anchor = hasLeft ? left : right;
      if (anchor != null) {
        const palm = hand === 'left' ? this.palmLeft : this.palmRight;
        anchor.getWorldPosition(palm);
        this.stepStrike(hand, palm, dt, true);
        this.stepSweep(hand, palm, dt, true);
      }
      return;
    }

    // Leaf joint nodes: getWorldPosition refreshes the ancestor chain on
    // the way up, which is enough for a world-space read this frame.
    left.getWorldPosition(this.palmLeft);
    right.getWorldPosition(this.palmRight);
    const distance = this.palmLeft.distanceTo(this.palmRight);


    this.trackHead();

    // Clap first: its fresh closing speed and timestamp are what tell the
    // sweep channel that this motion was a clap, not a wave.
    if (trackedInputKind(this.world, 'left') === 'hand' && trackedInputKind(this.world, 'right') === 'hand') {
      this.stepClap(distance, dt);
    } else {
      // Controller thunder uses the explicit button or one downward strike.
      this.lastDistance = distance;
      this.closingSpeed = Number.NaN;
    }
    // Strike first so this frame's downward motion cannot also become a gust.
    this.stepStrike('left', this.palmLeft, dt, false);
    this.stepStrike('right', this.palmRight, dt, false);
    this.stepSweep('left', this.palmLeft, dt, false);
    this.stepSweep('right', this.palmRight, dt, false);
  }

  /**
   * Head motion baseline for the gesture channels: walking must not count as
   * waving or striking. Leaf-node getWorldPosition refreshes the chain on
   * the way up.
   */
  private trackHead(): void {
    this.world.player.head.getWorldPosition(this.headNow);
    if (!this.headSeen) {
      this.headDelta.set(0, 0, 0);
      this.headSeen = true;
    } else {
      this.headDelta.copy(this.headNow).sub(this.headPrev);
    }
    this.headPrev.copy(this.headNow);
  }

  /**
   * Clap detection: hysteresis re-arm, damped closing speed, then the
   * close+fast trigger. Split out so the sweep channel always runs after it
   * and can see this frame's closing speed.
   */
  private stepClap(distance: number, dt: number): void {
    // Hysteresis: after a fire, wait for a real separation before listening
    // again, independent of the time cooldown.
    if (!this.armed) {
      if (distance > CLAP_REARM_DISTANCE_M) {
        this.armed = true;
        this.lastDistance = distance;
      }
      return;
    }

    if (!Number.isFinite(this.lastDistance)) {
      this.lastDistance = distance;
      return;
    }

    // Closing speed, damped: single-frame derivatives of noisy joints
    // spike; the EMA keeps a real strike well above the threshold while
    // jitter stays below it.
    const rawSpeed = (this.lastDistance - distance) / dt;
    this.closingSpeed = Number.isFinite(this.closingSpeed)
      ? this.closingSpeed + (rawSpeed - this.closingSpeed) * CLAP_SPEED_EMA
      : rawSpeed;
    this.lastDistance = distance;

    if (
      this.cooldown <= 0 &&
      distance <= CLAP_TRIGGER_DISTANCE_M &&
      this.closingSpeed >= CLAP_MIN_CLOSING_SPEED_M_S
    ) {
      this.fireClap('clap');
    }
  }

  /** Full tracking loss also invalidates the head-motion baseline. */
  private reset(): void {
    this.resetHand('left');
    this.resetHand('right');
    this.headSeen = false;
  }

  private resetHand(hand: Handedness): void {
    this.lastDistance = Number.NaN;
    this.closingSpeed = Number.NaN;
    this.armed = true;
    this.palmSeen[hand] = false;
    this.strikeSeen[hand] = false;
    this.sweepSpeed[hand] = 0;
    this.sweepVel[hand].x = 0;
    this.sweepVel[hand].z = 0;
    this.downSpeed[hand] = 0;
  }

  /**
   * One hand's sweep channel: smoothed horizontal velocity against the gust
   * thresholds, measured in HEAD-LOCAL space (the head's own displacement is
   * subtracted), so walking through the room with still hands can never fire
   * a gust. Fires only while the sandbox is on and never during a clap (fast
   * convergence belongs to the clap detector) or within a short window after
   * one, so a single motion can only mean one thing. The sweep direction —
   * not the forecast — is stored with the gust, so calm weather still bends.
   */
  private stepSweep(hand: Handedness, palm: Vector3, dt: number, solo: boolean): void {
    const previous = this.lastPalm[hand];
    if (!this.palmSeen[hand]) {
      previous.copy(palm);
      this.palmSeen[hand] = true;
      return;
    }
    // The head delta is subtracted from every hand: a wave is relative motion.
    const dx = palm.x - previous.x - this.headDelta.x;
    const dz = palm.z - previous.z - this.headDelta.z;
    previous.copy(palm);
    const rawSpeed = Math.hypot(dx, dz) / dt;
    this.sweepSpeed[hand] += (rawSpeed - this.sweepSpeed[hand]) * CLAP_SPEED_EMA;
    // Smoothed velocity (not just speed): the EMA of the per-frame velocity
    // is what points along the wave at acceptance time.
    this.sweepVel[hand].x += (dx / dt - this.sweepVel[hand].x) * CLAP_SPEED_EMA;
    this.sweepVel[hand].z += (dz / dt - this.sweepVel[hand].z) * CLAP_SPEED_EMA;
    if (!weatherStore.state.peek().sandbox) return;
    if (this.gustCooldown[hand] > 0) return;
    // A clap (or its recoil) is fast convergence: leave it to the clap path.
    if (this.sinceClap < 0.35) return;
    if (!solo) {
      if (Number.isFinite(this.closingSpeed) && this.closingSpeed >= CLAP_MIN_CLOSING_SPEED_M_S) return;
    }
    // A downward thunder strike is not a gust either.
    if (this.downSpeed[hand] >= STRIKE_MIN_DOWN_SPEED_M_S) return;
    const speed = this.sweepSpeed[hand];
    if (speed < SANDBOX_GUST_MIN_SPEED_M_S) return;
    const strength = Math.min(1, speed / SANDBOX_GUST_FULL_SPEED_M_S);
    const dirLen = Math.hypot(this.sweepVel[hand].x, this.sweepVel[hand].z);
    const dirX = dirLen > 1e-6 ? this.sweepVel[hand].x / dirLen : 0;
    const dirZ = dirLen > 1e-6 ? this.sweepVel[hand].z / dirLen : -1;
    if (!triggerSandboxGust(strength, dirX, dirZ)) return;
    sandboxGustSetOrigin(palm.x, palm.z);
    this.gustCooldown[hand] = SANDBOX_GUST_COOLDOWN_S;
    // The caller owns the event; the whoosh/haptic are the Gust listener's.
    const detail: GustDetail = { strength, dirX, dirZ, source: `sweep-${hand}` };
    weatherEvents.emit(WeatherEvent.Gust, detail);
  }

  /**
   * Downward thunder strike: one hand driving down fast (head-relative, so
   * crouching doesn't fire it) while the palms stay well apart. The
   * controller-safe thunder path — a single grip slam, never two controllers
   * brought together. Sandbox-gated via `trySandboxThunder`.
   */
  private stepStrike(hand: Handedness, palm: Vector3, dt: number, solo: boolean): void {
    const previous = this.sweepPrev[hand];
    if (!this.strikeSeen[hand]) {
      previous.copy(palm);
      this.strikeSeen[hand] = true;
      return;
    }
    const dyDown = -(palm.y - previous.y - this.headDelta.y);
    previous.copy(palm);
    const raw = dyDown / dt;
    this.downSpeed[hand] += (raw - this.downSpeed[hand]) * CLAP_SPEED_EMA;
    if (!weatherStore.state.peek().sandbox) return;
    if (this.strikeCooldown > 0 || this.cooldown > 0) return;
    if (this.sinceClap < 0.35) return;
    if (!solo) {
      // Palms together (or converging fast) means clap, not strike.
      if (this.lastDistance <= CLAP_REARM_DISTANCE_M) return;
      if (Number.isFinite(this.closingSpeed) && this.closingSpeed >= CLAP_MIN_CLOSING_SPEED_M_S) return;
    }
    if (this.downSpeed[hand] < STRIKE_MIN_DOWN_SPEED_M_S) return;
    this.strikeCooldown = STRIKE_COOLDOWN_S;
    this.cooldown = CLAP_COOLDOWN_S;
    this.armed = false;
    this.sinceClap = 0;
    this.clapPoint.copy(palm);
    this.impulse?.trigger(this.clapPoint);
    playClapCue();
    pulseHaptics(this.world, Haptics.thunder.intensity, Haptics.thunder.durationMs);
    trySandboxThunder(`strike-${hand}`);
  }


  private fireClap(source: string): void {
    this.cooldown = CLAP_COOLDOWN_S;
    this.armed = false;
    this.sinceClap = 0;
    this.lastDistance = Number.NaN;
    this.closingSpeed = Number.NaN;
    // Outside the sandbox the clap is detected but deliberately ignored:
    // thunder keeps coming only from storm hours (WMO >= 95).
    if (!weatherStore.state.peek().sandbox) return;
    this.clapPoint.copy(this.palmLeft).add(this.palmRight).multiplyScalar(0.5);
    this.impulse?.trigger(this.clapPoint);
    // Audio confirmation is mandatory for hand input (no actuators): the
    // low sweep lands instantly, the Thunder rumble builds under it.
    playClapCue();
    pulseHaptics(this.world, Haptics.thunder.intensity, Haptics.thunder.durationMs);
    // The single shared moment: audio rumble + room discharge + light lift.
    const detail: ThunderDetail = { source };
    weatherEvents.emit(WeatherEvent.Thunder, detail);
  }
}
