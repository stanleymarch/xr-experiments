/**
 * Placement and move-affordance helpers shared by the WEATHER//ROOM spatial
 * panel and the timeline rail.
 *
 * Horizon OS window pattern implemented in-application (WebXR has no system
 * chrome, so the app must draw the handles the platform would):
 *
 * - a modest 38% baseline Control Bar pill sits below the window at rest for
 *   discoverability (F1), strengthening into the platform state colors
 *   (#FFFFFF hover, #001E78 select) over the platform transition times
 *   (0.3 s hover in/out, 0.08 s press, 0.1 s release). No edge handles: the
 *   native windows the owner compared against show only the bar;
 * - the grab target is larger than the visible bar (>= 55 mm, ~3.1 deg at
 *   1 m; the ray target additionally grows outward past 1 m so it keeps at
 *   least a 3 deg cross-section out to 3 m) while the drawn bar stays thin;
 * - SDK grabs drive translation only; orientation and scale stay fixed during
 *   carry, without a second transform controller fighting the grab handle;
 * - haptics go to the holding hand only and every grip moment also carries an
 *   audio cue, because hand tracking has no actuators.
 */

import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  Grabbed,
  Hovered,
  Group,
  GrabSystem,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from '@iwsdk/core';
import type { Entity, Object3D, World } from '@iwsdk/core';
import { bevelBox } from '../scene-assets/lib/hardsurface.js';
import { Haptics } from './feedback.js';
import { connectAudio } from './audio-stub.js';
import type { HapticPulse } from './feedback.js';

export type Handedness = 'left' | 'right';

const headPosition = new Vector3();
const headRotation = new Quaternion();
const forward = new Vector3();

/** Place once from the tracked viewer; never attach controls to the head. */
export function placeControlAtViewer(object: Object3D, world: World, distance: number, heightOffset: number): void {
  world.player.head.getWorldPosition(headPosition);
  world.player.head.getWorldQuaternion(headRotation);
  forward.set(0, 0, -1).applyQuaternion(headRotation);
  forward.y = 0;
  if (forward.lengthSq() < 0.001) forward.set(0, 0, -1);
  else forward.normalize();
  object.position.copy(headPosition).addScaledVector(forward, distance);
  object.position.y += heightOffset;
  object.rotation.set(0, Math.atan2(-forward.x, -forward.z), 0);
  object.updateMatrixWorld(true);
}

const facePosition = new Vector3();
/* ------------------------------------------------------------------ *
 * Move affordance (Control Bar + edge handles)
 * ------------------------------------------------------------------ */

/**
 * Visible bar thickness: the platform's 48 dp minimum at panel scale
 * (22 mm / 0.458 mm per dp), still thinner than the 55 mm grab target.
 */
const VISUAL_T_M = 0.022;
/** Grab target cross-section: ~3.1 deg at 1 m (>= 48 dp at panel scale). */
const TARGET_T_M = 0.055;
const DEPTH_M = 0.014;
/** Gap between the control surface edge and the handle band. */
const GAP_M = 0.004;
/** Control Bar drop below the bottom handle band. */
const PILL_GAP_M = 0.02;
/** Upper bound when the ray target grows to hold its angular size. */
const RAY_TARGET_MAX_M = 0.16;
/** Half-angle of the required 3 deg minimum ray/direct target cross-section. */
const RAY_TARGET_HALF_TAN = Math.tan((1.5 * Math.PI) / 180);

const spreadScale = new Vector3();

/** The drawn Control Bar; its ray shell is grown outward on Y. */
interface BarPart {
  readonly mesh: Mesh;
  readonly outward: 1 | -1;
  readonly baseCenter: number;
}

/**
 * The drawn + grabbable affordance around one control: the Control Bar pill.
 * `near` (squeeze/pinch) and `far` (ray) are separate roots because the SDK
 * installs one grab handle per entity; both are invisible collision shells, and
 * the thin visible bar is decorative and never raycasts.
 */
export interface Affordance {
  readonly group: Group;
  /** The thin visible Control Bar (shared state material). */
  readonly visual: Group;
  readonly material: MeshStandardMaterial;
  readonly near: Group;
  readonly far: Group;
  /** Frame roots, for hover probing. */
  readonly targets: readonly Object3D[];
  /** Resize the ray target cross-section so it keeps its angular size. */
  setRaySpread(distanceM: number): void;
  dispose(): void;
}

