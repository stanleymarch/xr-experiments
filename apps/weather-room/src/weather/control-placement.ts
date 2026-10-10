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
 * - translation stays kinematic 1:1 (no spring, no inertia); the owner's
 *   `onHeld` hook re-orients the root toward the viewer (roll 0), preserves
 *   angular size when the control is carried along z, and pushes/pulls the
 *   control along the view ray from the holding hand's thumbstick;
 * - haptics go to the holding hand only and every grip moment also carries an
 *   audio cue, because hand tracking has no actuators.
 */

import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  Grabbed,
  Group,
  GrabSystem,
  InputComponent,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
  VisibilityState,
} from '@iwsdk/core';
import type { Entity, Object3D, World } from '@iwsdk/core';
import { bevelBox } from '../scene-assets/lib/hardsurface.js';
import { Haptics } from './feedback.js';
import type { HapticPulse } from './feedback.js';

export type Handedness = 'left' | 'right';

const HANDS: readonly Handedness[] = ['left', 'right'];

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

/* ------------------------------------------------------------------ *
 * Viewer-facing orientation and angular size
 * ------------------------------------------------------------------ */

const facePosition = new Vector3();
const faceDirection = new Vector3();
const upAxis = new Vector3(0, 1, 0);
const rightAxis = new Vector3(1, 0, 0);
const faceQuat = new Quaternion();
const pitchQuat = new Quaternion();

/**
 * Turn a control so it faces the viewer: yaw always tracks the view vector and
 * roll stays 0, so a text surface never tips sideways. Pitch is either measured
 * from the view vector (`'auto'`, the panel) or held at the authored tilt (a
 * number, the timeline rail, whose 16 deg up-tilt is part of its readability).
 * Only call while carrying: a released control keeps the pose where it landed.
 */
export function faceViewer(root: Object3D, head: Object3D, pitch: number | 'auto'): void {
  head.getWorldPosition(headPosition);
  root.getWorldPosition(facePosition);
  faceDirection.copy(headPosition).sub(facePosition);
  const distance = faceDirection.length();
  if (distance < 1e-4) return;
  faceDirection.divideScalar(distance);
  const yaw = Math.atan2(faceDirection.x, faceDirection.z);
  const pitchAngle =
    pitch === 'auto' ? -Math.asin(Math.max(-1, Math.min(1, faceDirection.y))) : pitch;
  // Ry(yaw) * Rx(pitch) with no Z term: yaw and pitch track the viewer, roll is
  // exactly 0 (Euler 'YXZ' in quaternion form, no Euler instance needed).
  faceQuat
    .setFromAxisAngle(upAxis, yaw)
    .multiply(pitchQuat.setFromAxisAngle(rightAxis, pitchAngle));
  root.quaternion.copy(faceQuat);
  root.updateMatrixWorld(true);
}

/** Relative angular-size preservation while carrying along z. */
export interface AngularSizeState {
  /** Head distance captured at grab start (the size reference). */
  baseDistance: number;
  /** Root scale captured at grab start. */
  baseScale: number;
  /** Current relative factor, eased toward the target. */
  current: number;
}

export function createAngularSizeState(): AngularSizeState {
  return { baseDistance: 1, baseScale: 1, current: 1 };
}

/** Seconds for the eased scale correction; short enough to feel immediate. */
const ANGULAR_SIZE_TAU_S = 0.12;
/** Carrying limits: never shrink below 0.6x or grow past 2x the grab pose. */
export const ANGULAR_SIZE_MIN = 0.6;
export const ANGULAR_SIZE_MAX = 2;

/**
 * Capture the grab-pose baseline. Sizes are preserved *relative to the grab
 * pose*, so grabbing never jumps the control and the clamp never fights a
 * previously released, deliberately resized control.
 */
export function baselineAngularSize(
  root: Object3D,
  head: Object3D,
  state: AngularSizeState,
  min = ANGULAR_SIZE_MIN,
  max = ANGULAR_SIZE_MAX,
): void {
  head.getWorldPosition(headPosition);
  root.getWorldPosition(facePosition);
  state.baseDistance = Math.max(0.2, headPosition.distanceTo(facePosition));
  state.baseScale = Math.max(1e-4, root.scale.x);
  state.current = Math.min(max, Math.max(min, 1));
}

