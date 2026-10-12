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
 *
 * Rebuild continuity: a mesh-to-mesh rebuild snapshots the finished grid
 * first, so queries keep answering from the snapshot while the incremental
 * build refills (remaps and late plane/mesh data never flash the floor
 * away). A rebuild that maps nothing restores the snapshot instead of
 * claiming an empty box; only an empty surface set clears knowledge.
 * Probe hits are kept as a bounded ring so puddles can sit on the measured
 * patch instead of random floor. Unmapped/out-of-range columns always read
 * null — never measured, never the fallback elevation.
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
/** Minimum world-space |normal.y| for a face to count as a horizontal surface. */
const HORIZONTAL_NORMAL_Y = 0.5;
/** Bounded horizontal height layers kept per grid cell, sorted ascending.
 * Four covers floor + table + tall furniture + shell top without unbounded
 * growth; insert-sorted, deduplicated, allocated only on grid (re)build. */
const LAYERS_PER_CELL = 4;
/** Heights closer than this merge into one layer (same physical surface). */
const LAYER_MERGE_M = 0.04;
/** Distinct measured probe hits retained for puddle placement. */
export const PROBE_HIT_CAPACITY = 16;
/** A repeat hit inside this radius refreshes nothing (same patch). */
const PROBE_HIT_MIN_SEP_M = 0.2;
/** Mapped floor cells copied per puddle reseed (xz pairs). */
export const FLOOR_CELL_COPY_MAX = 64;

/**
 * Extra plane-space correction carried on a tracked surface object. The
 * framework builds plane meshes as origin-centered boxes spanning the polygon
 * extents, so an off-center polygon's extents center must be added before
 * the world transform. Centered polygons yield ~0 (no-op); mesh vertices are
 * already mesh-space exact (use 0).
 */
export interface RoomSurfaceSource extends Object3D {
  /** Plane-polygon centroid in surface-local meters (x). */
  offsetX?: number;
  /** Plane-polygon centroid in surface-local meters (z). */
  offsetZ?: number;
}

