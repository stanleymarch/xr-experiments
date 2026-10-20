/**
 * REALITY//FIELD — the room as a membrane.
 *
 * The room the headset reports (planes and mesh) is rebuilt as one
 * world-space triangle soup: a single skin stretched over everything the
 * sensors found. Two properties matter:
 *
 * - The skin lives in world space. The vertex shader therefore works in
 *   world coordinates, which is exactly the space the wave field lives in,
 *   and no per-surface transform juggling is needed at render time.
 * - Every vertex keeps the normal that points *into the room* (toward the
 *   viewer). The impulse pushes against that normal, so a strike always
 *   dents the surface away from the person who struck it.
 *
 * Planes arrive from the framework as origin-centered plates spanning the
 * polygon extents; the polygon centroid has to be restored before the world
 * transform, exactly like the sibling Weather Room does, otherwise the skin
 * sits next to the real surface instead of on it.
 */

import { BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute, Vector3 } from '@iwsdk/core';
import type { Object3D } from '@iwsdk/core';

/** Target spacing between skin vertices, meters. */
const CELL_M = 0.18;
/** Maximum vertices per plane edge. */
const MAX_EDGE_CELLS = 26;
/** Meshes larger than this are skipped: a room mesh can hold hundreds of
 * thousands of vertices and copying it into a world-space skin every
 * rebuild is not affordable on a standalone headset. */
const MAX_MESH_VERTICES = 24000;
/** Hard cap on the whole skin. */
const MAX_SKIN_VERTICES = 60000;

/** One sensed surface backing the skin. */
export interface SurfaceEntry {
  /** Owner of the geometry (the scene-understanding entity's Object3D). */
  readonly object: Object3D;
  /** True for a detected plane, false for a detected mesh. */
  readonly isPlane: boolean;
  /** Plane polygon centroid in surface-local XZ (mesh entries use 0). */
  offsetX: number;
  offsetZ: number;
  /** Local-space bounds of a sensed mesh, null for planes. */
  localMin: Vector3 | null;
  localMax: Vector3 | null;
}

/** Result of a skin rebuild. */
export interface SkinBuild {
  /** World-space skin geometry (null when nothing was sensed). */
  geometry: BufferGeometry | null;
  /** Debug outline: line-segment pairs in world space. */
  outline: Float32Array;
  /** Number of surfaces that contributed. */
  surfaceCount: number;
}

const scratchPoint = new Vector3();
const scratchNormal = new Vector3();
const scratchCenter = new Vector3();
const scratchToward = new Vector3();

/** Centroid of a plane polygon in surface-local XZ. */
export function planeCentroidXZ(
  polygon: readonly { x: number; y: number; z: number }[] | undefined,
): { x: number; z: number } {
  if (polygon == null || polygon.length === 0) return { x: 0, z: 0 };
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const point of polygon) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.z < minZ) minZ = point.z;
    if (point.z > maxZ) maxZ = point.z;
  }
  return { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
}

/**
 * Build the world-space skin over every sensed surface.
 *
 * `head` decides which way a surface faces: the normal is flipped to point
 * toward the viewer, so the skin is visible from inside the room and an
 * impulse pushes into the wall rather than out of it.
 */