/**
 * Keep the control's apparent size steady while it is carried toward or away
 * from the viewer: physical size grows with distance, easing toward
 * `distance / baseDistance` clamped to the grab-pose limits. The released
 * size stays where the hand left it (nothing re-centers), matching the
 * "released transforms persist" rule.
 */
export function stepAngularSize(
  root: Object3D,
  head: Object3D,
  state: AngularSizeState,
  delta: number,
  min = ANGULAR_SIZE_MIN,
  max = ANGULAR_SIZE_MAX,
): void {
  head.getWorldPosition(headPosition);
  root.getWorldPosition(facePosition);
  const distance = Math.max(0.2, headPosition.distanceTo(facePosition));
  const target = Math.min(max, Math.max(min, distance / state.baseDistance));
  const ease = 1 - Math.exp(-Math.max(0, delta) / ANGULAR_SIZE_TAU_S);
  state.current += (target - state.current) * ease;
  root.scale.setScalar(state.baseScale * state.current);
}

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

/* ------------------------------------------------------------------ *
 * Push / pull along the view ray (holding hand's thumbstick)
 * ------------------------------------------------------------------ */

/** Distance limits for the thumbstick push/pull, in meters. */
export const VIEW_DISTANCE_MIN_M = 0.4;
export const VIEW_DISTANCE_MAX_M = 3;
/** Top speed at full deflection; the curve below keeps small nudges gentle. */
const VIEW_PULL_MAX_SPEED_M_S = 1.1;
/** Deflection exponent: speed escalates smoothly from the stick position. */
const VIEW_PULL_GAMMA = 1.6;
/** Velocity lag so a deflection starts as a nudge, not a jump. */
const VIEW_PULL_TAU_S = 0.09;

/** Eased push/pull velocity for one held control. */
export interface ViewPullState {
  velocity: number;
}

export function createViewPullState(): ViewPullState {
  return { velocity: 0 };
}

const pullPosition = new Vector3();
const pullDirection = new Vector3();

/**
 * Native "pull it in / push it away" on the pad: while a control is held, the
 * holding hand's thumbstick moves it along the view ray (head to control), with
 * the speed easing in from the stick deflection and stopping dead at the
 * distance limits. A centered stick stops dead immediately, so ordinary
 * zero-stick carry stays exactly 1:1 and never drifts on residual velocity.
 * The caller's angular-size step then keeps the apparent size constant,
 * exactly as when carrying along z. Positive stick = closer.
 */
export function stepViewDistance(
  root: Object3D,
  head: Object3D,
  stickY: number,
  state: ViewPullState,
  delta: number,
  min = VIEW_DISTANCE_MIN_M,
  max = VIEW_DISTANCE_MAX_M,
): void {
  head.getWorldPosition(headPosition);
  root.getWorldPosition(pullPosition);
  pullDirection.copy(pullPosition).sub(headPosition);
  const distance = pullDirection.length();
  if (distance < 1e-4) return;
  pullDirection.divideScalar(distance);

  const deflection = Math.min(1, Math.abs(stickY));
  // Centered stick stops dead: ordinary zero-stick carry stays exactly 1:1
  // and never drifts on residual velocity.
  if (deflection === 0) {
    state.velocity = 0;
    return;
  }
  const target = Math.sign(stickY) * VIEW_PULL_MAX_SPEED_M_S * Math.pow(deflection, VIEW_PULL_GAMMA);
  const ease = 1 - Math.exp(-Math.max(0, delta) / VIEW_PULL_TAU_S);
  state.velocity += (target - state.velocity) * ease;
  if (Math.abs(state.velocity) < 1e-4) {
    state.velocity = 0;
    return;
  }

  const wanted = distance - state.velocity * delta;
  const next = Math.min(max, Math.max(min, wanted));
  // Hitting a limit stops the motion instead of grinding against it.
  if (next !== wanted) state.velocity = 0;
  if (next === distance) return;
  pullPosition.copy(headPosition).addScaledVector(pullDirection, next);
  root.parent?.worldToLocal(pullPosition);
  root.position.copy(pullPosition);
  root.updateMatrixWorld(true);
}

/** Thumbstick Y of one hand, or 0 when that hand has no stick. */
export function thumbstickY(world: World, hand: Handedness | null): number {
  if (hand == null) return 0;
  const axes = world.input.xr.gamepads[hand]?.getAxesValues(InputComponent.Thumbstick);
  const value = axes?.y;
  return Number.isFinite(value) ? (value as number) : 0;
}