export interface AffordanceSpec {
  readonly name: string;
  /** Control surface height in meters (at rest scale): the bar hangs below it. */
  readonly heightM: number;
  /** Control Bar width; a longer bar stays ray-reachable at greater distance. */
  readonly pillWidthM?: number;
}

/**
 * Build the move affordance: one modest Control Bar pill below the surface
 * with a 38% baseline at rest (F1 discoverability). The visible bar is
 * thinner than its grab target, and the ray target can grow outward without
 * covering the surface, so nothing is drawn over the control itself.
 */
export function buildAffordance(spec: AffordanceSpec): Affordance {
  const pillWidth = spec.pillWidthM ?? 0.12;
  const halfH = spec.heightM / 2;

  // F1 baseline: a modest 38% bar at rest for discoverability; the driver
  // strengthens it into the platform hover/select states. depthWrite stays
  // on so the plaque orders by depth against the panel UI and the rail
  // instead of riding the transparent sort.
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveIntensity: HOVER_GLOW,
    metalness: 0.1,
    roughness: 0.35,
    transparent: true,
    opacity: BASELINE_OPACITY,
    depthWrite: true,
  });
  const shellMaterial = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });

  const group = new Group();
  group.name = spec.name;
  const visual = new Group();
  visual.name = `${spec.name} Visual`;
  visual.visible = true;
  const near = new Group();
  near.name = `${spec.name} Near`;
  const far = new Group();
  far.name = `${spec.name} Far`;
  group.add(visual, near, far);

  const geometries: BufferGeometry[] = [];
  const farParts: BarPart[] = [];

  /** One horizontal bar: the visible plaque and its two collision shells. */
  const addBar = (longLength: number, centerY: number): void => {
    const shellGeometry = bevelBox(longLength, TARGET_T_M, DEPTH_M, Math.min(TARGET_T_M, DEPTH_M) * 0.4);
    geometries.push(shellGeometry);

    const bar = new Mesh(bevelBox(
      longLength,
      VISUAL_T_M,
      DEPTH_M,
      Math.min(VISUAL_T_M, DEPTH_M) * 0.45,
    ), material);
    geometries.push(bar.geometry);
    bar.position.set(0, centerY, 0);
    // Decorative only: never let a raycast hit the drawn bar instead of the
    // slightly larger shell that owns the pointer semantics.
    bar.raycast = () => {};
    visual.add(bar);

    const nearShell = new Mesh(shellGeometry, shellMaterial);
    nearShell.position.set(0, centerY, 0);
    near.add(nearShell);

    const farShell = new Mesh(shellGeometry, shellMaterial);
    farShell.position.set(0, centerY, 0);
    far.add(farShell);
    farParts.push({ mesh: farShell, outward: -1, baseCenter: centerY });
  };

  // Control Bar: centered below the surface, clear of every control row.
  addBar(pillWidth, -(halfH + GAP_M + PILL_GAP_M + TARGET_T_M / 2));

  const setRaySpread = (distanceM: number): void => {
    group.getWorldScale(spreadScale);
    const k = Math.max(1e-3, spreadScale.y);
    // Required world cross-section for a >= 3 deg target, expressed in the
    // affordance's local units so a scaled (angular-size-kept) control needs
    // no extra growth of its own.
    const requiredLocal = Math.max(0, (2 * RAY_TARGET_HALF_TAN * distanceM) / k);
    const ratio = Math.min(RAY_TARGET_MAX_M / TARGET_T_M, Math.max(1, requiredLocal / TARGET_T_M));
    const grow = (ratio - 1) * TARGET_T_M;
    for (const part of farParts) {
      part.mesh.position.y = part.baseCenter + (part.outward * grow) / 2;
      part.mesh.scale.set(1, ratio, 1);
    }
  };

  return {
    group,
    visual,
    material,
    near,
    far,
    targets: [near, far],
    setRaySpread,
    dispose(): void {
      for (const geometry of geometries) geometry.dispose();
      material.dispose();
      shellMaterial.dispose();
      group.removeFromParent();
    },
  };
}


/**
 * Pulse one hand's actuators only (Horizon haptics rule: never buzz the idle
 * hand). Safe on hands-only input, flat desktop, and without a session.
 */
