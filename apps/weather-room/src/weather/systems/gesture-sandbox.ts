/**
 * WEATHER//ROOM clap sandbox: direct-hand gesture detector that turns a
 * deliberate clap into the room's thunder moment while the sandbox mode is
 * on. No new resources: palm anchors come from the framework hand model's
 * own joint nodes (`middle-finger-metacarpal`, falling back to `wrist`),
 * and controller sessions fall back to the grip spaces. The trigger emits
 * the existing `WeatherEvent.Thunder`, so the audio rumble
 * (WeatherAudioSystem) and the cloud flash (AtmosphereSystem) both answer
 * through branches that already existed — this module is the missing
 * emitter.
 *
 * Detection without false fires:
 * - distance: palm centers must close inside CLAP_TRIGGER_DISTANCE_M
 *   (10 cm). A real clap ends with palms 2–6 cm apart; tracked palm centers
 *   carry ~1 cm of jitter, so 10 cm tolerates tracking noise and palm-size
 *   variance while staying below any accidental near-touch.
 * - speed: the closing speed must exceed CLAP_MIN_CLOSING_SPEED_M_S
 *   (0.8 m/s). Casual gestures that happen to cross the body (reaching,
 *   scratching) close at ~0.3–0.5 m/s; a deliberate clap strikes at
 *   1–3+ m/s. The speed is an EMA over frames (α = 0.35) so single-frame
 *   jitter spikes cannot fire alone.
 * - cooldown: CLAP_COOLDOWN_S (2.0 s) matches the ~2 s forced-thunder
 *   window — each clap owns one full rumble, and the recoil/re-approach of
 *   the same clap can never double-fire. Still allows a clap every 2 s of
 *   continuous play.
 * - hysteresis: after a fire (or a cooldown expiry inside the zone) the
 *   palms must separate past CLAP_REARM_DISTANCE_M (18 cm) before the
 *   detector re-arms, so oscillating hands near the trigger radius cannot
 *   rattle the thunder.
 *
 * Feedback follows the Meta hands guideline — hands have no haptics:
 * every accepted clap gets the clap cue (low sweep) + a contact impulse at
 * the palm midpoint (control-placement vocabulary), the thunder rumble and
 * cloud flash ride the shared Thunder event, and controller sessions also
 * get the deep `Haptics.thunder` pulse.
 *
 * Tracking loss is handled by full state reset: if either palm anchor
 * disappears (tracking loss, input-mode switch, session end) the smoothed
 * speed and last distance are dropped, so a clap can only fire from a fresh
 * close+fast approach, never from a stale pose at re-acquisition.
 */

