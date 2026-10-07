/**
 * WEATHER//ROOM room model: coarse surface knowledge built from real-world
 * XR geometry (planes/meshes reported by the built-in SceneUnderstanding
 * system). Particle systems consume `bounds` (placement volume) and
 * `surfaceHeightAt` (splash/thermal anchoring).
 *
 * Cost model (device-critical): the height grid is filled from a bounded
 * vertex sample per frame instead of per-cell raycasts. A real room mesh has
 * hundreds of thousands of vertices; raycasting every grid cell against every
 * surface is O(cells x triangles) on the main thread and freezes the headset
 * during VR entry, when mesh detection first delivers geometry. Sampling
 * vertices is O(vertices) once, spread over frames, and never blocks a frame.
 */

import { Box3, Matrix3, Vector3 } from '@iwsdk/core';
import type { BufferGeometry, Object3D } from '@iwsdk/core';

/** Coarse height-grid cell size in meters. */
const GRID_CELL = 0.25;
/** Half-extent of the fallback volume (3 x 2.5 x 3 m box). */
const FALLBACK_HALF_XZ = 1.5;
const FALLBACK_HEIGHT = 2.5;
/** Vertices consumed per incremental build step (keeps frames cheap). */
const VERTICES_PER_STEP = 4096;
/** Voxel keep-step: sample every Nth component to bound dense meshes harder. */
const VERTEX_STRIDE = 3;
/** Minimum world-space normal.y for a face to count as an upward surface. */
const UPWARD_NORMAL_Y = 0.5;

type SurfaceEntry = {
  /** Owner of the geometry; carries the world matrix used for sampling. */
  readonly object: Object3D;
  readonly positions: ArrayLike<number> | null;
  readonly normals: ArrayLike<number> | null;
};

/**
 * Shared room knowledge. Owned (rebuilt) by RoomSensingSystem; every other
 * system only reads. Until the first surface qualifies, `hasSurfaces` is
 * false and readers must use the default box (splash fallback in IWER).
 */
class RoomModel {
  /** Placement volume. Defaults to a 3 x 2.5 x 3 m box around the origin. */
  readonly min = new Vector3(-FALLBACK_HALF_XZ, 0, -FALLBACK_HALF_XZ);
  readonly max = new Vector3(FALLBACK_HALF_XZ, FALLBACK_HEIGHT, FALLBACK_HALF_XZ);
  /** False until the first XRPlane/XRMesh qualifies. */
  hasSurfaces = false;
  /** True while an incremental build still has work left. */
  building = false;

  private readonly box = new Box3();
  private readonly normalMatrix = new Matrix3();
  private readonly surfaceNormal = new Vector3();
  private readonly point = new Vector3();
  private readonly corner = new Vector3();
  // Coarse top-surface height grid over [gridMinX, ...] (NaN = no hit).
  private grid = new Float32Array(0);
  private gridCols = 0;
  private gridRows = 0;
  private gridMinX = 0;
  private gridMinZ = 0;
  private entries: SurfaceEntry[] = [];
  private entryIndex = 0;
  private componentCursor = 0;
  private geometryCursor = 0;

  /**
   * Start a rebuild from the currently tracked surface objects. Bounds are
   * computed immediately (cheap, bounding-box based); the height grid is then
   * filled incrementally by `step()`.
   */
  beginRebuild(objects: readonly Object3D[]): void {
    this.building = false;
    this.entries = [];
    this.entryIndex = 0;
    this.componentCursor = 0;
    this.geometryCursor = 0;
    if (objects.length === 0) {
      this.reset();
      return;
    }
    this.box.makeEmpty();
    for (const object of objects) this.box.expandByObject(object);
    if (this.box.isEmpty()) {
      this.reset();
      return;
    }
    this.min.copy(this.box.min);
    this.max.copy(this.box.max);
    // Keep the volume sane: never below the floor plane region, never huge.
    if (this.max.y - this.min.y < 0.5) this.max.y = this.min.y + 0.5;
    this.hasSurfaces = true;

    const spanX = Math.max(GRID_CELL, this.max.x - this.min.x);
    const spanZ = Math.max(GRID_CELL, this.max.z - this.min.z);
    this.gridCols = Math.max(1, Math.ceil(spanX / GRID_CELL));
    this.gridRows = Math.max(1, Math.ceil(spanZ / GRID_CELL));
    this.gridMinX = this.min.x;
    this.gridMinZ = this.min.z;
    if (this.grid.length !== this.gridCols * this.gridRows) {
      this.grid = new Float32Array(this.gridCols * this.gridRows);
    }
    this.grid.fill(Number.NaN);

    for (const object of objects) {
      object.updateWorldMatrix(true, false);
      const mesh = object as Object3D & { geometry?: BufferGeometry };
      const geometry = mesh.geometry;
      const positions = geometry?.getAttribute?.('position')?.array ?? null;
      const normals = geometry?.getAttribute?.('normal')?.array ?? null;
      if (positions == null) continue;
      this.entries.push({ object, positions, normals });
    }
    this.building = this.entries.length > 0;
    if (!this.building) this.hasSurfaces = this.grid.length > 0 && false;
  }