export function pulseHandHaptics(world: World, hand: Handedness | null, pulse: HapticPulse): void {
  if (hand == null) return;
  try {
    if (!Number.isFinite(pulse.intensity) || !Number.isFinite(pulse.durationMs)) return;
    const getSession = (world as { renderer?: { xr?: { getSession?: () => unknown } } }).renderer?.xr
      ?.getSession;
    if (typeof getSession !== 'function') return;
    const session = getSession() as { inputSources?: unknown } | null | undefined;
    const sources = session?.inputSources as
      | Iterable<{ handedness?: string; gamepad?: { hapticActuators?: unknown } | null } | null>
      | null
      | undefined;
    if (sources == null || typeof sources[Symbol.iterator] !== 'function') return;
    for (const source of sources) {
      if (source?.handedness !== hand) continue;
      const actuators = source?.gamepad?.hapticActuators as
        | Iterable<{ pulse?: (intensity: number, durationMs: number) => unknown } | null>
        | null
        | undefined;
      if (actuators == null || typeof actuators[Symbol.iterator] !== 'function') continue;
      for (const actuator of actuators) {
        try {
          void Promise.resolve(actuator?.pulse?.(pulse.intensity, pulse.durationMs)).catch(() => undefined);
        } catch {
          // One bad actuator must not block the rest.
        }
      }
    }
  } catch {
    // Haptics are best-effort: never break the interaction path.
  }
}

/* ------------------------------------------------------------------ *
 * Grip audio (hand tracking has no actuators)
 * ------------------------------------------------------------------ */

let gripAudio: AudioContext | null = null;

function ensureGripAudio(): AudioContext | null {
  if (gripAudio != null) return gripAudio;
  if (typeof window === 'undefined' || typeof AudioContext === 'undefined') return null;
  try {
    gripAudio = new AudioContext();
    // Same unlock path as the weather audio: a page gesture resumes the
    // context, so the first grip cue is audible after a click or XR entry.
    window.addEventListener('pointerdown', unlockGripAudio, { passive: true });
  } catch {
    gripAudio = null;
  }
  return gripAudio;
}

