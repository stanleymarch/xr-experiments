/**
 * XR geometry (planes/meshes reported by the built-in SceneUnderstanding
 * system), plus head-anchored hit-test probe points when no plane or mesh
 * is tracked (see DepthSamplingSystem). Particle systems consume `bounds`
 * (placement volume) and `surfaceHeightAt` (splash/thermal anchoring).
 *
 * Cost model: triangle interiors are rasterized into a 25 cm height grid.
 * Triangle setup and cell tests share a 4096-work-unit budget per frame;
 * large planes resume mid-triangle. No per-particle or per-cell mesh raycasts.
 *
 * Hit-test probes (no planes/meshes) record at most one small lattice per
 * 0.5 s tick — no raycast storm either way.
 *
 * Viewer anchoring: a reported room mesh can sit far from the viewer (stale
 * or drifting tracking frame). Without anchoring, every particle system seeds
 * its field inside a volume the viewer never sees while the panel still shows
 * nonzero drivers. The capped volume therefore grows toward the tracked
 * viewer within its cap; distant geometry uses a head-centered fallback.
 */

import { Box3, Vector3 } from '@iwsdk/core';
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
/** Bound triangle setup and raster-cell tests together on every build step. */
const SURFACE_WORK_PER_STEP = 4096;
/** Minimum world-space normal.y for a face to count as an upward surface. */
const UPWARD_NORMAL_Y = 0.5;

type SurfaceEntry = {
  /** Owner of the geometry; carries the world matrix used for sampling. */
  readonly object: Object3D;
  readonly positions: ArrayLike<number> | null;
  readonly indices: ArrayLike<number> | null;
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
  private readonly surfaceNormal = new Vector3();
  private readonly triangleA = new Vector3();
  private readonly triangleB = new Vector3();
  private readonly triangleC = new Vector3();
  private readonly triangleEdge = new Vector3();
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
  private geometryCursor = 0;
  private triangleReady = false;
  private rasterCol = 0;
  private rasterRow = 0;
  private rasterMinCol = 0;
  private rasterMaxCol = -1;
  private rasterMaxRow = -1;
  private triangleDenominator = 0;

  /** Probe hits are not mesh ownership; the sampler must keep collecting. */
  get hasMeshSurfaces(): boolean {
    return this.hasSurfaces && !this.probing;
  }

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
    this.geometryCursor = 0;
    this.triangleReady = false;
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
      const indices = geometry?.index?.array ?? null;
      if (positions == null) continue;
      this.entries.push({ object, positions, indices });
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
    let budget = SURFACE_WORK_PER_STEP;
    while (budget > 0 && this.entryIndex < this.entries.length) {
      const entry = this.entries[this.entryIndex];
      const consumed = this.consumeEntry(entry, budget);
      budget -= consumed;
      if (this.geometryCursor >= this.entryLength(entry)) {
        this.entryIndex += 1;
        this.geometryCursor = 0;
        this.triangleReady = false;
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
    return entry.indices?.length ?? (entry.positions?.length ?? 0) / 3;
  }

  /** Rasterize actual triangle interiors, not just vertices at plane corners.
   * Every triangle setup and cell test consumes the same bounded work budget. */
  private consumeEntry(entry: SurfaceEntry, budget: number): number {
    const positions = entry.positions!;
    const total = this.entryLength(entry);
    let consumed = 0;
    while (this.geometryCursor + 2 < total && consumed < budget) {
      if (!this.triangleReady) {
        consumed += 1;
        const ia = (entry.indices?.[this.geometryCursor] ?? this.geometryCursor) * 3;
        const ib = (entry.indices?.[this.geometryCursor + 1] ?? this.geometryCursor + 1) * 3;
        const ic = (entry.indices?.[this.geometryCursor + 2] ?? this.geometryCursor + 2) * 3;
        this.triangleA.set(positions[ia], positions[ia + 1], positions[ia + 2]).applyMatrix4(entry.object.matrixWorld);
        this.triangleB.set(positions[ib], positions[ib + 1], positions[ib + 2]).applyMatrix4(entry.object.matrixWorld);
        this.triangleC.set(positions[ic], positions[ic + 1], positions[ic + 2]).applyMatrix4(entry.object.matrixWorld);
        const a = this.triangleA, b = this.triangleB, c = this.triangleC;
        this.surfaceNormal.subVectors(b, a);
        this.triangleEdge.subVectors(c, a);
        this.surfaceNormal.cross(this.triangleEdge).normalize();
        if (this.surfaceNormal.y < UPWARD_NORMAL_Y) {
          this.geometryCursor += 3;
          continue;
        }
        // Tiny triangles may contain no grid center; their vertices still
        // contribute real heights rather than disappearing from the grid.
        this.record(a.x, a.y, a.z);
        this.record(b.x, b.y, b.z);
        this.record(c.x, c.y, c.z);
        this.triangleDenominator = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
        this.rasterMinCol = Math.max(0, Math.floor((Math.min(a.x, b.x, c.x) - this.gridMinX) / GRID_CELL));
        this.rasterMaxCol = Math.min(this.gridCols - 1, Math.floor((Math.max(a.x, b.x, c.x) - this.gridMinX) / GRID_CELL));
        this.rasterRow = Math.max(0, Math.floor((Math.min(a.z, b.z, c.z) - this.gridMinZ) / GRID_CELL));
        this.rasterMaxRow = Math.min(this.gridRows - 1, Math.floor((Math.max(a.z, b.z, c.z) - this.gridMinZ) / GRID_CELL));
        this.rasterCol = this.rasterMinCol;
        if (Math.abs(this.triangleDenominator) < 1e-10 || this.rasterMinCol > this.rasterMaxCol || this.rasterRow > this.rasterMaxRow) {
          this.geometryCursor += 3;
          continue;
        }
        this.triangleReady = true;
      }
      const a = this.triangleA, b = this.triangleB, c = this.triangleC;
      while (this.rasterRow <= this.rasterMaxRow && consumed < budget) {
        const x = this.gridMinX + (this.rasterCol + 0.5) * GRID_CELL;
        const z = this.gridMinZ + (this.rasterRow + 0.5) * GRID_CELL;
        const u = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / this.triangleDenominator;
        const v = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / this.triangleDenominator;
        if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6) {
          this.record(x, u * a.y + v * b.y + (1 - u - v) * c.y, z);
        }
        consumed += 1;
        this.rasterCol += 1;
        if (this.rasterCol > this.rasterMaxCol) {
          this.rasterCol = this.rasterMinCol;
          this.rasterRow += 1;
        }
      }
      if (this.rasterRow > this.rasterMaxRow) {
        this.geometryCursor += 3;
        this.triangleReady = false;
      }
    }
    // Skip incomplete trailing data rather than leaving a build pending.
    if (this.geometryCursor + 2 >= total) this.geometryCursor = total;
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
    const rainTop = this.anchorPos.y + 1;
    if (rainTop > this.max.y) {
      if (rainTop - this.min.y > MAX_SPAN_Y) this.min.y = rainTop - MAX_SPAN_Y;
      this.max.y = rainTop;
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
    this.triangleReady = false;
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