  /**
   * Consume a bounded slice of the pending build. Returns true while work
   * remains. Safe to call every frame; does nothing when no build is pending.
   */
  step(): boolean {
    if (!this.building) return false;
    let budget = VERTICES_PER_STEP;
    while (budget > 0 && this.entryIndex < this.entries.length) {
      const entry = this.entries[this.entryIndex];
      const consumed = this.consumeEntry(entry, budget);
      budget -= consumed;
      if (this.geometryCursor >= this.entryLength(entry)) {
        this.entryIndex += 1;
        this.geometryCursor = 0;
        this.componentCursor = 0;
      }
    }
    if (this.entryIndex >= this.entries.length) {
      this.building = false;
      this.entries = [];
    }
    return this.building;
  }

  private entryLength(entry: SurfaceEntry): number {
    return entry.positions?.length ?? 0;
  }

  /** Feed up to `budget` vertex components from one entry into the grid. */
  private consumeEntry(entry: SurfaceEntry, budget: number): number {
    const total = this.entryLength(entry);
    const step = VERTEX_STRIDE * 3;
    let consumed = 0;
    this.normalMatrix.getNormalMatrix(entry.object.matrixWorld);
    const positions = entry.positions as ArrayLike<number>;
    const normals = entry.normals;
    while (this.geometryCursor < total && consumed < budget) {
      if (this.geometryCursor + 2 < positions.length) {
        this.point.set(positions[this.geometryCursor], positions[this.geometryCursor + 1], positions[this.geometryCursor + 2]);
        this.point.applyMatrix4(entry.object.matrixWorld);
        let upward = true;
        if (normals != null && this.geometryCursor + 2 < normals.length) {
          this.surfaceNormal.set(normals[this.geometryCursor], normals[this.geometryCursor + 1], normals[this.geometryCursor + 2]);
          this.surfaceNormal.applyMatrix3(this.normalMatrix);
          upward = this.surfaceNormal.y >= UPWARD_NORMAL_Y;
        }
        // Skip the mesh's own downward-facing geometry (ceilings, wall backs).
        if (upward) this.record(this.point.x, this.point.y, this.point.z);
      }
      this.geometryCursor += step;
      consumed += step;
    }
    return consumed;
  }

  /** Keep the highest upward surface per grid cell. */
  private record(x: number, y: number, z: number): void {
    const col = Math.floor((x - this.gridMinX) / GRID_CELL);
    const row = Math.floor((z - this.gridMinZ) / GRID_CELL);
    if (col < 0 || row < 0 || col >= this.gridCols || row >= this.gridRows) return;
    const index = row * this.gridCols + col;
    const previous = this.grid[index];
    if (!Number.isFinite(previous) || y > previous) this.grid[index] = y;
  }

  private reset(): void {
    this.min.set(-FALLBACK_HALF_XZ, 0, -FALLBACK_HALF_XZ);
    this.max.set(FALLBACK_HALF_XZ, FALLBACK_HEIGHT, FALLBACK_HALF_XZ);
    this.hasSurfaces = false;
    this.building = false;
    this.entries = [];
    this.entryIndex = 0;
    this.geometryCursor = 0;
    this.grid = new Float32Array(0);
    this.gridCols = 0;
    this.gridRows = 0;
  }

  /**
   * Highest detected surface at column (x, z) at or below `belowY`.
   * Returns null outside the grid, over unmapped cells, or when the mapped
   * surface is above the query point.
   */
  surfaceHeightAt(x: number, z: number, belowY: number): number | null {
    if (!this.hasSurfaces || this.gridCols === 0) return null;
    const col = Math.floor((x - this.gridMinX) / GRID_CELL);
    const row = Math.floor((z - this.gridMinZ) / GRID_CELL);
    if (col < 0 || row < 0 || col >= this.gridCols || row >= this.gridRows) return null;
    const height = this.grid[row * this.gridCols + col];
    if (!Number.isFinite(height) || height > belowY) return null;
    return height;
  }
}

/** App-wide singleton; rebuilt by RoomSensingSystem, read by the visuals. */
export const roomModel = new RoomModel();