type SurfaceEntry = {
  /** Owner of the geometry; carries the world matrix used for sampling. */
  readonly object: Object3D;
  readonly positions: ArrayLike<number> | null;
  readonly indices: ArrayLike<number> | null;
  offsetX: number;
  offsetZ: number;
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
  private readonly shiftedBox = new Box3();
  private readonly planeOffset = new Vector3();
  private readonly surfaceNormal = new Vector3();
  private readonly triangleA = new Vector3();
  private readonly triangleB = new Vector3();
  private readonly triangleC = new Vector3();
  private readonly triangleEdge = new Vector3();
  private readonly anchorPos = new Vector3();
  private hasAnchor = false;
  // Coarse layered height grid over [gridMinX, ...] (NaN = no hit): each cell
  // keeps up to LAYERS_PER_CELL sorted ascending heights, so a table layer
  // never evicts the floor layer beneath it and the shell top never hides
  // either. No ceiling heuristic: queries pick the right layer generically.
  private layers = new Float32Array(0);
  private layerCounts = new Uint8Array(0);
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
  /** Last finished grid: answers queries while a rebuild refills live. Stale
   * by design after remaps — spatially keyed, so it only answers where the
   * user has already been, never in newly entered space. */
  private snapLayers = new Float32Array(0);
  private snapCounts = new Uint8Array(0);
  private snapCols = 0;
  private snapRows = 0;
  private snapMinX = 0;
  private snapMinZ = 0;
  private readonly snapMin = new Vector3();
  private readonly snapMax = new Vector3();
  private snapHas = false;
  private snapProbing = false;
  /** True while the live grid holds servable knowledge (finished mesh build
   * with mapped cells, or at least one probe record). */
  private liveFinished = false;
  /** Bounded ring of distinct measured probe hits (x/y/z triples). */
  private readonly probeHits = new Float32Array(PROBE_HIT_CAPACITY * 3);
  private probeHitCount = 0;
  private probeCursor = 0;
  /** Bumped on every finished mesh build with mapped cells. */
  meshRevision = 0;
  /** Bumped on every distinct probe hit and every probe-ring reset. */
  probeRevision = 0;

  /** Probe hits are not mesh ownership; the sampler must keep collecting. */
  get hasMeshSurfaces(): boolean {
    return this.hasSurfaces && !this.probing && !this.building && this.liveFinished;
  }

  /**
   * Compact honest surface state for status notices: 'mesh' = measured
   * plane/mesh layers, 'probe' = sparse measured hit-test patch only,
   * 'pending' = sensing with no servable knowledge yet, 'none' = no live
   * knowledge (a stale snapshot may still answer behind the user).
   * Never imply a whole room from a probe patch.
   */
  roomSurfaceStatus(): 'mesh' | 'probe' | 'pending' | 'none' {
    if (this.building) return 'pending';
    if (this.hasMeshSurfaces) return 'mesh';
    if (this.probing) return this.hasSurfaces ? 'probe' : 'pending';
    return this.hasSurfaces ? 'mesh' : 'none';
  }

  /**
   * Start a rebuild from the currently tracked surface objects. Bounds are
   * computed immediately (cheap, bounding-box based); the height grid is then
   * filled incrementally by `step()`. When `anchor` (viewer head position) is
   * supplied, the capped volume is translated so it contains the anchor.
   * The finished grid is snapshotted first, so queries stay warm while the
   * refill runs; a remap that yields no mapped cells restores the snapshot.
   * Child meshes are sampled (for semantic room shells), while a supplied
   * plane centroid recenters off-center polygon-frame geometry.
   */
  beginRebuild(objects: readonly Object3D[], anchor?: Vector3): void {
    this.building = false;
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
    // Snapshot whatever was servable: an empty surface set clears (with a
    // head-anchored fallback for the viewer), but a live empty remap must
    // never zero or orphan what the room already measured.
    this.snapshotLive();
    // Retain probe records until a mesh build actually maps support.
    this.probing = false;
    this.box.makeEmpty();
    for (const object of objects) {
      const source: RoomSurfaceSource = object;
      const geometry = (object as Object3D & { geometry?: BufferGeometry }).geometry;
      if (geometry != null && (source.offsetX || source.offsetZ)) {
        object.updateWorldMatrix(true, false);
        if (geometry.boundingBox == null) geometry.computeBoundingBox();
        if (geometry.boundingBox != null) {
          this.planeOffset.set(source.offsetX ?? 0, 0, source.offsetZ ?? 0);
          this.shiftedBox.copy(geometry.boundingBox).translate(this.planeOffset).applyMatrix4(object.matrixWorld);
          this.box.union(this.shiftedBox);
        }
        for (const child of object.children) this.box.expandByObject(child);
      } else this.box.expandByObject(object);
    }
    if (this.box.isEmpty()) {
      this.restoreSnapshot();
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
        this.restoreSnapshot();
        return;
      }
    }
    this.hasSurfaces = true;
    this.allocateGrid();

    for (const object of objects) {
      const source: RoomSurfaceSource = object;
      const offsetX = typeof source.offsetX === 'number' ? source.offsetX : 0;
      const offsetZ = typeof source.offsetZ === 'number' ? source.offsetZ : 0;
      this.collectEntry(object, offsetX, offsetZ);
      for (const child of object.children) this.collectEntry(child, 0, 0);
    }
    this.building = this.entries.length > 0;
    if (!this.building) {
      // Nothing sampleable arrived: restore what was measured instead of
      // claiming an empty giant box.
      this.restoreSnapshot();
    }
  }

  /** Sample one object when it carries BufferGeometry; offset pre-applied. */
  private collectEntry(object: Object3D, offsetX: number, offsetZ: number): void {
    object.updateWorldMatrix(true, false);
    const holder: unknown = object;
    const geometry = holder != null && typeof holder === 'object' && 'geometry' in holder
      ? (holder.geometry as BufferGeometry | undefined)
      : undefined;
    const positions = geometry?.getAttribute?.('position')?.array ?? null;
    const indices = geometry?.index?.array ?? null;
    if (positions == null) return;
    this.entries.push({ object, positions, indices, offsetX, offsetZ });
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
    this.setFallbackBounds();
    this.hasSurfaces = false;
    this.allocateGrid();
    this.clearProbeHits();
    this.probing = true;
    return true;
  }

  /** Drop the bounded probe ring (volume abandoned or mesh took over). */
  private clearProbeHits(): void {
    this.probeHitCount = 0;
    this.probeCursor = 0;
    this.probeRevision += 1;
  }

  /**
   * Record one measured hit-test surface point into the probe grid. The
   * first mapped cell flips `hasSurfaces`: probe knowledge is only ever
   * claimed from points the session actually measured, never faked.
   * Distinct hits are also kept in a bounded ring for puddle placement.
   */
  recordProbePoint(x: number, y: number, z: number): void {
    if (!this.probing || this.gridCols === 0) return;
    if (!this.record(x, y, z)) return;
    // Reference-space drift can put measured ground below y=0. It must
    // remain reachable by falling drops, not below their recycle boundary.
    if (y < this.min.y && this.anchorPos.y - y <= MAX_SPAN_Y) {
      this.min.y = y;
      this.max.y = Math.min(this.max.y, y + MAX_SPAN_Y);
    }
    this.hasSurfaces = true;
    this.liveFinished = true;
    for (let i = 0; i < this.probeHitCount; i += 1) {
      const dx = this.probeHits[i * 3] - x;
      const dy = this.probeHits[i * 3 + 1] - y;
      const dz = this.probeHits[i * 3 + 2] - z;
      if (dx * dx + dy * dy + dz * dz < PROBE_HIT_MIN_SEP_M * PROBE_HIT_MIN_SEP_M) return;
    }
    const slot = this.probeHitCount < PROBE_HIT_CAPACITY
      ? this.probeHitCount++
      : this.probeCursor;
    this.probeHits[slot * 3] = x;
    this.probeHits[slot * 3 + 1] = y;
    this.probeHits[slot * 3 + 2] = z;
    if (this.probeHitCount >= PROBE_HIT_CAPACITY) this.probeCursor = (slot + 1) % PROBE_HIT_CAPACITY;
    this.probeRevision += 1;
  }

  /** Distinct measured probe hits, oldest-first, as x/y/z triples. */
  copyProbeHits(target: Float32Array): number {
    const count = Math.min(this.probeHitCount, PROBE_HIT_CAPACITY);
    const take = Math.min(count, Math.floor(target.length / 3));
    const start = count < PROBE_HIT_CAPACITY ? 0 : this.probeCursor;
    for (let i = 0; i < take; i += 1) {
      const from = ((start + i) % PROBE_HIT_CAPACITY) * 3;
      target[i * 3] = this.probeHits[from];
      target[i * 3 + 1] = this.probeHits[from + 1];
      target[i * 3 + 2] = this.probeHits[from + 2];
    }
    return take;
  }

  /**
   * Copy mapped floor-cell centers (xz pairs + their lowest heights into
   * the parallel array) for hit-backed puddle reseeds. Caps at
   * FLOOR_CELL_COPY_MAX; returns the copied count.
   */
  copyMappedFloorCells(xz: Float32Array, heights: Float32Array): number {
    if (!this.hasSurfaces || this.gridCols === 0) return 0;
    const cells = this.gridCols * this.gridRows;
    let occupied = 0;
    for (let cell = 0; cell < cells; cell += 1) {
      if (this.layerCounts[cell] > 0) occupied += 1;
    }
    const take = Math.min(occupied, FLOOR_CELL_COPY_MAX, Math.floor(xz.length / 2), heights.length);
    let copied = 0;
    let seen = 0;
    for (let cell = 0; cell < cells && copied < take; cell += 1) {
      if (this.layerCounts[cell] === 0) continue;
      if (seen++ < Math.floor(copied * occupied / take)) continue;
      const col = cell % this.gridCols;
      const row = Math.floor(cell / this.gridCols);
      xz[copied * 2] = this.gridMinX + (col + 0.5) * GRID_CELL;
      xz[copied * 2 + 1] = this.gridMinZ + (row + 0.5) * GRID_CELL;
      heights[copied] = this.layers[cell * LAYERS_PER_CELL];
      copied += 1;
    }
    return copied;
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

  /** Allocate (or reuse) the layered height grid over the current min/max. */
  private allocateGrid(): void {
    const spanX = Math.max(GRID_CELL, this.max.x - this.min.x);
    const spanZ = Math.max(GRID_CELL, this.max.z - this.min.z);
    this.gridCols = Math.max(1, Math.ceil(spanX / GRID_CELL));
    this.gridRows = Math.max(1, Math.ceil(spanZ / GRID_CELL));
    this.gridMinX = this.min.x;
    this.gridMinZ = this.min.z;
    const cells = this.gridCols * this.gridRows;
    if (this.layers.length !== cells * LAYERS_PER_CELL) {
      this.layers = new Float32Array(cells * LAYERS_PER_CELL);
      this.layerCounts = new Uint8Array(cells);
    }
    this.layers.fill(Number.NaN);
    this.layerCounts.fill(0);
    this.liveFinished = false;
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
      // A remap that yields no mapped cells restores the snapshot instead
      // of zeroing wetness or orphaning the floor; only a first-ever empty
      // scan falls back to the compact default volume.
      let mapped = false;
      for (let i = 0; i < this.layerCounts.length; i += 1) {
        if (this.layerCounts[i] > 0) { mapped = true; break; }
      }
      if (mapped) {
        this.probing = false;
        this.clearProbeHits();
        this.hasSurfaces = true;
        this.liveFinished = true;
        this.meshRevision += 1;
        this.snapshotLive();
      } else this.restoreSnapshot();
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
        this.triangleA.set(positions[ia] + entry.offsetX, positions[ia + 1], positions[ia + 2] + entry.offsetZ).applyMatrix4(entry.object.matrixWorld);
        this.triangleB.set(positions[ib] + entry.offsetX, positions[ib + 1], positions[ib + 2] + entry.offsetZ).applyMatrix4(entry.object.matrixWorld);
        this.triangleC.set(positions[ic] + entry.offsetX, positions[ic + 1], positions[ic + 2] + entry.offsetZ).applyMatrix4(entry.object.matrixWorld);
        const a = this.triangleA, b = this.triangleB, c = this.triangleC;
        this.surfaceNormal.subVectors(b, a);
        this.triangleEdge.subVectors(c, a);
        this.surfaceNormal.cross(this.triangleEdge).normalize();
        if (Math.abs(this.surfaceNormal.y) < HORIZONTAL_NORMAL_Y) {
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

  /**
   * Insert y into the cell's sorted layer list, merging near-equal heights.
   * Accepts both windings: enclosed shells expose their lowest level as a
   * downward face. Up to four distinct levels are retained; fuller cells
   * use the bounded eviction policy below. Returns false when out of range.
   */
  private record(x: number, y: number, z: number): boolean {
    const col = Math.floor((x - this.gridMinX) / GRID_CELL);
    const row = Math.floor((z - this.gridMinZ) / GRID_CELL);
    if (col < 0 || row < 0 || col >= this.gridCols || row >= this.gridRows) return false;
    const cell = row * this.gridCols + col;
    const base = cell * LAYERS_PER_CELL;
    const count = this.layerCounts[cell];
    for (let i = 0; i < count; i += 1) {
      if (Math.abs(this.layers[base + i] - y) < LAYER_MERGE_M) return true;
    }
    if (count >= LAYERS_PER_CELL) {
      // Cell full: keep the span representative. A new extreme evicts the
      // far extreme (new low drops the high, new high drops the second-high
      // so the lowest level survives); a mid height is dropped. No allocation.
      const lo = this.layers[base];
      const hi = this.layers[base + count - 1];
      if (y < lo - LAYER_MERGE_M) {
        for (let i = count - 1; i > 0; i -= 1) this.layers[base + i] = this.layers[base + i - 1];
        this.layers[base] = y;
      } else if (y > hi + LAYER_MERGE_M) {
        // New highest: drop the second-highest, keeping the lowest level,
        // the mid layers (tables), the old top, and the new top.
        this.layers[base + count - 2] = this.layers[base + count - 1];
        this.layers[base + count - 1] = y;
      }
      return true;
    }
    // Sorted insert into the bounded slot range.
    let at = count;
    while (at > 0 && this.layers[base + at - 1] > y) {
      this.layers[base + at] = this.layers[base + at - 1];
      at -= 1;
    }
    this.layers[base + at] = y;
    this.layerCounts[cell] = count + 1;
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

  private setFallbackBounds(): void {
    const x = this.hasAnchor ? this.anchorPos.x : 0;
    const z = this.hasAnchor ? this.anchorPos.z : 0;
    this.min.set(x - FALLBACK_HALF_XZ, 0, z - FALLBACK_HALF_XZ);
    this.max.set(x + FALLBACK_HALF_XZ, FALLBACK_HEIGHT, z + FALLBACK_HALF_XZ);
  }

  private reset(): void {
    this.setFallbackBounds();
    this.probing = false;
    this.hasSurfaces = false;
    this.building = false;
    this.liveFinished = false;
    this.snapHas = false;
    this.snapProbing = false;
    this.snapCols = 0;
    this.snapRows = 0;
    this.entries = [];
    this.entryIndex = 0;
    this.geometryCursor = 0;
    this.triangleReady = false;
    this.layers = new Float32Array(0);
    this.layerCounts = new Uint8Array(0);
    this.gridCols = 0;
    this.gridRows = 0;
    this.probeHitCount = 0;
    this.probeCursor = 0;
    this.probeRevision += 1;
  }

  /** Keep the servable grid before a refill: bulk copy, no allocation churn. */
  private snapshotLive(): void {
    if (!this.hasSurfaces || this.gridCols === 0 || !this.liveFinished) return;
    if (this.snapLayers.length !== this.layers.length) {
      this.snapLayers = new Float32Array(this.layers.length);
      this.snapCounts = new Uint8Array(this.layerCounts.length);
    }
    this.snapLayers.set(this.layers);
    this.snapCounts.set(this.layerCounts);
    this.snapCols = this.gridCols;
    this.snapRows = this.gridRows;
    this.snapMinX = this.gridMinX;
    this.snapMinZ = this.gridMinZ;
    this.snapMin.copy(this.min);
    this.snapMax.copy(this.max);
    this.snapHas = true;
    this.snapProbing = this.probing;
  }

  /**
   * A remap that yields nothing restores the snapshot volume instead of
   * zeroing measured state; a first-ever empty scan keeps today's compact
   * fallback (callers must still treat null columns as unmeasured).
   */
  private restoreSnapshot(): void {
    if (!this.snapHas || this.snapCols === 0) {
      // Probe hits live outside the mesh grid: an empty mesh remap with no
      // finished snapshot keeps probe knowledge, not the fallback box.
      if (this.probeHitCount > 0) return;
      this.reset();
      return;
    }
    if (this.layers.length !== this.snapLayers.length) {
      this.layers = new Float32Array(this.snapLayers.length);
      this.layerCounts = new Uint8Array(this.snapCounts.length);
    }
    this.layers.set(this.snapLayers);
    this.layerCounts.set(this.snapCounts);
    this.gridCols = this.snapCols;
    this.gridRows = this.snapRows;
    this.gridMinX = this.snapMinX;
    this.gridMinZ = this.snapMinZ;
    // The snapshot keeps the pre-remap volume including its sensed floor.
    this.min.copy(this.snapMin);
    this.max.copy(this.snapMax);
    this.building = false;
    this.entries = [];
    this.liveFinished = true;
    this.hasSurfaces = true;
    this.probing = this.snapProbing;
    if (this.hasAnchor && !this.contains(this.anchorPos)) {
      // Keep old measured columns spatially keyed, but place the weather at
      // the current viewer and allow fresh probes here.
      this.setFallbackBounds();
      this.allocateGrid();
      this.hasSurfaces = false;
      this.probing = false;
      this.clearProbeHits();
    }
  }

  /**
   * Highest mapped layer at column (x, z) at or below `belowY`: a falling
   * drop meets the table when above it, the lowest measured level once past
   * it — generic layer pick, no ceiling heuristic. Serves the finished
   * snapshot while a rebuild refills. Returns null outside the
   * grid, over unmapped cells, or when every layer is above the query point.
   */
  surfaceHeightAt(x: number, z: number, belowY: number): number | null {
    if (this.building && this.snapHas && this.floorLayerAt(x, z, this.snapLayers, this.snapCounts, this.snapCols, this.snapRows, this.snapMinX, this.snapMinZ) != null) {
      return this.layerAtOrBelow(x, z, belowY, this.snapLayers, this.snapCounts, this.snapCols, this.snapRows, this.snapMinX, this.snapMinZ);
    }
    const live = this.hasSurfaces && this.gridCols > 0
      ? this.layerAtOrBelow(x, z, belowY, this.layers, this.layerCounts, this.gridCols, this.gridRows, this.gridMinX, this.gridMinZ)
      : null;
    if (live != null) return live;
    if (!this.snapHas || this.snapCols === 0) return null;
    return this.layerAtOrBelow(x, z, belowY, this.snapLayers, this.snapCounts, this.snapCols, this.snapRows, this.snapMinX, this.snapMinZ);
  }

  /**
   * Lowest mapped layer at column (x, z): the puddle level beneath tables
   * and upper levels. Serves the finished snapshot while a rebuild refills.
   * Returns null outside the grid or over unmapped cells; absence of a
   * measured layer is not a ground elevation.
   */
  floorHeightAt(x: number, z: number): number | null {
    if (this.building && this.snapHas) {
      const finished = this.floorLayerAt(x, z, this.snapLayers, this.snapCounts, this.snapCols, this.snapRows, this.snapMinX, this.snapMinZ);
      if (finished != null) return finished;
    }
    const live = this.hasSurfaces && this.gridCols > 0
      ? this.floorLayerAt(x, z, this.layers, this.layerCounts, this.gridCols, this.gridRows, this.gridMinX, this.gridMinZ)
      : null;
    if (live != null) return live;
    if (!this.snapHas || this.snapCols === 0) return null;
    return this.floorLayerAt(x, z, this.snapLayers, this.snapCounts, this.snapCols, this.snapRows, this.snapMinX, this.snapMinZ);
  }

  private layerAtOrBelow(x: number, z: number, belowY: number, layers: Float32Array, counts: Uint8Array, cols: number, rows: number, minX: number, minZ: number): number | null {
    const col = Math.floor((x - minX) / GRID_CELL);
    const row = Math.floor((z - minZ) / GRID_CELL);
    if (col < 0 || row < 0 || col >= cols || row >= rows) return null;
    const cell = row * cols + col;
    const base = cell * LAYERS_PER_CELL;
    const count = counts[cell] ?? 0;
    for (let i = count - 1; i >= 0; i -= 1) {
      const height = layers[base + i];
      if (height <= belowY) return height;
    }
    return null;
  }

  private floorLayerAt(x: number, z: number, layers: Float32Array, counts: Uint8Array, cols: number, rows: number, minX: number, minZ: number): number | null {
    const col = Math.floor((x - minX) / GRID_CELL);
    const row = Math.floor((z - minZ) / GRID_CELL);
    if (col < 0 || row < 0 || col >= cols || row >= rows) return null;
    const cell = row * cols + col;
    if ((counts[cell] ?? 0) === 0) return null;
    return layers[cell * LAYERS_PER_CELL];
  }
}

/** App-wide singleton; rebuilt by RoomSensingSystem, read by the visuals. */
export const roomModel = new RoomModel();