import { createSystem, Vector3 } from '@iwsdk/core';
import type { Object3D } from '@iwsdk/core';
import { WeatherEvent, weatherEvents, weatherStore } from '../weather-state.js';
import { Haptics, pulseHaptics } from '../feedback.js';
import { ContactImpulse, playClapCue, playPushWhoosh } from '../control-placement.js';
import { trackedInputKind } from '../capabilities.js';
import {
  SANDBOX_GUST_COOLDOWN_S,
  SANDBOX_GUST_FULL_SPEED_M_S,
  SANDBOX_GUST_MIN_SPEED_M_S,
  stepSandboxGust,
  triggerSandboxGust,
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
 * the forced-thunder window so one clap = one complete rumble (~2.2 s in
 * WeatherAudioSystem), with no overlapping audio.
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
/** Contact impulse color: warm lightning white. */
const CLAP_IMPULSE_COLOR = 0xfff3c4;

type Handedness = 'left' | 'right';

export class GestureSandboxSystem extends createSystem({}) {
  private readonly palmLeft = new Vector3();
  private readonly palmRight = new Vector3();
  private readonly clapPoint = new Vector3();
  /** Additive flash at the clap midpoint; created once, reused. */
  private impulse: ContactImpulse | null = null;
  /** Smoothed closing speed in m/s; NaN while disarmed. */
  private closingSpeed = Number.NaN;
  /** Last frame's palm-center distance; NaN while disarmed. */
  private lastDistance = Number.NaN;
  private cooldown = 0;
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
  /** Per-hand gust cooldown, seconds. */
  private readonly gustCooldown: Record<Handedness, number> = { left: 0, right: 0 };
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

    // Outside an immersive session there are no palm anchors at all; the
    // reset below also covers tracking loss for one or both hands.
    const left = this.palmAnchor('left');
    const right = this.palmAnchor('right');
    if (left == null || right == null) {
      this.reset();
      return;
    }

    // Leaf joint nodes: getWorldPosition refreshes the ancestor chain on
    // the way up, which is enough for a world-space read this frame.
    left.getWorldPosition(this.palmLeft);
    right.getWorldPosition(this.palmRight);
    const distance = this.palmLeft.distanceTo(this.palmRight);

    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);

    // Head motion baseline for the sweep channel: walking must not count as
    // waving. Leaf-node getWorldPosition refreshes the chain on the way up.
    this.world.player.head.getWorldPosition(this.headNow);
    if (!this.headSeen) {
      this.headDelta.set(0, 0, 0);
      this.headSeen = true;
    } else {
      this.headDelta.copy(this.headNow).sub(this.headPrev);
    }
    this.headPrev.copy(this.headNow);

    // Clap first: its fresh closing speed and timestamp are what tell the
    // sweep channel that this motion was a clap, not a wave.
    this.stepClap(distance, dt);
    // Sweep gusts ride the same anchors: a fast horizontal wave of one hand
    // whips up a gust while the sandbox is on.
    this.stepSweep('left', this.palmLeft, dt);
    this.stepSweep('right', this.palmRight, dt);
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
      this.fire();
    }
  }

  /** Reset on tracking loss: nothing may fire from a stale baseline. */
  private reset(): void {
    this.lastDistance = Number.NaN;
    this.closingSpeed = Number.NaN;
    this.armed = true;
    this.palmSeen.left = false;
    this.palmSeen.right = false;
    this.sweepSpeed.left = 0;
    this.sweepSpeed.right = 0;
    this.headSeen = false;
  }

  /**
   * One hand's sweep channel: smoothed horizontal speed against the gust
   * thresholds, measured in HEAD-LOCAL space (the head's own displacement is
   * subtracted), so walking through the room with still hands can never fire
   * a gust. Fires only while the sandbox is on and never during a clap (fast
   * convergence belongs to the clap detector) or within a short window after
   * one, so a single motion can only mean one thing.
   */
  private stepSweep(hand: Handedness, palm: Vector3, dt: number): void {
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
    const raw = Math.sqrt(dx * dx + dz * dz) / dt;
    this.sweepSpeed[hand] += (raw - this.sweepSpeed[hand]) * CLAP_SPEED_EMA;
    if (!weatherStore.state.peek().sandbox) return;
    if (this.gustCooldown[hand] > 0) return;
    // A clap (or its recoil) is fast convergence: leave it to the clap path.
    if (this.sinceClap < 0.35) return;
    if (Number.isFinite(this.closingSpeed) && this.closingSpeed >= CLAP_MIN_CLOSING_SPEED_M_S) return;
    const speed = this.sweepSpeed[hand];
    if (speed < SANDBOX_GUST_MIN_SPEED_M_S) return;
    const strength = Math.min(1, speed / SANDBOX_GUST_FULL_SPEED_M_S);
    if (!triggerSandboxGust(strength)) return;
    this.gustCooldown[hand] = SANDBOX_GUST_COOLDOWN_S;
    // The audible half: the same whoosh the push field uses, at gust gain.
    playPushWhoosh(Math.max(0.45, strength));
    pulseHaptics(this.world, Haptics.firmTap.intensity, Haptics.firmTap.durationMs);
  }

  private fire(): void {
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
    // The single shared moment: audio rumble + atmosphere cloud flash.
    weatherEvents.emit(WeatherEvent.Thunder, { source: 'clap' });
  }
}