/** Resume the grip cue context; call on a user gesture and on XR entry. */
export function unlockGripAudio(): void {
  const ctx = ensureGripAudio();
  if (ctx != null && ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
}

/** One short sine envelope; ~2 % of the weather master's loudest bed. */
function cue(frequencyHz: number, gain: number, seconds: number): void {
  const ctx = ensureGripAudio();
  if (ctx == null) return;
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  if (ctx.state !== 'running') return;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = frequencyHz;
  const env = ctx.createGain();
  const now = ctx.currentTime;
  env.gain.setValueAtTime(0, now);
  env.gain.linearRampToValueAtTime(gain, now + 0.006);
  env.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
  connectAudio(osc, env, ctx.destination);
  osc.start(now);
  osc.stop(now + seconds + 0.05);
}

/* ------------------------------------------------------------------ *
 * Gesture audio vocabulary (hand gestures have no actuators)
 * ------------------------------------------------------------------ */

/**
 * Shared short noise buffer for gesture cues (clap confirm, push whoosh).
 * Built once on the grip cue context; `null` while audio is unavailable.
 */
let gestureNoise: { ctx: AudioContext; buffer: AudioBuffer } | null = null;

function ensureGestureNoise(): { ctx: AudioContext; buffer: AudioBuffer } | null {
  const ctx = ensureGripAudio();
  if (ctx == null) return null;
  if (gestureNoise?.ctx === ctx) return gestureNoise;
  try {
    const seconds = 0.5;
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    gestureNoise = { ctx, buffer };
  } catch {
    gestureNoise = null;
  }
  return gestureNoise;
}

/**
 * One filtered noise burst on the grip cue context: `lowpass` slides from
 * `startHz` to `endHz` across `seconds`. Same quiet register as the grip
 * cues (~2-6 % of the weather master's loudest bed) so gesture feedback
 * never competes with the weather audio.
 */
function noiseCue(startHz: number, endHz: number, gain: number, seconds: number): void {
  const noise = ensureGestureNoise();
  if (noise == null) return;
  const { ctx, buffer } = noise;
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  if (ctx.state !== 'running') return;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  const t = ctx.currentTime;
  lowpass.frequency.setValueAtTime(Math.max(40, startHz), t);
  lowpass.frequency.exponentialRampToValueAtTime(Math.max(40, endHz), t + seconds);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(gain, t + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
  connectAudio(source, lowpass, env, ctx.destination);
  source.start(t);
  source.stop(t + seconds + 0.05);
}

/**
 * Clap acknowledgment: a short low sweep immediately before the Thunder
 * rumble builds. Hands have no haptics, so this cue is the mandatory
 * "the system heard your clap" answer; the storm itself is the rumble that
 * WeatherAudioSystem plays on WeatherEvent.Thunder.
 */
export function playClapCue(): void {
  noiseCue(320, 120, 0.05, 0.22);
}

/**
 * Sandbox mode flip: a soft rising sweep on entry, a settle tone on exit,
 * mirroring grab/release cues so the toggle answers in the same voice.
 */
export function playSandboxCue(on: boolean): void {
  if (on) noiseCue(180, 640, 0.045, 0.3);
  else cue(430, 0.03, 0.05);
}

/**
 * Hand-push "whoosh": a noise whistle whose brightness and level track the
 * pushing hand's speed (0..1). Called by the push interaction with the
 * smoothed hand speed; silent no-op outside a running audio context.
 */
export function playPushWhoosh(speed01: number): void {
  const s = Math.min(1, Math.max(0, speed01));
  if (s <= 0.05) return;
  noiseCue(300 + s * 1100, 1200 + s * 900, 0.012 + s * 0.045, 0.14 + s * 0.12);
}

/* ------------------------------------------------------------------ *
 * Contact impulse: the paired visual for every gesture cue
 * ------------------------------------------------------------------ */

/** Impulse envelope: full-bright spawn, quick expand, ~0.3 s fade. */
const IMPULSE_SECONDS = 0.3;
const IMPULSE_START_SCALE = 0.6;
const IMPULSE_END_SCALE = 2.4;

/**
 * One transient additive flash for a gesture contact point (clap midpoint,
 * pinch detent, poke site). Every gesture audio cue gets one of these as
 * its paired visual, per the Meta hands guideline: no haptics exists, so
 * sound + light carry the confirmation. One mesh per site, reused; never
 * raycastable; drawn over everything (depthTest off) for its brief life
 * so a flash between two palms is not eaten by the hand occluder's depth.
 */
export class ContactImpulse {
  private readonly mesh: Mesh;
  private readonly entity: Entity;
  private readonly material: MeshBasicMaterial;
  private t = Number.POSITIVE_INFINITY;

  constructor(world: World, colorHex: number, name: string) {
    this.material = new MeshBasicMaterial({
      color: colorHex,
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new Mesh(new SphereGeometry(0.012, 10, 8), this.material);
    this.mesh.name = name;
    this.mesh.visible = false;
    this.mesh.raycast = () => {};
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 90;
    this.entity = world.createTransformEntity(this.mesh);
  }

  /** Fire the impulse at a world position; restarts if already running. */
  trigger(position: Vector3): void {
    this.mesh.position.copy(position);
    this.t = 0;
    this.mesh.visible = true;
  }

  update(delta: number): void {
    if (this.t > IMPULSE_SECONDS) return;
    const dt = Number.isFinite(delta) ? Math.min(Math.max(delta, 0), 0.1) : 0.016;
    this.t += dt;
    const progress = Math.min(1, this.t / IMPULSE_SECONDS);
    const eased = 1 - (1 - progress) * (1 - progress);
    const scale = IMPULSE_START_SCALE + (IMPULSE_END_SCALE - IMPULSE_START_SCALE) * eased;
    this.mesh.scale.setScalar(scale);
    this.material.opacity = 0.9 * (1 - progress) ** 2;
    if (progress >= 1) {
      this.mesh.visible = false;
      this.t = Number.POSITIVE_INFINITY;
    }
  }

  dispose(): void {
    this.entity.dispose({ disposeResources: false });
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/* ------------------------------------------------------------------ *
 * Grip driver
 * ------------------------------------------------------------------ */

/**
 * Per-grip follow state for a dedicated whole-control move affordance.
 *
 * A move affordance is a small dedicated root (NOT the panel buttons, NOT the
 * timeline scrub knob) whose grab motion drives its parent object. The grabbed
 * root is pinned back to `restPosition`/`restQuaternion` after every step, so
 * the whole control visibly follows the hand while the affordance never drifts.
 */
export interface GripFollowState {
  readonly restPosition: Vector3;
  readonly restQuaternion: Quaternion;
  readonly previousWorld: Vector3;
}

/** Fresh follow state; call `captureGripRest` once the affordance is seated. */
export function createGripFollowState(): GripFollowState {
  return {
    restPosition: new Vector3(),
    restQuaternion: new Quaternion(),
    previousWorld: new Vector3(),
  };
}

/**
 * Capture the affordance's seated local transform plus its current world
 * position (the per-grab motion baseline). Call once after seating, then
 * re-baseline `previousWorld` on every grab start.
 */
export function captureGripRest(affordance: Object3D, state: GripFollowState): void {
  state.restPosition.copy(affordance.position);
  state.restQuaternion.copy(affordance.quaternion);
  affordance.getWorldPosition(state.previousWorld);
}

const followCurrent = new Vector3();
const followDelta = new Vector3();
const followRootPosition = new Vector3();

function translateWorld(object: Object3D, delta: Vector3): void {
  object.getWorldPosition(followRootPosition).add(delta);
  object.parent?.worldToLocal(followRootPosition);
  object.position.copy(followRootPosition);
  object.updateMatrixWorld(true);
}

/**
 * Transfer a grabbed handle's world-space translation to its control, then
 * restore the handle's local rest pose. No rotation/scale correction runs
 * alongside the SDK grab. Released transforms remain where they were left.
 */
export function stepGripFollow(
  root: Object3D,
  grabbed: Object3D,
  state: GripFollowState,
): void {
  grabbed.getWorldPosition(followCurrent);
  followDelta.copy(followCurrent).sub(state.previousWorld);
  translateWorld(root, followDelta);
  grabbed.position.copy(state.restPosition);
  grabbed.quaternion.copy(state.restQuaternion);
  grabbed.getWorldPosition(state.previousWorld);
}

/** Platform state transitions: hover 0.3 s, press 0.08 s, release 0.1 s. */
const HOVER_SECONDS = 0.3;
const PRESS_SECONDS = 0.08;
const RELEASE_SECONDS = 0.1;

const HOVER_COLOR = 0xffffff;
const SELECT_COLOR = 0x001e78;
const HOVER_GLOW = 0.35;
const SELECT_GLOW = 0.6;

interface AffordanceStyle {
  readonly opacity: number;
  readonly color: number;
  readonly glow: number;
}
const BASELINE_OPACITY = 0.38;
const BASELINE_STYLE: AffordanceStyle = { opacity: BASELINE_OPACITY, color: HOVER_COLOR, glow: HOVER_GLOW };
const HOVER_STYLE: AffordanceStyle = { opacity: 1, color: HOVER_COLOR, glow: HOVER_GLOW };
const SELECT_STYLE: AffordanceStyle = { opacity: 1, color: SELECT_COLOR, glow: SELECT_GLOW };

/**
 * Drives one move affordance: while either shell is held, `root` follows the
 * active shell 1:1 and the shell is pinned to its rest local transform; on
 * release both shells are pinned and the root stays exactly where the hand left
 * it (anywhere, including behind the viewer). At rest a modest 38% baseline
 * bar stays visible; hover/select drive the platform colors, a
 * holding-hand-only haptic, and an audio cue. Emits no weather events: the
 * knob/snap haptic and audio bus stays untouched.
 */
export interface GripDriver {
  update(root: Object3D, delta: number): void;
  /**
   * True exactly once after a grab ends, so the owner can re-seat visuals
   * that follow a re-oriented root.
   */
  consumeReleased(): boolean;
}


export function createGripDriver(
  world: World,
  nearEntity: Entity,
  farEntity: Entity,
  affordance: Affordance,
): GripDriver {
  const grabSystem = world.getSystem(GrabSystem) ?? null;
  const follow = createGripFollowState();
  captureGripRest(affordance.near, follow);
  const hoverEnterS = 0.05;
  const hoverExitS = 0.12;

  let active: Object3D | null = null;
  let activeEntity: Entity | null = null;
  let heldHand: Handedness | null = null;
  let released = false;
  let hovered = false;
  let hoverEnterT = 0;
  let hoverExitT = 0;
  let state: 'rest' | 'hover' | 'select' = 'rest';

  const colorFrom = new Color(HOVER_COLOR);
  const colorTo = new Color(HOVER_COLOR);
  const colorNow = new Color(HOVER_COLOR);
  let opacityFrom = BASELINE_OPACITY;
  let opacityTo = BASELINE_OPACITY;
  let opacityNow = BASELINE_OPACITY;
  let glowFrom = HOVER_GLOW;
  let glowTo = HOVER_GLOW;
  let glowNow = HOVER_GLOW;
  let tweenT = 1;
  let tweenDuration = 0;

  const frameTargets = affordance.targets;

  const applyState = (next: 'rest' | 'hover' | 'select'): void => {
    const style = next === 'select' ? SELECT_STYLE : next === 'hover' ? HOVER_STYLE : BASELINE_STYLE;
    const duration =
      next === 'select' ? PRESS_SECONDS : next === 'hover' && state === 'select' ? RELEASE_SECONDS : HOVER_SECONDS;
    if (next === state) return;
    colorFrom.copy(colorNow);
    colorTo.setHex(style.color);
    opacityFrom = opacityNow;
    opacityTo = style.opacity;
    glowFrom = glowNow;
    glowTo = style.glow;
    tweenDuration = duration;
    tweenT = 0;
    state = next;
  };

  return {
    consumeReleased(): boolean {
      const value = released;
      released = false;
      return value;
    },

    update(root: Object3D, delta: number): void {
      const dt = Number.isFinite(delta) ? Math.min(Math.max(delta, 0), 0.1) : 0.016;
      const held = nearEntity.hasComponent(Grabbed)
        ? affordance.near
        : farEntity.hasComponent(Grabbed)
          ? affordance.far
          : null;

      if (held !== active) {
        active = held;
        activeEntity = active === affordance.near ? nearEntity : active === affordance.far ? farEntity : null;
        if (active != null && activeEntity != null) {
          active.getWorldPosition(follow.previousWorld);
          heldHand = grabSystem?.getHolderHand(activeEntity) ?? null;
          // Grab answers with weight: one firm pulse in the holding hand only.
          pulseHandHaptics(world, heldHand, Haptics.grab);
          cue(520, 0.05, 0.035);
        } else {
          for (const shell of frameTargets) {
            shell.position.copy(follow.restPosition);
            shell.quaternion.copy(follow.restQuaternion);
          }
          // Release mirrors the grab, quieter, in the same hand.
          pulseHandHaptics(world, heldHand, Haptics.settle);
          cue(430, 0.03, 0.03);
          heldHand = null;
          released = true;
        }
      }
      // Keep release feedback attributed to the SDK's current holder.
      if (active != null && activeEntity != null) {
        const holder = grabSystem?.getHolderHand(activeEntity) ?? null;
        if (holder != null && holder !== heldHand) heldHand = holder;
      }

      if (active != null) {
        stepGripFollow(root, active, follow);
        // The panel affordance is scene-level; the rail affordance is a child.
        if (affordance.group.parent !== root) {
          translateWorld(affordance.group, followDelta);
          active.getWorldPosition(follow.previousWorld);
        }
      }

      // Use the SDK's public interaction tags, not private pointer bundles.
      const hasHover = nearEntity.hasComponent(Hovered) || farEntity.hasComponent(Hovered);
      if (hasHover) {
        hoverExitT = 0;
        if (!hovered) {
          hoverEnterT += dt;
          if (hoverEnterT >= hoverEnterS) {
            hovered = true;
            cue(1180, 0.018, 0.02);
          }
        }
      } else {
        hoverEnterT = 0;
        if (hovered) {
          hoverExitT += dt;
          if (hoverExitT >= hoverExitS) hovered = false;
        }
      }

      applyState(active != null ? 'select' : hovered ? 'hover' : 'rest');
      if (tweenT < tweenDuration) tweenT = Math.min(tweenDuration, tweenT + dt);
      const progress = tweenDuration > 0 ? Math.min(1, Math.max(0, tweenT / tweenDuration)) : 1;
      const f = progress * progress * (3 - 2 * progress);
      colorNow.lerpColors(colorFrom, colorTo, f);
      opacityNow = opacityFrom + (opacityTo - opacityFrom) * f;
      glowNow = glowFrom + (glowTo - glowFrom) * f;
      affordance.material.color.copy(colorNow);
      affordance.material.emissive.copy(colorNow);
      affordance.material.emissiveIntensity = glowNow;
      affordance.material.opacity = opacityNow;
      affordance.visual.visible = opacityNow > 0.01;

      // Keep the ray target's angular size while the control sits far away.
      world.player.head.getWorldPosition(headPosition);
      affordance.group.getWorldPosition(facePosition);
      affordance.setRaySpread(headPosition.distanceTo(facePosition));
    },
  };
}