/* ------------------------------------------------------------------ *
 * Window grab: squeeze anywhere on the surface (app-owned shortcut)
 * ------------------------------------------------------------------ */

interface RoutedRayPointer extends PointerLike {
  setIntersection?: (intersection: unknown) => unknown;
  commit?: (nativeEvent: { timeStamp: number }, stopPropagation?: boolean) => unknown;
}

interface RoutingMultiPointer {
  getPointer?: (kind: 'ray') => RoutedRayPointer | undefined;
  routeDown?: (kind: 'squeeze', target: 'ray', nativeEvent: { timeStamp: number }) => void;
  routeUp?: (kind: 'squeeze', target: 'ray', nativeEvent: { timeStamp: number }) => void;
}

/**
 * App-owned shortcut (not platform parity): pointing anywhere at the surface
 * and squeezing moves the window, while the trigger keeps clicking the UIKit
 * buttons. Meta's panel/window guidance moves panels by the edge or the
 * Control Bar below the panel, not by arbitrary content, so this squeeze-
 * anywhere behaviour is our own decision layered on top; the stock path
 * (Control Bar pill + trigger) keeps working with or without it.
 *
 * IWSDK routes the squeeze only to the near-grab pointer and the trigger only
 * to the ray pointer, so a distance grab on squeeze uses the routing the SDK
 * itself ships for hand pinches (GrabSystem pinch forwarding via
 * `routeDown('squeeze', ...)`), combined with the redirect GazePointer uses
 * before a synthetic press (`setIntersection` + `commit`). On the squeeze
 * edge, while that hand's ray is over the surface, the ray pointer's
 * intersection is pointed at the grab shell while keeping the real aim point
 * (so the cursor does not jump) and a squeeze down is routed to the ray
 * pointer; the shell's DistanceGrabHandle then starts the normal MoveAtSource
 * grab and the existing driver carries it. Nothing is added over the surface,
 * so ray and poke clicks on the buttons are untouched, and the near-grab pill
 * keeps its own squeeze path.
 *
 * Boundary honesty: `getPointer('ray')`, `setIntersection`, `commit`,
 * `routeDown`, and `routeUp` are NOT documented `MultiPointer` API — the
 * documented public surface is only `toggleSubPointer`, `getSubPointerState`,
 * `getActiveKind`, and `getRayBusy`. Every call here goes through the
 * structural casts above (verified against IWSDK 1.0.1) with optional
 * chaining, so if any of these methods disappears in a newer SDK the bridge
 * degrades to the stock path (Control Bar pill + trigger) instead of
 * breaking silently.
 */
export interface SurfaceGrab {
  update(): void;
}

export interface SurfaceGrabOptions {
  /** True while this hand already owns a grab elsewhere; promotion is then skipped. */
  readonly isHandBusy?: (hand: Handedness) => boolean;
}

