/**
 * Owns the RoomModel: subscribes to XRPlane/XRMesh qualify/disqualify and
 * rebuilds the coarse height grid after detection or tracked geometry changes.
 * Change signatures are sampled at 2 Hz; grid rebuilds are debounced likewise.
 */

import { createSystem, Mesh, Vector3, XRMesh, XRPlane } from '@iwsdk/core';
import type { BufferGeometry, Entity, Object3D } from '@iwsdk/core';
import { isCeilingPlate, isDegeneratePlate, isTiltedPlate, isWallPlane } from '../plane-admission.js';
import type { PlaneSource } from '../plane-admission.js';
import { roomModel } from '../room.js';
import type { RoomSurfaceSource } from '../room.js';

/** Minimum seconds between signature scans and grid rebuilds. */
const REBUILD_DEBOUNCE_S = 0.5;

const headPosition = new Vector3();

type MeshSource = {
  lastChangedTime?: number;
  vertices?: ArrayLike<number>;
  indices?: ArrayLike<number>;
};

/**
 * Center of the reported plane polygon in surface-local meters. The
 * framework uses an origin-centered box with the polygon's width/depth,
 * discarding its extents center (createPlaneGeometry). Sampling and bounds
 * add that center before the world transform, restoring the native plane
 * position. A centered polygon yields ~0 (no-op).
 */
function planeCentroidXZ(polygon: readonly { x: number; y: number; z: number }[] | undefined): { x: number; z: number } {
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
      signature = mixSampled(signature, positions.array as unknown as ArrayLike<number>);
    }
    const indices = geometry.index;
    if (indices != null) {
      signature = mixSampled(signature, indices.array as unknown as ArrayLike<number>);
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
        // Wall plates are never room-surface sources (see isWallPlane);
        // skipping them here also keeps their refinement churn from
        // triggering grid rebuilds.
        if (this.queries.planes.entities.has(entity) && isWallPlane(entity.getValue(XRPlane, '_plane'))) {
          return;
        }
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
        const isPlane = this.queries.planes.entities.has(entity);
        const rawPlane: unknown = isPlane ? entity.getValue(XRPlane, '_plane') : undefined;
        const plane = (rawPlane != null && typeof rawPlane === 'object' ? rawPlane : undefined) as PlaneSource | undefined;
        const isMesh = this.queries.meshes.entities.has(entity);
        const rawMesh: unknown = isMesh ? entity.getValue(XRMesh, '_mesh') : undefined;
        const mesh = (rawMesh != null && typeof rawMesh === 'object' ? rawMesh : undefined) as MeshSource | undefined;
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
      roomModel.beginRebuild(this.currentObjects(headPosition.y), headPosition);
        roomModel.step();
      }
      return;
    }
    this.world.player.head.getWorldPosition(headPosition);
    if (!roomModel.contains(headPosition)) this.pendingRebuild = true;
    if (!this.pendingRebuild) return;
    if (time - this.lastRebuildAt < REBUILD_DEBOUNCE_S) return;
    const objects = this.currentObjects(headPosition.y);
    this.pendingRebuild = false;
    this.lastRebuildAt = time;
    // The weather happens around the viewer: anchor the volume to the head so
    // a room mesh reported far from the viewer cannot strand every particle
    // system out of sight while the panel still shows nonzero drivers.
    this.world.player.head.getWorldPosition(headPosition);
    roomModel.beginRebuild(objects, headPosition);
    roomModel.step();
  }

  private currentObjects(headY: number): RoomSurfaceSource[] {
    const objects: RoomSurfaceSource[] = [];
    for (const entity of this.tracked) {
      const object = entity.object3D;
      if (object == null) continue;
      const source: RoomSurfaceSource = object;
      if (this.queries.planes.entities.has(entity)) {
        const raw: unknown = entity.getValue(XRPlane, '_plane');
        if (isWallPlane(raw)) continue;
        const plane = (raw != null && typeof raw === 'object' ? raw : undefined) as PlaneSource | undefined;
        // Plates are scene-root children, so position.y is their world level.
        object.updateWorldMatrix(true, false);
        if (isCeilingPlate(object.position.y, headY)) continue;
        if (!this.isSurfacePlate(object)) continue;
        const centroid = planeCentroidXZ(plane?.polygon);
        source.offsetX = centroid.x;
        source.offsetZ = centroid.z;
      }
      objects.push(source);
    }
    return objects;
  }

  /**
   * True when a plane plate actually looks like a horizontal surface: two
   * dimensional in XZ and not tilted away from world up. `orientation` is
   * the cheap first cut, but real headsets may omit it, and the framework's
   * plate keeps the plane pose — so geometry decides here.
   */
  private isSurfacePlate(object: Object3D): boolean {
    const elements = object.matrixWorld.elements;
    const upY = elements[5];
    const upLength = Math.hypot(elements[4], elements[5], elements[6]) || 1;
    if (isTiltedPlate(upY / upLength)) return false;
    const geometry = (object as Object3D & { geometry?: BufferGeometry }).geometry;
    if (geometry == null) return true;
    if (geometry.boundingBox == null) geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (box == null) return true;
    const scaleX = Math.hypot(elements[0], elements[1], elements[2]);
    const scaleZ = Math.hypot(elements[8], elements[9], elements[10]);
    return !isDegeneratePlate((box.max.x - box.min.x) * scaleX, (box.max.z - box.min.z) * scaleZ);
  }

  override destroy(): void {
    super.destroy();
    this.tracked.clear();
    this.signatures.clear();
    this.pendingRebuild = false;
    roomModel.beginRebuild([]);
  }
}
