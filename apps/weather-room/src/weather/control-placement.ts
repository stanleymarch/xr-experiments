import { Grabbed, Group, Hovered, Mesh, MeshStandardMaterial, Quaternion, Vector3 } from '@iwsdk/core';
import type { Entity, Object3D, World } from '@iwsdk/core';
import { bevelBox } from '../scene-assets/lib/hardsurface.js';
import { Haptics, pulseHaptics } from './feedback.js';

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

/**
 * Per-grip follow state for a dedicated whole-object move grip.
 *
 * A move grip is a small dedicated mesh (NOT the panel buttons, NOT the
 * timeline scrub knob) whose grab motion drives its parent object. The grip
 * itself is pinned to `restPosition`/`restQuaternion` after every step, so
 * the whole object visibly follows the hand while the grip never drifts.
 */
export interface GripFollowState {
  readonly restPosition: Vector3;
  readonly restQuaternion: Quaternion;
  readonly previousWorld: Vector3;
}

/** Fresh follow state; call `captureGripRest` once the grip is seated. */
export function createGripFollowState(): GripFollowState {
  return {
    restPosition: new Vector3(),
    restQuaternion: new Quaternion(),
    previousWorld: new Vector3(),
  };
}

/**
 * Capture the grip's seated local transform plus its current world position
 * (the per-grab motion baseline). Call once after seating, then re-baseline
 * `previousWorld` on every grab start.
 */
export function captureGripRest(grip: Object3D, state: GripFollowState): void {
  state.restPosition.copy(grip.position);
  state.restQuaternion.copy(grip.quaternion);
  grip.getWorldPosition(state.previousWorld);
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
 * 1:1 move-follow for one held grip: shift `root` (the weather panel or the
 * timeline rail) by the grip's world delta since the last step, then pin
 * the grip back to its rest local transform. No per-frame allocation.
 *
 * The caller checks `Grabbed` and handles grab/release edges (haptics,
 * `previousWorld` re-baseline). Released transforms stay exactly where the
 * hand left them: nothing here springs back or re-centers.
 */
export function stepGripFollow(root: Object3D, grip: Object3D, state: GripFollowState): void {
  grip.getWorldPosition(followCurrent);
  followDelta.copy(followCurrent).sub(state.previousWorld);
  translateWorld(root, followDelta);
  grip.position.copy(state.restPosition);
  grip.quaternion.copy(state.restQuaternion);
  grip.getWorldPosition(state.previousWorld);
}

/**
 * Dedicated whole-object move grip: one visible bar plus a slightly larger
 * far shell sharing one emissive material. Near-hand input (controller
 * squeeze / hand pinch) grabs `near` via OneHandGrabbable; distance input
 * (controller ray trigger) grabs `far` via DistanceGrabbable. The two grab
 * components live on separate coincident entities because GrabSystem
 * ignores all but one grab component per entity.
 */
export interface MoveGrip {
  readonly group: Group;
  readonly near: Mesh;
  readonly far: Mesh;
  readonly material: MeshStandardMaterial;
}

/** Satin blue-steel bar with a cyan rest glow, matching the timeline rail. */
export function buildMoveGrip(name: string, widthM: number, heightM: number, depthM: number): MoveGrip {
  const material = new MeshStandardMaterial({
    color: 0x1b2f4d,
    metalness: 0.85,
    roughness: 0.35,
    emissive: 0x79d7f2,
    emissiveIntensity: 0.5,
  });
  const geometry = bevelBox(widthM, heightM, depthM, Math.min(widthM, heightM, depthM) * 0.3);
  const near = new Mesh(geometry, material);
  near.name = `${name} Near`;
  const far = new Mesh(geometry, material);
  far.name = `${name} Far`;
  // Larger ray target that also avoids z-fighting with the near bar.
  far.scale.setScalar(1.3);
  const group = new Group();
  group.name = name;
  group.add(near, far);
  return { group, near, far, material };
}

/**
 * Drives one move grip: while either mesh is held, `root` follows the active
 * grip 1:1 and the grip is pinned to its rest local transform; on release
 * both meshes are pinned and the root stays exactly where the hand left it.
 * Hover/grab/release emissive + haptic feedback included. Emits no weather
 * events: knob/snap haptic/audio bus untouched.
 */
export interface GripDriver {
  update(root: Object3D): void;
}

export function createGripDriver(
  world: World,
  nearEntity: Entity,
  farEntity: Entity,
  grip: MoveGrip,
): GripDriver {
  const follow = createGripFollowState();
  captureGripRest(grip.near, follow);
  let active: Mesh | null = null;
  return {
    update(root: Object3D): void {
      const held = nearEntity.hasComponent(Grabbed)
        ? grip.near
        : farEntity.hasComponent(Grabbed)
          ? grip.far
          : null;
      if (held !== active) {
        active = held;
        if (active != null) {
          active.getWorldPosition(follow.previousWorld);
          pulseHaptics(world, Haptics.grab.intensity, Haptics.grab.durationMs);
        } else {
          grip.near.position.copy(follow.restPosition);
          grip.near.quaternion.copy(follow.restQuaternion);
          grip.far.position.copy(follow.restPosition);
          grip.far.quaternion.copy(follow.restQuaternion);
          pulseHaptics(world, Haptics.settle.intensity, Haptics.settle.durationMs);
        }
      }
      if (active != null) {
        stepGripFollow(root, active, follow);
        // The panel grip is scene-level; the rail grip is a rail child.
        if (grip.group.parent !== root) {
          translateWorld(grip.group, followDelta);
          active.getWorldPosition(follow.previousWorld);
        }
      }
      const hovered =
        active != null ||
        nearEntity.hasComponent(Hovered) ||
        farEntity.hasComponent(Hovered);
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.008);
      grip.material.emissiveIntensity = active != null ? 2.6 + pulse * 0.8 : hovered ? 1.4 : 0.5;
    },
  };
}
