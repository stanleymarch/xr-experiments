/**
 * WEATHER//ROOM room model: coarse surface knowledge built from real-world
 * XR geometry (planes/meshes reported by the built-in SceneUnderstanding
 * system). Particle systems consume `bounds` (placement volume) and
 * `surfaceHeightAt` (splash/thermal anchoring).
 */

import { Box3, Matrix3, Raycaster, Vector3 } from '@iwsdk/core';
import type { Object3D } from '@iwsdk/core';

/** Coarse height-grid cell size in meters. */
const GRID_CELL = 0.25;
/** Half-extent of the fallback volume (3 x 2.5 x 3 m box). */
const FALLBACK_HALF_XZ = 1.5;
const FALLBACK_HEIGHT = 2.5;
/** Ray origin height above the tallest known surface during rebuilds. */
const RAY_CLEARANCE = 2;

const DOWN = new Vector3(0, -1, 0);

/**
 * Shared room knowledge. Owned (rebuilt) by RoomSensingSystem; every other
 * system only reads. Until the first plane/mesh qualifies, `hasSurfaces` is
 * false and readers must use the default box (splash fallback in IWER).
 */
class RoomModel {
  /** Placement volume. Defaults to a 3 x 2.5 x 3 m box around the origin. */
  readonly min = new Vector3(-FALLBACK_HALF_XZ, 0, -FALLBACK_HALF_XZ);
  readonly max = new Vector3(FALLBACK_HALF_XZ, FALLBACK_HEIGHT, FALLBACK_HALF_XZ);
  /** False until the first XRPlane/XRMesh qualifies. */
  hasSurfaces = false;

  private readonly raycaster = new Raycaster();
  private readonly box = new Box3();
  private readonly normalMatrix = new Matrix3();
  private readonly surfaceNormal = new Vector3();
  private readonly origin = new Vector3();
  // Coarse top-surface height grid over [gridMinX, ...] (NaN = no hit).
  private grid = new Float32Array(0);
  private gridCols = 0;
  private gridRows = 0;
  private gridMinX = 0;
  private gridMinZ = 0;

  /**
   * Rebuild bounds + height grid from the currently tracked surface objects.
   * Runs at most twice per second on detection changes — never per frame.
   */
  rebuild(objects: readonly Object3D[]): void {
    if (objects.length === 0) {
      this.min.set(-FALLBACK_HALF_XZ, 0, -FALLBACK_HALF_XZ);
      this.max.set(FALLBACK_HALF_XZ, FALLBACK_HEIGHT, FALLBACK_HALF_XZ);
      this.hasSurfaces = false;
      this.grid = new Float32Array(0);
      this.gridCols = 0;
      this.gridRows = 0;
      return;
    }
    this.box.makeEmpty();
    for (const object of objects) this.box.expandByObject(object);
    if (this.box.isEmpty()) return;
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
    const topY = this.max.y + RAY_CLEARANCE;
    const targets = objects as Object3D[];
    for (let row = 0; row < this.gridRows; row += 1) {
      for (let col = 0; col < this.gridCols; col += 1) {
        const x = this.gridMinX + (col + 0.5) * GRID_CELL;
        const z = this.gridMinZ + (row + 0.5) * GRID_CELL;
        this.origin.set(x, topY, z);
        this.raycaster.set(this.origin, DOWN);
        this.raycaster.far = topY - this.min.y + 1;
        const hits = this.raycaster.intersectObjects(targets, true);
        for (const hit of hits) {
          if (hit.face == null) continue;
          this.normalMatrix.getNormalMatrix(hit.object.matrixWorld);
          this.surfaceNormal.copy(hit.face.normal).applyMatrix3(this.normalMatrix);
          // Keep upward-facing surfaces (floors, tabletops), not downward-facing ceilings.
          if (this.surfaceNormal.y >= 0.5) {
            this.grid[row * this.gridCols + col] = hit.point.y;
            break;
          }
        }
      }
    }
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
