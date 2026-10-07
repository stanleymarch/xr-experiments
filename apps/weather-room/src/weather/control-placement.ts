import { Quaternion, Vector3 } from '@iwsdk/core';
import type { Object3D, World } from '@iwsdk/core';

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
