/**
 * XR geometry (planes/meshes reported by the built-in SceneUnderstanding
 * system), plus head-anchored hit-test probe points when no plane or mesh
 * is tracked (see DepthSamplingSystem). Particle systems consume `bounds`
 * (placement volume) and `surfaceHeightAt` (splash/thermal anchoring).
 *
 * Cost model (device-critical): the height grid is filled from a bounded
 * vertex sample per frame instead of per-cell raycasts. A real room mesh has
 * hundreds of thousands of vertices; raycasting every grid cell against every
 * surface is O(cells x triangles) on the main thread and freezes the headset
 * during VR entry, when mesh detection first delivers geometry. Sampling
 * vertices is O(vertices) once, spread over frames, and never blocks a frame.

 * Hit-test probes (no planes/meshes) record at most one small lattice per
 * 0.5 s tick — no raycast storm either way.
 *
 * Viewer anchoring: a reported room mesh can sit far from the viewer (stale
 * or drifting tracking frame). Without anchoring, every particle system seeds
 * its field inside a volume the viewer never sees while the panel still shows
 * nonzero drivers. The capped volume is therefore translated to contain the
 * given viewer anchor (the XR head position) — translated, never inflated.
 */

import { Box3, Matrix3, Vector3 } from '@iwsdk/core';
import type { BufferGeometry, Object3D } from '@iwsdk/core';

/** Coarse height-grid cell size in meters. */
const GRID_CELL = 0.25;
/** Half-extent of the fallback volume (3 x 2.5 x 3 m box). */
const FALLBACK_HALF_XZ = 1.5;
const FALLBACK_HEIGHT = 2.5;
/** Capped volume span: beyond a real room, particles spread invisible-thin
 * and a 25 cm grid is meaningless. Far mesh geometry must not enlarge it. */
