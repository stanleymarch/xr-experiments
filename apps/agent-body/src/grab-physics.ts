/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root of this source tree.
 */

import {
  createSystem,
  Grabbed,
  PhysicsBody,
  PhysicsManipulation,
  PhysicsState,
  PhysicsSystem,
  type Entity,
  type PhysicsBodyTransformOptions,
  type PhysicsBodyTransformPose,
} from '@iwsdk/core';
import { Quaternion, Vector3 } from 'three';

/**
 * Distance (metres, from the scene origin) beyond which a dynamic prop is
 * considered lost and is returned to its last resting pose.
 */
const GUARD_MAX_DISTANCE = 25;

/** Fastest speed (m/s) a release may impart, so a fast hand cannot launch a prop. */
const MAX_RELEASE_SPEED = 3.5;

/** Below this speed (m/s) a release is a plain drop. */
const MIN_RELEASE_SPEED = 0.15;

/** The only physics entry point this system needs. */
interface BodyTeleport {
  setBodyTransform(
    entity: Entity,
    pose: PhysicsBodyTransformPose,
    options?: PhysicsBodyTransformOptions,
  ): void;
}

interface BodyPose {
  /** Last pose the prop rested at; the rescue target. */
  readonly position: Vector3;
  readonly quaternion: Quaternion;
  /** Pose seen on the previous frame, used to detect a resting body. */
  readonly seen: Vector3;
}

/** Frame-to-frame movement (squared, metres) still considered "at rest". */
const REST_EPSILON_SQ = 0.01 * 0.01;

interface BodyMotion {
  /** Position as of the previous frame, while the prop was held. */
  readonly previous: Vector3;
  /** Smoothed, clamped speed of the hand, in world units per second. */
  readonly velocity: Vector3;
}

/**
 * Keeps grabbed props from inheriting the enormous velocity the physics body
 * picks up while it chases the hand.
 *
 * The grab handle drives a `Grabbed` body through `SetTargetTransform`; when the
 * pointer moves in a single large step the body accumulates a velocity that is
 * released in full the moment the grab ends, which launches the prop across the
 * scene. Mirroring the body's own pose back with `resetVelocity` every frame it
 * is held keeps that velocity at zero, and the prop's own (clamped) motion is
 * handed back on release, so a normal release is a gentle drop or toss.
 *
 * The same pass doubles as a safety net: a body that ends up non-finite or
 * absurdly far away is returned to its last sane pose.
 *
 * Only dynamic bodies are touched; the static room colliders are left alone.
 */
export class GrabPhysicsGuardSystem extends createSystem({
  bodies: { required: [PhysicsBody] },
}) {
  private physics: BodyTeleport | undefined;
  /** Bodies that were held on the previous frame. */
  private readonly held = new Set<Entity>();
  /** Last sane, ungrabbed pose per body, used as a rescue target. */
  private readonly resting = new Map<number, BodyPose>();
  /** Motion of each currently held body. */
  private readonly motion = new Map<number, BodyMotion>();

  update(delta: number): void {
    if (!this.physics) {
      this.physics = this.world.getSystem(PhysicsSystem);
      if (!this.physics) return;
    }
    const physics = this.physics;
    const elapsed = Number.isFinite(delta) && delta > 1e-4 ? delta : 0;

    const heldNow = new Set<Entity>();
    for (const entity of this.queries.bodies.entities) {
      const object = entity.object3D;
      if (!object) continue;
      if (entity.getValue(PhysicsBody, 'state') !== PhysicsState.Dynamic) continue;

      const position = object.position;
      const quaternion = object.quaternion;

      if (!isFinite(position) || position.length() > GUARD_MAX_DISTANCE) {
        this.motion.delete(entity.index);
        const saved = this.resting.get(entity.index);
        if (saved) {
          position.copy(saved.position);
          quaternion.copy(saved.quaternion);
          saved.seen.copy(saved.position);
          object.updateMatrixWorld(true);
          physics.setBodyTransform(
            entity,
            { position: saved.position, quaternion: saved.quaternion },
            { resetVelocity: true },
          );
        }
        continue;
      }

      if (entity.hasComponent(Grabbed)) {
        heldNow.add(entity);
        this.trackMotion(entity.index, position, elapsed);
        // Hold the body's own pose with zero velocity: nothing can accumulate
        // while the hand is moving, however fast the pointer jumps.
        physics.setBodyTransform(
          entity,
          { position, quaternion },
          { resetVelocity: true },
        );
        continue;
      }

      // Free body: remember where it rests (the rescue target) and hand back
      // the motion of the hand on the frame the grab ends.
      let saved = this.resting.get(entity.index);
      if (!saved) {
        saved = {
          position: new Vector3(),
          quaternion: new Quaternion(),
          seen: new Vector3(),
        };
        saved.position.copy(position);
        saved.quaternion.copy(quaternion);
        saved.seen.copy(position);
        this.resting.set(entity.index, saved);
      } else if (saved.seen.distanceToSquared(position) <= REST_EPSILON_SQ) {
        // Only a prop that has settled updates the rescue target, so a body
        // thrown out of the room comes back to where it used to live.
        saved.position.copy(position);
        saved.quaternion.copy(quaternion);
      }
      saved.seen.copy(position);

      if (this.held.has(entity)) this.release(entity);
      this.motion.delete(entity.index);
    }

    this.held.clear();
    for (const entity of heldNow) this.held.add(entity);
  }

  /** Record how fast the prop itself is travelling while it is held. */
  private trackMotion(index: number, position: Vector3, elapsed: number): void {
    let motion = this.motion.get(index);
    if (!motion) {
      motion = { previous: new Vector3(), velocity: new Vector3() };
      motion.previous.copy(position);
      this.motion.set(index, motion);
      return;
    }
    if (elapsed > 0) {
      // Light smoothing so one jittery frame cannot dominate the release speed.
      const blend = 0.6;
      motion.velocity.set(
        motion.velocity.x * (1 - blend) + ((position.x - motion.previous.x) / elapsed) * blend,
        motion.velocity.y * (1 - blend) + ((position.y - motion.previous.y) / elapsed) * blend,
        motion.velocity.z * (1 - blend) + ((position.z - motion.previous.z) / elapsed) * blend,
      );
      const speed = motion.velocity.length();
      if (speed > MAX_RELEASE_SPEED) {
        motion.velocity.multiplyScalar(MAX_RELEASE_SPEED / speed);
      }
    }
    motion.previous.copy(position);
  }

  /** Give the prop back the (already clamped) speed of the hand that held it. */
  private release(entity: Entity): void {
    const motion = this.motion.get(entity.index);
    if (!motion) return;
    if (motion.velocity.length() < MIN_RELEASE_SPEED) return;
    if (entity.hasComponent(PhysicsManipulation)) return;
    entity.addComponent(PhysicsManipulation, {
      linearVelocity: [motion.velocity.x, motion.velocity.y, motion.velocity.z],
      angularVelocity: [0, 0, 0],
    });
  }
}

function isFinite(vector: Vector3): boolean {
  return (
    Number.isFinite(vector.x) &&
    Number.isFinite(vector.y) &&
    Number.isFinite(vector.z)
  );
}
