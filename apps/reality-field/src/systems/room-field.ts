/**
 * REALITY//FIELD — room sensing.
 *
 * The scene-understanding system reports detected planes and meshes as
 * entities. This system turns that stream into two things:
 *
 * - the **skin**: one world-space triangle mesh stretched over everything
 *   the sensors found, rendered with the wave material. The room becomes a
 *   surface that can be struck;
 * - the **picker**: the analytic rectangles and boxes used to find where a
 *   pointing ray actually meets the room.
 *
 * Both are rebuilt on a debounce, not every frame: the sensors refine their
 * geometry continuously, and rebuilding a skin on every refinement would
 * cost more than the effect is worth. The rebuild is also bounded — a
 * detected mesh with hundreds of thousands of vertices is skipped rather
 * than copied.
 */

import {
  BufferGeometry,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  Vector3,
  XRMesh,
  XRPlane,
  createSystem,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import { buildSkin, planeCentroidXZ } from '../field/surfaces.js';
import type { PickSurface } from '../field/picker.js';
import { createSkinMaterial } from '../field/membrane-material.js';
import { fieldRuntime } from '../field/runtime.js';
import { fieldState } from '../field/state.js';

/** Minimum seconds between skin rebuilds. */
const REBUILD_DEBOUNCE_S = 0.4;

/** Plane polygon shape as reported by the framework. */
interface PlaneShape {
  polygon?: readonly { x: number; y: number; z: number }[];
}

export class RoomFieldSystem extends createSystem({
  planes: { required: [XRPlane] },
  meshes: { required: [XRMesh] },
}) {
  private dirty = true;
  private lastRebuildAt = -REBUILD_DEBOUNCE_S;
  private skinMesh: Mesh | null = null;
  private skinEntity: Entity | null = null;
  private outlineEntity: Entity | null = null;
  private outlineGeometry: BufferGeometry | null = null;
  private readonly localMin = new Vector3();
  private readonly localMax = new Vector3();

  init(): void {
    const markDirty = (): void => {
      this.dirty = true;
    };
    this.cleanupFuncs.push(
      this.queries.planes.subscribe('qualify', markDirty),
      this.queries.planes.subscribe('disqualify', markDirty),
      this.queries.meshes.subscribe('qualify', markDirty),
      this.queries.meshes.subscribe('disqualify', markDirty),
    );
  }

  update(_delta: number, time: number): void {
    this.world.player.head.getWorldPosition(fieldRuntime.head);
    // Without an immersive session there is no room to be a field of: the
    // skin and the debug outline are withdrawn instead of lingering as a
    // stale reconstruction of a session that has ended.
    if (this.world.xrSession == null) {
      if (this.skinMesh != null || this.outlineEntity != null) this.clearSkin();
      return;
    }
    this.updateOutlineVisibility();
    if (!this.dirty) return;
    if (time - this.lastRebuildAt < REBUILD_DEBOUNCE_S) return;
    this.lastRebuildAt = time;
    this.dirty = false;
    this.rebuild();
  }

  /** The technical outline only exists in the debug view. */
  private updateOutlineVisibility(): void {
    const object = this.outlineEntity?.object3D;
    if (object == null) return;
    const visible = fieldState.mode === 'debug';
    if (object.visible !== visible) object.visible = visible;
  }

  /** Collect the sensed surfaces and rebuild the skin and the picker. */
  private rebuild(): void {
    const surfaces: PickSurface[] = [];
    for (const entity of this.queries.planes.entities) {
      const object = entity.object3D;
      if (object == null) continue;
      const raw: unknown = entity.getValue(XRPlane, '_plane');
      const shape = (raw != null && typeof raw === 'object' ? raw : undefined) as
        | PlaneShape
        | undefined;
      const centroid = planeCentroidXZ(shape?.polygon);
      surfaces.push({
        object,
        isPlane: true,
        offsetX: centroid.x,
        offsetZ: centroid.z,
        localMin: null,
        localMax: null,
      });
    }
    for (const entity of this.queries.meshes.entities) {
      const object = entity.object3D;
      if (object == null) continue;
      const min = entity.getVectorView(XRMesh, 'min');
      const max = entity.getVectorView(XRMesh, 'max');
      this.localMin.set(min[0], min[1], min[2]);
      this.localMax.set(max[0], max[1], max[2]);
      surfaces.push({
        object,
        isPlane: false,
        offsetX: 0,
        offsetZ: 0,
        localMin: this.localMin.clone(),
        localMax: this.localMax.clone(),
      });
    }

    fieldRuntime.picker.rebuild(surfaces, fieldRuntime.head);

    const build = buildSkin(
      surfaces.map((surface) => ({
        object: surface.object,
        isPlane: surface.isPlane,
        offsetX: surface.offsetX,
        offsetZ: surface.offsetZ,
        localMin: surface.localMin,
        localMax: surface.localMax,
      })),
      fieldRuntime.head,
    );

    fieldState.surfaceCount = build.surfaceCount;
    fieldState.roomStatus = build.surfaceCount > 0 ? 'mesh' : 'pending';

    if (build.geometry == null) {
      this.clearSkin();
      return;
    }

    if (this.skinMesh == null) {
      this.skinMesh = new Mesh(build.geometry, createSkinMaterial(fieldRuntime.wave.uniforms));
      this.skinMesh.frustumCulled = false;
      this.skinEntity = this.world.createTransformEntity(this.skinMesh);
    } else {
      this.skinMesh.geometry.dispose();
      this.skinMesh.geometry = build.geometry;
    }
    fieldRuntime.skin = this.skinMesh;
    fieldRuntime.skinVersion += 1;

    this.updateOutline(build.outline);
  }

  /** Refresh the debug outline (plane borders and mesh bounds). */
  private updateOutline(outline: Float32Array): void {
    if (outline.length === 0) {
      this.outlineGeometry?.dispose();
      this.outlineGeometry = null;
      if (this.outlineEntity != null) {
        this.outlineEntity.dispose();
        this.outlineEntity = null;
      }
      return;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(outline, 3));
    if (this.outlineEntity == null) {
      const lines = new LineSegments(
        geometry,
        new LineBasicMaterial({ color: 0x4fd0ff, transparent: true, opacity: 0.75 }),
      );
      lines.frustumCulled = false;
      this.outlineEntity = this.world.createTransformEntity(lines);
      this.outlineGeometry = geometry;
    } else {
      this.outlineGeometry?.dispose();
      this.outlineGeometry = geometry;
      const lines = this.outlineEntity.object3D as LineSegments | undefined;
      if (lines != null) {
        lines.geometry = geometry;
      }
    }
  }

  /** Drop the skin (session ended, or nothing was sensed). */
  private clearSkin(): void {
    if (this.skinMesh != null) {
      this.skinMesh.geometry.dispose();
    }
    this.skinMesh = null;
    fieldRuntime.skin = null;
    fieldState.surfaceCount = 0;
    fieldState.roomStatus = 'pending';
    if (this.outlineEntity != null) {
      this.outlineEntity.dispose();
      this.outlineEntity = null;
      this.outlineGeometry = null;
    }
  }

  override destroy(): void {
    super.destroy();
    this.clearSkin();
  }
}