const MAX_SPAN_XZ = 8;
const MAX_SPAN_Y = 4;
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

  /** True while hit-test probe sampling owns the volume (no mesh knowledge). */
  private probing = false;
  private readonly box = new Box3();
  private readonly normalMatrix = new Matrix3();
  private readonly surfaceNormal = new Vector3();
  private readonly point = new Vector3();
  private readonly corner = new Vector3();
  private readonly anchorPos = new Vector3();
  private hasAnchor = false;
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
   * filled incrementally by `step()`. When `anchor` (viewer head position) is
   * supplied, the capped volume is translated so it contains the anchor.
   */
  beginRebuild(objects: readonly Object3D[], anchor?: Vector3): void {
    this.building = false;
    // Mesh/plane knowledge always wins: a real rebuild ends probe ownership.
    this.probing = false;
    this.entries = [];
    this.entryIndex = 0;
    this.componentCursor = 0;
    this.geometryCursor = 0;
    this.hasAnchor = anchor != null;
    if (anchor != null) this.anchorPos.copy(anchor);
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
    // Keep the volume sane: a sensed plane has zero thickness — snap the
    // thin axis to the plane (a 0.5 m floor slab would bury every mapped cell
    // under the volume floor and blind surfaceHeightAt queries).
    if (this.max.y - this.min.y < 0.5) this.min.y = this.max.y;
    // Cap the span around the box center: distant mesh outliers must not
    // stretch the weather volume into an invisible thin haze.
    for (const axis of ['x', 'z'] as const) {
      const span = this.max[axis] - this.min[axis];
      if (span > MAX_SPAN_XZ) {
        const center = (this.max[axis] + this.min[axis]) / 2;
        this.min[axis] = center - MAX_SPAN_XZ / 2;
        this.max[axis] = center + MAX_SPAN_XZ / 2;
      }
    }
    if (this.max.y - this.min.y > MAX_SPAN_Y) {
      const centerY = (this.max.y + this.min.y) / 2;
      this.min.y = centerY - MAX_SPAN_Y / 2;
      this.max.y = centerY + MAX_SPAN_Y / 2;
    }
    // The weather happens around the viewer: a mesh box reported far from the
    // head would otherwise strand every particle system out of sight.
    // Anchor BEFORE the grid is allocated: shifting the volume after the grid
    // is filled would orphan every mapped cell (the live-XR empty-sky defect
    // in a second form — a volume around the head with no floor knowledge).
    // When the mesh is too far for the capped span to cover both mesh and
    // head, the distant geometry is useless as local surface knowledge:
    // serve the viewer with the head-centered fallback instead.
    if (this.hasAnchor) {
      this.containAnchor();
      if (!this.contains(this.anchorPos)) {
        this.reset();
        return;
      }
    }
    this.hasSurfaces = true;
    this.allocateGrid();

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
    if (!this.building) {
      // Nothing sampleable arrived: keep the compact fallback volume instead
      // of claiming an empty giant box.
      this.reset();
    }
  }

  /**
   * Anchor the compact fallback volume at the head and allocate a fresh
   * height grid for hit-test probe points. Refuses (false) while mesh/plane
   * knowledge owns the model, so probes never fight the mesh path. While
   * probing, a contained anchor keeps already-sampled cells; only a head
   * that left the volume re-anchors (stale cells are dropped with it).
   */
  beginProbeVolume(anchor: Vector3): boolean {
    if (this.building) return false;
    if (this.hasSurfaces && !this.probing) return false;
    if (this.probing && this.contains(anchor)) {
      this.anchorPos.copy(anchor);
      return true;
    }
    this.hasAnchor = true;
    this.anchorPos.copy(anchor);
    this.min.set(anchor.x - FALLBACK_HALF_XZ, 0, anchor.z - FALLBACK_HALF_XZ);
    this.max.set(anchor.x + FALLBACK_HALF_XZ, FALLBACK_HEIGHT, anchor.z + FALLBACK_HALF_XZ);
    this.hasSurfaces = false;
    this.allocateGrid();
    this.probing = true;
    return true;
  }

  /**
   * Record one measured hit-test surface point into the probe grid. The
   * first mapped cell flips `hasSurfaces`: probe knowledge is only ever
   * claimed from points the session actually measured, never faked.
   */
  recordProbePoint(x: number, y: number, z: number): void {
    if (!this.probing || this.gridCols === 0) return;
    if (this.record(x, y, z)) this.hasSurfaces = true;
  }

  /**
   * Release probe ownership: back to today's fallback box with no claimed
   * surfaces. No-op unless probing (a mesh rebuild already ended it).
   */
  endProbing(): void {
    if (!this.probing) return;
    this.probing = false;
    this.reset();
  }

  /** Allocate (or reuse) the height grid over the current min/max. */
  private allocateGrid(): void {
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
      // Knowledge without a single mapped cell is useless: fall back to the
      // compact default volume rather than an empty detected box.
      let mapped = false;
      for (let i = 0; i < this.grid.length; i += 1) {
        if (Number.isFinite(this.grid[i])) { mapped = true; break; }
      }
      if (!mapped) this.reset();
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

  /** Keep the highest upward surface per grid cell. Returns false when out of range. */
  private record(x: number, y: number, z: number): boolean {
    const col = Math.floor((x - this.gridMinX) / GRID_CELL);
    const row = Math.floor((z - this.gridMinZ) / GRID_CELL);
    if (col < 0 || row < 0 || col >= this.gridCols || row >= this.gridRows) return false;
    const index = row * this.gridCols + col;
    const previous = this.grid[index];
    if (!Number.isFinite(previous) || y > previous) this.grid[index] = y;
    return true;
  }

  /** True when the placement volume contains the point (viewer tracking). */
  contains(point: Vector3): boolean {
    return (
      point.x >= this.min.x && point.x <= this.max.x &&
      point.y >= this.min.y && point.y <= this.max.y &&
      point.z >= this.min.z && point.z <= this.max.z
    );
  }

  /**
   * Grow the capped volume toward the viewer anchor, never translating the
   * sensed surfaces out of it: mapped grid cells stay valid because the
   * volume only expands (up to the span cap), it never shifts away from the
   * mesh. When the mesh is too far for the capped span to cover both, the
   * caller falls back to the head-centered volume instead of an empty box.
   */
  private containAnchor(): void {
    for (const axis of ['x', 'z'] as const) {
      if (this.anchorPos[axis] < this.min[axis]) {
        this.min[axis] = Math.max(this.anchorPos[axis], this.max[axis] - MAX_SPAN_XZ);
      } else if (this.anchorPos[axis] > this.max[axis]) {
        this.max[axis] = Math.min(this.anchorPos[axis], this.min[axis] + MAX_SPAN_XZ);
      }
    }
    // Vertical: extend toward the head within the span cap so the sensed
    // floor anchor survives; only shift off the floor when the cap forces it.
    if (this.anchorPos.y > this.max.y) {
      if (this.anchorPos.y - this.min.y > MAX_SPAN_Y) this.min.y = this.anchorPos.y - MAX_SPAN_Y;
      this.max.y = this.anchorPos.y;
    } else if (this.anchorPos.y < this.min.y) {
      if (this.max.y - this.anchorPos.y > MAX_SPAN_Y) this.max.y = this.anchorPos.y + MAX_SPAN_Y;
      this.min.y = this.anchorPos.y;
    }
  }

  private reset(): void {
    if (this.hasAnchor) {
      // Head-centered compact fallback: the mesh contributed no mappable
      // surface, so seed around the viewer instead of the world origin.
      this.min.set(this.anchorPos.x - FALLBACK_HALF_XZ, 0, this.anchorPos.z - FALLBACK_HALF_XZ);
      this.max.set(this.anchorPos.x + FALLBACK_HALF_XZ, FALLBACK_HEIGHT, this.anchorPos.z + FALLBACK_HALF_XZ);
    } else {
      this.min.set(-FALLBACK_HALF_XZ, 0, -FALLBACK_HALF_XZ);
      this.max.set(FALLBACK_HALF_XZ, FALLBACK_HEIGHT, FALLBACK_HALF_XZ);
    }
    this.hasSurfaces = false;
    this.building = false;
    this.entries = [];
    this.entryIndex = 0;
    this.geometryCursor = 0;
    this.componentCursor = 0;
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