export function createSurfaceGrab(
  world: World,
  /** Aiming anywhere inside this subtree counts as aiming at the window. */
  surface: readonly Object3D[],
  /** The DistanceGrabbable shell whose handle performs the move. */
  shell: Object3D,
  nearEntity: Entity,
  options?: SurfaceGrabOptions,
): SurfaceGrab {
  const routed: Record<Handedness, boolean> = { left: false, right: false };
  const grabTargets = [...surface, shell];
  return {
    update(): void {
      for (const hand of HANDS) {
        const pad = world.input.xr.gamepads[hand];
        const squeezeDown = pad?.getButtonDown(InputComponent.Squeeze) === true;
        const squeezeUp = pad?.getButtonUp(InputComponent.Squeeze) === true;
        // The squeeze-up edge never arrives when the controller disconnects,
        // the input mode changes, or the session ends mid-squeeze: release
        // the routed ray once instead of leaving the latch set, which would
        // swallow the next squeeze.
        if (routed[hand] && (world.visibilityState.peek() === VisibilityState.NonImmersive || pad == null)) {
          const multi = world.input.xr.multiPointers[hand] as unknown as RoutingMultiPointer;
          multi?.routeUp?.('squeeze', 'ray', { timeStamp: performance.now() });
          routed[hand] = false;
          continue;
        }
        if (!routed[hand] && !squeezeDown) continue;
        // Named boundary value: structural read of the SDK pointer bundle.
        const multi = world.input.xr.multiPointers[hand] as unknown as RoutingMultiPointer;
        const rayPointer = multi?.getPointer?.('ray');
        const hit = rayPointer?.getIntersection?.() ?? null;
        if (routed[hand]) {
          if (squeezeUp) {
            multi?.routeUp?.('squeeze', 'ray', { timeStamp: performance.now() });
            routed[hand] = false;
          }
          continue;
        }
        // Never steal an in-flight ray capture: a hand already holding the
        // trigger on another target (or a direct grab on this hand) keeps it.
        if (options?.isHandBusy?.(hand) === true) continue;
        if (
          squeezeDown &&
          hit != null &&
          intersectsAny(hit.object, grabTargets) &&
          !nearEntity.hasComponent(Grabbed)
        ) {
          const timeStamp = performance.now();
          // Redirect the ray's hit to the grab shell, keeping the real aim
          // point and pointer origin so the cursor and the grab anchor stay
          // where the user is actually pointing.
          rayPointer?.setIntersection?.({ ...hit, object: shell });
          rayPointer?.commit?.({ timeStamp }, false);
          multi?.routeDown?.('squeeze', 'ray', { timeStamp });
          routed[hand] = true;
        }
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * Per-pointer queries (hand-aware feedback)
 * ------------------------------------------------------------------ */

interface PointerLike {
  getIntersection?: () => { object?: Object3D } | null | undefined;
}

/** The SDK's private per-hand ray bundle, read only through `setRayDimmed`. */
interface RayBundleLike {
  ray?: { visual?: { rayDisplayMode?: number } };
}

function intersectsAny(hit: Object3D | undefined, targets: readonly Object3D[]): boolean {
  if (hit == null) return false;
  let node: Object3D | null = hit;
  while (node != null) {
    if (targets.includes(node)) return true;
    node = node.parent;
  }
  return false;
}

/**
 * Hands whose ray or near-grab pointer currently touches `targets`, appended to
 * `out` without allocating. The SDK exposes the live pointer intersection, so
 * this is the same test the cursor visual uses.
 */
export function collectHoverHands(
  world: World,
  targets: readonly Object3D[],
  out: Handedness[],
): Handedness[] {
  if (targets.length === 0) return out;
  for (const hand of HANDS) {
    if (out.includes(hand)) continue;
    const multi = world.input.xr.multiPointers[hand];
    // A missing pointer bundle degrades to "no hover", never a throw.
    const ray = (multi?.getPointer?.('ray') as unknown as PointerLike | undefined)?.getIntersection?.();
    const grab = (multi?.getPointer?.('grab') as unknown as PointerLike | undefined)?.getIntersection?.();
    if (intersectsAny(ray?.object, targets) || intersectsAny(grab?.object, targets)) out.push(hand);
  }
  return out;
}

/**
 * Fade the pointing laser of `hand` while it drags a control at distance: the
 * grabbed surface comes to the hand and a full-length beam would sit across it.
 * IWSDK 1.0.1 publishes no ray-visibility API, so this uses the one structural
 * read of the pointer's private display mode (packages/xr-input/src/pointer/
 * ray-pointer.ts `RayDisplayMode`: 2 = on-intersection, 3 = invisible). Any
 * shape change degrades to a silent no-op, and near-hand grabs already have
 * their ray hidden by the SDK itself.
 */
export function setRayDimmed(world: World, hand: Handedness | null, dimmed: boolean): void {
  if (hand == null) return;
  // Named boundary value: the only member read from the unchecked cast.
  const bundle = world.input.xr.multiPointers[hand] as unknown as RayBundleLike;
  const visual = bundle?.ray?.visual;
  if (visual == null || typeof visual.rayDisplayMode !== 'number') return;
  visual.rayDisplayMode = dimmed ? 3 : 2;
}

/** Hover transient: a short, sharp tap, never a continuous effect. */
const HOVER_HAPTIC: HapticPulse = { intensity: 0.12, durationMs: 8 };

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
  osc.connect(env).connect(ctx.destination);
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
  source.connect(lowpass).connect(env).connect(ctx.destination);
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
 * 1:1 move-follow for one held affordance: shift `root` (the weather panel or
 * the timeline rail) by the affordance's world delta since the last step, then
 * pin the grabbed root back to its rest local transform. No per-frame
 * allocation. Keep the SDK's unmodified world target as the motion baseline:
 * owner's push/pull, facing and scale adjustments are not hand motion and
 * must not be subtracted back out on the next handle update.
 *
 * The caller checks `Grabbed` and handles grab/release edges (haptics,
 * `previousWorld` re-baseline). Released transforms stay exactly where the
 * hand left them: nothing here springs back or re-centers.
 */
export function stepGripFollow(
  root: Object3D,
  grabbed: Object3D,
  state: GripFollowState,
  onHeld?: (root: Object3D) => void,
): void {
  grabbed.getWorldPosition(followCurrent);
  followDelta.copy(followCurrent).sub(state.previousWorld);
  translateWorld(root, followDelta);
  onHeld?.(root);
  grabbed.position.copy(state.restPosition);
  grabbed.quaternion.copy(state.restQuaternion);
  state.previousWorld.copy(followCurrent);
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

/** Optional per-driver behaviour. Translation is always applied. */
export interface GripDriverOptions {
  /**
   * Runs every frame while held, between the 1:1 translation and the pin.
   * The owner re-orients and rescales `root` here, pushes/pulls it along the
   * view ray from `hand`'s thumbstick, and re-seats a scene-level affordance
   * group, so the frame's motion baseline stays exact.
   */
  readonly onHeld?: (root: Object3D, delta: number, hand: Handedness | null) => void;
  /**
   * Append hands whose pointers hover the surface the affordance wraps (the
   * frame shells themselves are always probed). Fills `out` in place.
   */
  readonly probeHoverHands?: (out: Handedness[]) => void;
  readonly hoverEnterS?: number;
  readonly hoverExitS?: number;
}

export function createGripDriver(
  world: World,
  nearEntity: Entity,
  farEntity: Entity,
  affordance: Affordance,
  options?: GripDriverOptions,
): GripDriver {
  const grabSystem = world.getSystem(GrabSystem) ?? null;
  const follow = createGripFollowState();
  captureGripRest(affordance.near, follow);
  const hoverEnterS = options?.hoverEnterS ?? 0.05;
  const hoverExitS = options?.hoverExitS ?? 0.12;

  let active: Object3D | null = null;
  let activeEntity: Entity | null = null;
  let heldHand: Handedness | null = null;
  let dimmedHand: Handedness | null = null;
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

  // Reused scratch queues: hovering hands are the only allocation-sensitive
  // per-frame query here.
  const frameTargets = affordance.targets;
  const hoverHands: Handedness[] = [];

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
      // Same-shell handoff: while held, follow the current holder so carry
      // input, ray dimming, and the release haptic use the live hand.
      if (active != null && activeEntity != null) {
        const holder = grabSystem?.getHolderHand(activeEntity) ?? null;
        if (holder != null && holder !== heldHand) heldHand = holder;
      }

      if (active != null) {
        if (options?.onHeld != null) {
          stepGripFollow(root, active, follow, (moved) => options.onHeld?.(moved, dt, heldHand));
        } else {
          stepGripFollow(root, active, follow);
          // A scene-level affordance is translated with the control; a rail
          // child already moves with its parent.
          if (affordance.group.parent !== root) {
            translateWorld(affordance.group, followDelta);
            active.getWorldPosition(follow.previousWorld);
          }
        }
      }

      // Distance grab: the surface comes to the hand, so the pointing beam
      // would sit across it. Only the grabbing hand is dimmed.
      const wantDim: Handedness | null = active === affordance.far ? heldHand : null;
      if (wantDim !== dimmedHand) {
        setRayDimmed(world, dimmedHand, false);
        setRayDimmed(world, wantDim, true);
        dimmedHand = wantDim;
      }

      // Hover with hysteresis: a short enter dwell stops flicker while the ray
      // crosses the frame, a longer exit dwell stops it dropping out on jitter.
      hoverHands.length = 0;
      collectHoverHands(world, frameTargets, hoverHands);
      options?.probeHoverHands?.(hoverHands);
      if (hoverHands.length > 0) {
        hoverExitT = 0;
        if (!hovered) {
          hoverEnterT += dt;
          if (hoverEnterT >= hoverEnterS) {
            hovered = true;
            pulseHandHaptics(world, hoverHands[0] ?? null, HOVER_HAPTIC);
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
