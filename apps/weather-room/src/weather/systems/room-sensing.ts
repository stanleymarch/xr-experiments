/**
 * Owns the RoomModel: subscribes to XRPlane/XRMesh qualify/disqualify and
 * rebuilds the coarse height grid after detection or tracked geometry changes.
 * Change signatures are sampled at 2 Hz; grid rebuilds are debounced likewise.
 */

import { createSystem, Mesh, Vector3, XRMesh, XRPlane } from '@iwsdk/core';
import type { Entity, Object3D } from '@iwsdk/core';
import { roomModel } from '../room.js';

const headPosition = new Vector3();

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


/** Bounded stride sample; full mesh scans cost tens of millions of ops per
 * second on real room meshes (hundreds of thousands of vertices). */
const SIGNATURE_SAMPLES = 256;

function mixSignature(signature: number, value: number): number {
  return Math.imul(signature ^ Math.round(value * 10000), 16777619);
}

/** Hash at most SIGNATURE_SAMPLES evenly spaced components of an array-like. */
function mixSampled(signature: number, values: ArrayLike<number>): number {
  const count = values.length;
  signature = mixSignature(signature, count);
  const stride = Math.max(1, Math.floor(count / SIGNATURE_SAMPLES));
  for (let i = 0; i < count; i += stride) signature = mixSignature(signature, values[i]);
  return signature;
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
      signature = mixSampled(signature, positions.array as ArrayLike<number>);
    }
    const indices = geometry.index;
    if (indices != null) {
      signature = mixSampled(signature, indices.array as ArrayLike<number>);
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
    if (vertices != null) signature = mixSampled(signature, vertices);
    const indices = mesh.indices;
    if (indices != null) signature = mixSampled(signature, indices);
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
    // The grid build is incremental and frame-bounded: never raycast a whole
    // room mesh on one frame (that is what froze the headset on VR entry).
    // The viewer may walk while a build is pending: keep the finished volume
    // near the head by rebuilding once the head leaves it.
    if (roomModel.building) {
      roomModel.step();
      this.world.player.head.getWorldPosition(headPosition);
      if (!roomModel.contains(headPosition)) {
        roomModel.beginRebuild(this.currentObjects(), headPosition);
        roomModel.step();
      }
      return;
    }
    if (!this.pendingRebuild) return;
    if (time - this.lastRebuildAt < REBUILD_DEBOUNCE_S) return;
    const objects = this.currentObjects();
    this.pendingRebuild = false;
    this.lastRebuildAt = time;
    // The weather happens around the viewer: anchor the volume to the head so
    // a room mesh reported far from the viewer cannot strand every particle
    // system out of sight while the panel still shows nonzero drivers.
    this.world.player.head.getWorldPosition(headPosition);
    roomModel.beginRebuild(objects, headPosition);
    roomModel.step();
  }

  private currentObjects(): Object3D[] {
    const objects: Object3D[] = [];
    for (const entity of this.tracked) {
      if (entity.object3D != null) objects.push(entity.object3D);
    }
    return objects;
  }

  override destroy(): void {
    super.destroy();
    this.tracked.clear();
    this.signatures.clear();
    this.pendingRebuild = false;
    roomModel.beginRebuild([]);
  }
}
