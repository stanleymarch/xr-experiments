/**
 * REALITY//FIELD — picking a real surface.
 *
 * The impulse needs the exact point where a pointing ray meets the room.
 * Ray-casting the rendered skin would mean testing tens of thousands of
 * triangles twice per frame on a standalone headset — too expensive for a
 * value the player never sees as "a triangle".
 *
 * Instead the picker works on the analytic shapes the sensors report:
 *
 * - a detected plane is a rectangle, so the ray is intersected with the
 *   rectangle's plane and the hit is accepted when it lands inside the
 *   polygon extents (the framework reports the polygon in surface-local
 *   coordinates, hence the local containment test);
 * - a detected mesh is bounded by an axis-aligned box, so the ray is tested
 *   against the box slabs and the face normal comes from the slab that was
 *   hit.
 *
 * Both tests are a handful of floating point operations per surface.
 */

import { Matrix4, Vector3 } from '@iwsdk/core';
import type { Object3D } from '@iwsdk/core';

interface PlaneSurface {
  center: Vector3;
  normal: Vector3;
  inverse: Matrix4;
  offsetX: number;
  offsetZ: number;
  halfX: number;
  halfZ: number;
}

interface BoxSurface {
  min: Vector3;
  max: Vector3;
}

const scratch = new Vector3();
const scratchLocal = new Vector3();
const scratchLocalFrame = new Vector3();
const scratchCorner = new Vector3();

/** One rectangle or box the ray can strike. */
export interface PickSurface {
  object: Object3D;
  isPlane: boolean;
  offsetX: number;
  offsetZ: number;
  localMin: Vector3 | null;
  localMax: Vector3 | null;
}

export class SurfacePicker {
  private readonly planes: PlaneSurface[] = [];
  private readonly boxes: BoxSurface[] = [];

  /** Rebuild the pickable shapes from the sensed surfaces. */
  rebuild(surfaces: readonly PickSurface[], head: Vector3): void {
    this.planes.length = 0;
    this.boxes.length = 0;
    for (const surface of surfaces) {
      const object = surface.object;
      object.updateWorldMatrix(true, false);
      const geometry = (object as Object3D & { geometry?: { computeBoundingBox?: () => void; boundingBox?: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null } }).geometry;
      if (surface.isPlane) {
        geometry?.computeBoundingBox?.();
        const bounds = geometry?.boundingBox;
        if (bounds == null) continue;
        const sizeX = bounds.max.x - bounds.min.x;
        const sizeZ = bounds.max.z - bounds.min.z;
        if (sizeX <= 0.01 || sizeZ <= 0.01) continue;
        const center = new Vector3().setFromMatrixPosition(object.matrixWorld);
        const normal = new Vector3(0, 1, 0).transformDirection(object.matrixWorld).normalize();
        scratch.subVectors(head, center);
        if (normal.dot(scratch) < 0) normal.negate();
        this.planes.push({
          center,
          normal,
          inverse: new Matrix4().copy(object.matrixWorld).invert(),
          offsetX: surface.offsetX,
          offsetZ: surface.offsetZ,
          halfX: sizeX / 2,
          halfZ: sizeZ / 2,
        });
      } else if (surface.localMin != null && surface.localMax != null) {
        const min = new Vector3(Infinity, Infinity, Infinity);
        const max = new Vector3(-Infinity, -Infinity, -Infinity);
        for (const x of [surface.localMin.x, surface.localMax.x]) {
          for (const y of [surface.localMin.y, surface.localMax.y]) {
            for (const z of [surface.localMin.z, surface.localMax.z]) {
              scratchCorner.set(x, y, z).applyMatrix4(object.matrixWorld);
              min.min(scratchCorner);
              max.max(scratchCorner);
            }
          }
        }
        if (min.x > max.x) continue;
        this.boxes.push({ min, max });
      }
    }
  }

  /**
   * Find the nearest surface along the ray.
   * Returns false when the ray misses every known surface.
   */
  pick(
    origin: Vector3,
    direction: Vector3,
    outPoint: Vector3,
    outNormal: Vector3,
  ): boolean {
    let bestDistance = Infinity;
    let found = false;

    for (const plane of this.planes) {
      const denominator = direction.dot(plane.normal);
      if (Math.abs(denominator) < 1e-4) continue;
      scratch.subVectors(plane.center, origin);
      const distance = scratch.dot(plane.normal) / denominator;
      if (distance <= 0.05 || distance >= bestDistance) continue;
      scratchLocal.copy(origin).addScaledVector(direction, distance);
      scratchLocalFrame.copy(scratchLocal).applyMatrix4(plane.inverse);
      if (Math.abs(scratchLocalFrame.x - plane.offsetX) > plane.halfX) continue;
      if (Math.abs(scratchLocalFrame.z - plane.offsetZ) > plane.halfZ) continue;
      bestDistance = distance;
      outPoint.copy(scratchLocal);
      outNormal.copy(plane.normal);
      found = true;
    }

    for (const box of this.boxes) {
      let tMin = 0.05;
      let tMax = bestDistance;
      let hitAxis = 0;
      let hitSign = 1;
      let valid = true;
      for (let axis = 0; axis < 3; axis += 1) {
        const originValue = origin.getComponent(axis);
        const directionValue = direction.getComponent(axis);
        const minValue = box.min.getComponent(axis);
        const maxValue = box.max.getComponent(axis);
        if (Math.abs(directionValue) < 1e-6) {
          if (originValue < minValue || originValue > maxValue) {
            valid = false;
            break;
          }
          continue;
        }
        const inverse = 1 / directionValue;
        let near = (minValue - originValue) * inverse;
        let far = (maxValue - originValue) * inverse;
        let sign = -1;
        if (near > far) {
          const swap = near;
          near = far;
          far = swap;
          sign = 1;
        }
        if (near > tMin) {
          tMin = near;
          hitAxis = axis;
          hitSign = sign;
        }
        if (far < tMax) tMax = far;
        if (tMin > tMax) {
          valid = false;
          break;
        }
      }
      if (!valid || tMin >= bestDistance) continue;
      bestDistance = tMin;
      outPoint.copy(origin).addScaledVector(direction, tMin);
      outNormal.set(0, 0, 0);
      outNormal.setComponent(hitAxis, hitSign);
      found = true;
    }

    return found;
  }
}
