/**
 * Owns the RoomModel: subscribes to XRPlane/XRMesh qualify/disqualify and
 * rebuilds the coarse height grid after detection or tracked geometry changes.
 * Change signatures are sampled at 2 Hz; grid rebuilds are debounced likewise.
 */

import { createSystem, Mesh, XRMesh, XRPlane } from '@iwsdk/core';
import type { Entity, Object3D } from '@iwsdk/core';
import { roomModel } from '../room.js';

/** Minimum seconds between signature scans and grid rebuilds. */
const REBUILD_DEBOUNCE_S = 0.5;

type PlaneSource = {
  lastChangedTime?: number;
  polygon?: readonly { x: number; y: number; z: number }[];
};
type MeshSource = {
  lastChangedTime?: number;
  vertices?: ArrayLike<number>;
  indices?: ArrayLike<number>;
};


function mixSignature(signature: number, value: number): number {
  return Math.imul(signature ^ Math.round(value * 10000), 16777619);
}

function geometrySignature(
  object: Object3D,
  plane?: PlaneSource,
  mesh?: MeshSource,
): number {
  object.updateWorldMatrix(true, false);
  let signature = 2166136261;
  const matrix = object.matrixWorld.elements;
  for (let i = 0; i < matrix.length; i += 1) signature = mixSignature(signature, matrix[i]);
  if (object instanceof Mesh) {
    const geometry = object.geometry;
    const positions = geometry.getAttribute('position');
    if (positions != null) {
      signature = mixSignature(signature, positions.count);
      const values = positions.array;
      for (let i = 0; i < values.length; i += 1) signature = mixSignature(signature, values[i]);
    }
    const indices = geometry.index;
    if (indices != null) {
      signature = mixSignature(signature, indices.count);
      const values = indices.array;
      for (let i = 0; i < values.length; i += 1) signature = mixSignature(signature, values[i]);
    }
  }
  if (plane != null) {
    signature = mixSignature(signature, plane.lastChangedTime ?? 0);
    const polygon = plane.polygon;
    if (polygon != null) {
      signature = mixSignature(signature, polygon.length);
      for (const point of polygon) {
        signature = mixSignature(signature, point.x);
        signature = mixSignature(signature, point.y);
        signature = mixSignature(signature, point.z);
      }
    }
  }
  if (mesh != null) {
    signature = mixSignature(signature, mesh.lastChangedTime ?? 0);
    const vertices = mesh.vertices;
    if (vertices != null) {
      signature = mixSignature(signature, vertices.length);
      for (let i = 0; i < vertices.length; i += 1) signature = mixSignature(signature, vertices[i]);
    }
    const indices = mesh.indices;
    if (indices != null) {
      signature = mixSignature(signature, indices.length);
      for (let i = 0; i < indices.length; i += 1) signature = mixSignature(signature, indices[i]);
    }
  }
  return signature;
}

export class RoomSensingSystem extends createSystem({
  planes: { required: [XRPlane] },
  meshes: { required: [XRMesh] },
}) {
  private readonly tracked = new Set<Entity>();
  private readonly signatures = new Map<Entity, number>();
  private lastSignatureScanAt = -REBUILD_DEBOUNCE_S;
  private pendingRebuild = false;
  private lastRebuildAt = -REBUILD_DEBOUNCE_S;

  init(): void {
    const remember = (entity: Entity): void => {
      if (entity.object3D != null && !this.tracked.has(entity)) {
        this.tracked.add(entity);
        this.signatures.set(entity, Number.NaN);
      }
      this.pendingRebuild = true;
    };
    const forget = (entity: Entity): void => {
      this.tracked.delete(entity);
      this.signatures.delete(entity);
      this.pendingRebuild = true;
    };
    this.cleanupFuncs.push(
      this.queries.planes.subscribe('qualify', remember),
      this.queries.planes.subscribe('disqualify', forget),
      this.queries.meshes.subscribe('qualify', remember),
      this.queries.meshes.subscribe('disqualify', forget),
    );
    // Replay entities that qualified before init ran.
    for (const entity of this.queries.planes.entities) remember(entity);
    for (const entity of this.queries.meshes.entities) remember(entity);
  }

  update(_delta: number, time: number): void {
    if (time - this.lastSignatureScanAt >= REBUILD_DEBOUNCE_S) {
      this.lastSignatureScanAt = time;
      for (const entity of this.tracked) {
        const object = entity.object3D;
        if (object == null) continue;
        const plane = this.queries.planes.entities.has(entity)
          ? (entity.getValue(XRPlane, '_plane') as PlaneSource | undefined)
          : undefined;
        const mesh = this.queries.meshes.entities.has(entity)
          ? (entity.getValue(XRMesh, '_mesh') as MeshSource | undefined)
          : undefined;
        const signature = geometrySignature(object, plane, mesh);
        const previous = this.signatures.get(entity);
        if (previous !== undefined && Number.isFinite(previous) && previous !== signature) {
          this.pendingRebuild = true;
        }
        this.signatures.set(entity, signature);
      }
    }
    if (!this.pendingRebuild) return;
    if (time - this.lastRebuildAt < REBUILD_DEBOUNCE_S) return;
    const objects = [];
    for (const entity of this.tracked) {
      if (entity.object3D != null) objects.push(entity.object3D);
    }
    this.pendingRebuild = false;
    this.lastRebuildAt = time;
    roomModel.rebuild(objects);
  }

  override destroy(): void {
    super.destroy();
    this.tracked.clear();
    this.signatures.clear();
    this.pendingRebuild = false;
    roomModel.rebuild([]);
  }
}
