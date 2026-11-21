/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root of this source tree.
 */

/**
 * "Hold the grip and take what you point at."
 *
 * The trigger is the pointer (it clicks the panel and distance-grabs the
 * props), the grip is the grabber. Holding the grip button while the ray
 * rests on a prop takes that prop and keeps it at the distance where it was
 * caught; releasing the grip lets it drop.
 *
 * The prop is moved through the physics system rather than through its
 * transform, so a rigid body follows the hand instead of fighting it, and
 * its velocity is cleared every frame - a held prop cannot build up the
 * impulse that used to launch it across the room when released.
 */

import {
  createSystem,
  GrabSystem,
  PhysicsBody,
  PhysicsSystem,
  type Entity,
  type Object3D,
  type PhysicsBodyTransformOptions,
  type PhysicsBodyTransformPose,
} from '@iwsdk/core';
import { Quaternion, Vector3, type Raycaster } from 'three';
import { HAPTIC_GRAB, HAPTIC_RELEASE, pulseHaptics } from './haptics.js';

/** Button index of the squeeze/grip on the standard xr gamepad layout. */
const GRIP_BUTTON = 1;

interface GripTarget {
  readonly entity: Entity;
  readonly hand: 'left' | 'right';
  /** Distance from the ray origin to the prop when it was caught. */
  readonly distance: number;
}

/** The only physics entry point this system needs. */
interface BodyTeleport {
  setBodyTransform(
    entity: Entity,
    pose: PhysicsBodyTransformPose,
    options?: PhysicsBodyTransformOptions,
  ): void;
}

/** The ray behind a pointer; the intersector keeps it. */
function rayOf(pointer: unknown): { origin: Vector3; direction: Vector3 } | undefined {
  const intersector = (pointer as { intersector?: { raycaster?: Raycaster } })?.intersector;
  return intersector?.raycaster?.ray;
}

export class GripGrabSystem extends createSystem({}) {
  private target: GripTarget | undefined;
  private squeezing: Record<'left' | 'right', boolean> = { left: false, right: false };
  private physics: BodyTeleport | undefined;

  update(): void {
    const world = this.world;
    const gamepads = world.input.xr?.gamepads;
    if (!gamepads) return;

    for (const hand of ['left', 'right'] as const) {
      const pad = gamepads[hand];
      if (!pad) continue;
      const squeezing = pad.getButtonPressedByIdx(GRIP_BUTTON);
      const pressed = squeezing && !this.squeezing[hand];
      const released = !squeezing && this.squeezing[hand];
      this.squeezing[hand] = squeezing;
      if (pressed && !this.target) this.catch(hand);
      if (released && this.target?.hand === hand) this.drop();
    }

    if (this.target) this.drag();
  }

  /** Take the prop the ray is resting on. */
  private catch(hand: 'left' | 'right'): void {
    const pointer = this.world.input.xr?.multiPointers?.[hand]?.getPointer('ray');
    const hit = pointer?.getIntersection();
    const ray = rayOf(pointer);
    if (!hit || !ray) return;
    const entity = this.findEntity(hit.object);
    if (!entity) return;
    const object = entity.object3D;
    if (!object) return;
    const position = object.getWorldPosition(new Vector3());
    const distance = position.distanceTo(ray.origin);
    this.target = { entity, hand, distance };
    pulseHaptics(this.world, hand, HAPTIC_GRAB);
  }

  /** Let the prop go. */
  private drop(): void {
    if (!this.target) return;
    pulseHaptics(this.world, this.target.hand, HAPTIC_RELEASE);
    this.target = undefined;
  }

  /** Keep the held prop at the distance where it was caught. */
  private drag(): void {
    const target = this.target;
    if (!target) return;
    const pointer = this.world.input.xr?.multiPointers?.[target.hand]?.getPointer('ray');
    const ray = rayOf(pointer);
    const object = target.entity.object3D;
    if (!ray || !object) return;
    const position = ray.origin.clone().add(ray.direction.clone().multiplyScalar(target.distance));
    if (target.entity.hasComponent(PhysicsBody)) {
      if (!this.physics) this.physics = this.world.getSystem(PhysicsSystem);
      this.physics?.setBodyTransform(
        target.entity,
        { position, quaternion: object.quaternion },
        { resetVelocity: true },
      );
      return;
    }
    object.position.copy(position);
    object.updateMatrixWorld(true);
  }

  /** The distance-grabbable entity that owns the object under the ray. */
  private findEntity(object: Object3D): Entity | undefined {
    const grab = this.world.getSystem(GrabSystem);
    const entities = grab?.queries?.distanceGrabbables?.entities;
    if (!entities) return undefined;
    for (const entity of Array.from(entities)) {
      let node: Object3D | null = object;
      while (node) {
        if (node === entity.object3D) return entity;
        node = node.parent;
      }
    }
    return undefined;
  }
}