export function buildSkin(
  entries: readonly SurfaceEntry[],
  head: Vector3,
): SkinBuild {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const outline: number[] = [];
  let vertexCount = 0;
  let surfaceCount = 0;

  for (const entry of entries) {
    if (vertexCount >= MAX_SKIN_VERTICES) break;
    const object = entry.object;
    object.updateWorldMatrix(true, false);
    const geometry = (object as Object3D & { geometry?: BufferGeometry }).geometry;
    if (geometry == null) continue;

    if (entry.isPlane) {
      geometry.computeBoundingBox();
      const bounds = geometry.boundingBox;
      if (bounds == null) continue;
      const sizeX = bounds.max.x - bounds.min.x;
      const sizeZ = bounds.max.z - bounds.min.z;
      if (sizeX <= 0.01 || sizeZ <= 0.01) continue;
      const columns = Math.min(MAX_EDGE_CELLS, Math.max(2, Math.round(sizeX / CELL_M)));
      const rows = Math.min(MAX_EDGE_CELLS, Math.max(2, Math.round(sizeZ / CELL_M)));

      // The plate's local +Y is its surface normal.
      scratchNormal.set(0, 1, 0).transformDirection(object.matrixWorld).normalize();
      scratchCenter.setFromMatrixPosition(object.matrixWorld);
      scratchToward.subVectors(head, scratchCenter);
      if (scratchNormal.dot(scratchToward) < 0) scratchNormal.negate();

      const base = vertexCount;
      // The four corners of the rectangle, for the debug outline. They are
      // collected in grid order, so the border loop below must visit them
      // around the rectangle, not in scan order.
      const corner00 = new Vector3();
      const corner0N = new Vector3();
      const cornerNN = new Vector3();
      const cornerN0 = new Vector3();
      for (let row = 0; row <= rows; row += 1) {
        for (let column = 0; column <= columns; column += 1) {
          const localX =
            bounds.min.x + (column / columns) * sizeX + entry.offsetX;
          const localZ =
            bounds.min.z + (row / rows) * sizeZ + entry.offsetZ;
          scratchPoint.set(localX, 0, localZ).applyMatrix4(object.matrixWorld);
          positions.push(scratchPoint.x, scratchPoint.y, scratchPoint.z);
          normals.push(scratchNormal.x, scratchNormal.y, scratchNormal.z);
          if (row === 0 && column === 0) corner00.copy(scratchPoint);
          else if (row === 0 && column === columns) corner0N.copy(scratchPoint);
          else if (row === rows && column === columns) cornerNN.copy(scratchPoint);
          else if (row === rows && column === 0) cornerN0.copy(scratchPoint);
          vertexCount += 1;
        }
      }
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const i0 = base + row * (columns + 1) + column;
          const i1 = i0 + 1;
          const i2 = i0 + (columns + 1);
          const i3 = i2 + 1;
          indices.push(i0, i2, i1, i1, i2, i3);
        }
      }
      // Debug outline: the border of the plane, walked around the rectangle.
      const border = [corner00, corner0N, cornerNN, cornerN0];
      for (let i = 0; i < border.length; i += 1) {
        const a = border[i];
        const b = border[(i + 1) % border.length];
        outline.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
      surfaceCount += 1;
    } else {
      const positionAttribute = geometry.getAttribute('position');
      if (positionAttribute == null) continue;
      const count = positionAttribute.count;
      if (count > MAX_MESH_VERTICES) continue;
      if (vertexCount + count > MAX_SKIN_VERTICES) continue;

      const clone = geometry.clone();
      clone.applyMatrix4(object.matrixWorld);
      if (clone.getAttribute('normal') == null) clone.computeVertexNormals();
      const clonedPosition = clone.getAttribute('position');
      const clonedNormal = clone.getAttribute('normal');
      if (clonedPosition == null || clonedNormal == null) {
        clone.dispose();
        continue;
      }
      const base = vertexCount;
      for (let i = 0; i < count; i += 1) {
        positions.push(
          clonedPosition.getX(i),
          clonedPosition.getY(i),
          clonedPosition.getZ(i),
        );
        normals.push(clonedNormal.getX(i), clonedNormal.getY(i), clonedNormal.getZ(i));
      }
      vertexCount += count;
      const index = clone.getIndex();
      if (index != null) {
        for (let i = 0; i < index.count; i += 1) {
          indices.push(base + index.getX(i));
        }
      } else {
        for (let i = 0; i < count; i += 1) indices.push(base + i);
      }
      clone.dispose();

      // Debug outline: the sensed mesh's bounds.
      if (entry.localMin != null && entry.localMax != null) {
        pushBoxOutline(outline, entry.localMin, entry.localMax, object.matrixWorld);
      }
      surfaceCount += 1;
    }
  }

  if (vertexCount === 0) {
    return { geometry: null, outline: new Float32Array(0), surfaceCount: 0 };
  }
  const skinGeometry = new BufferGeometry();
  skinGeometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  skinGeometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  skinGeometry.setIndex(new Uint32BufferAttribute(new Uint32Array(indices), 1));
  skinGeometry.computeBoundingSphere();
  return {
    geometry: skinGeometry,
    outline: new Float32Array(outline),
    surfaceCount,
  };
}

/** Push the twelve edges of a local-space box, transformed to world space. */
function pushBoxOutline(
  outline: number[],
  min: Vector3,
  max: Vector3,
  matrixWorld: Object3D['matrixWorld'],
): void {
  const corners: Vector3[] = [];
  for (const x of [min.x, max.x]) {
    for (const y of [min.y, max.y]) {
      for (const z of [min.z, max.z]) {
        corners.push(new Vector3(x, y, z).applyMatrix4(matrixWorld));
      }
    }
  }
  // Index order of the loop above: (min.x,min.y,min.z) is 0, (min.x,min.y,max.z) 1,
  // (min.x,max.y,min.z) 2, (min.x,max.y,max.z) 3, (max.x,min.y,min.z) 4,
  // (max.x,min.y,max.z) 5, (max.x,max.y,min.z) 6, (max.x,max.y,max.z) 7.
  const edges: Array<[number, number]> = [
    [0, 1], [0, 2], [1, 3], [2, 3],
    [4, 5], [4, 6], [5, 7], [6, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  for (const [a, b] of edges) {
    const start = corners[a];
    const end = corners[b];
    outline.push(start.x, start.y, start.z, end.x, end.y, end.z);
  }
}
