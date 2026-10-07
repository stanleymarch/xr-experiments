/**
 * Spatial timeline: a 0.9 m rail with 6-hour ticks and a grabbable handle.
 * While grabbed, handle X in [-0.45, 0.45] maps to playhead hours [-24, 24].
 * Releasing within +/-0.75 h of 0 snaps back to live. The rail floats at a
 * fixed pose until room surfaces appear, then re-anchors to the floor.
 */

import {
  BoxGeometry,
  createSystem,
  CylinderGeometry,
  Grabbed,
  Hovered,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OneHandGrabbable,
  RayInteractable,
  Vector3,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import { TimelineHandle } from '../components/timeline-handle.js';
import { roomModel } from '../room.js';
import { PLAYHEAD_MAX_H, PLAYHEAD_MIN_H, weatherStore } from '../weather-state.js';

const RAIL_HALF = 0.45;
const SNAP_HOURS = 0.75;
const DEFAULT_POS = new Vector3(0, 1.05, -1.0);

export class TimelineSystem extends createSystem({
  hovered: { required: [TimelineHandle, Hovered] },
  grabbed: { required: [TimelineHandle, Grabbed] },
  handles: { required: [TimelineHandle] },
}) {
  private railEntity!: Entity;
  private handleEntity!: Entity;
  private grabbedHandle: Entity | null = null;
  private anchored = false;
  private readonly railPos = new Vector3();
  private readonly handleWorld = new Vector3();
  private readonly railWorld = new Vector3();
  private handleMaterial!: MeshStandardMaterial;

  init(): void {
    // Rail: slim rounded feel via a box + tick marks every 6 h (9 ticks).
    const railGeo = new BoxGeometry(0.9, 0.03, 0.06);
    const railMat = new MeshStandardMaterial({ color: 0x2e3a4d, roughness: 0.5, metalness: 0.3 });
    const rail = new Mesh(railGeo, railMat);
    this.railEntity = this.world.createTransformEntity(rail);
    this.railEntity.object3D?.position.copy(DEFAULT_POS);
    this.railPos.copy(DEFAULT_POS);

    const tickGeo = new BoxGeometry(0.008, 0.05, 0.02);
    const tickMat = new MeshBasicMaterial({ color: 0x9fb4cc });
    const nowTickGeo = new BoxGeometry(0.018, 0.12, 0.03);
    const nowTickMat = new MeshBasicMaterial({ color: 0x58d9ff });
    const endTickGeo = new BoxGeometry(0.014, 0.075, 0.025);
    const endTickMat = new MeshBasicMaterial({ color: 0xf2a56e });
    for (let h = PLAYHEAD_MIN_H; h <= PLAYHEAD_MAX_H; h += 6) {
      const t = (h - PLAYHEAD_MIN_H) / (PLAYHEAD_MAX_H - PLAYHEAD_MIN_H);
      const isNow = h === 0;
      const isEnd = Math.abs(h) === PLAYHEAD_MAX_H;
      const tick = new Mesh(
        isNow ? nowTickGeo : isEnd ? endTickGeo : tickGeo,
        isNow ? nowTickMat : isEnd ? endTickMat : tickMat,
      );
      tick.position.set(-RAIL_HALF + t * RAIL_HALF * 2, isNow ? 0.04 : 0.01, 0);
      this.railEntity.object3D?.add(tick);
    }

    // Handle: small grabbable knob riding the rail.
    // Larger luminous marker makes the grab target distinct from the tick marks.
    const knobGeo = new CylinderGeometry(0.0525, 0.0525, 0.105, 20);
    this.handleMaterial = new MeshStandardMaterial({
      color: 0x4dc3ff,
      roughness: 0.35,
      emissive: 0x0a2a3a,
      emissiveIntensity: 0.65,
    });
    const knob = new Mesh(knobGeo, this.handleMaterial);
    knob.rotation.z = Math.PI / 2;
    this.handleEntity = this.world.createTransformEntity(knob, { parent: this.railEntity });
    this.handleEntity.addComponent(TimelineHandle, {});
    this.handleEntity.addComponent(RayInteractable, {});
    this.handleEntity.addComponent(OneHandGrabbable, {});
    this.handleEntity.object3D?.position.set(0, 0.06, 0);
    this.cleanupFuncs.push(
      this.queries.grabbed.subscribe('qualify', (entity) => {
        this.grabbedHandle = entity;
      }),
      this.queries.grabbed.subscribe('disqualify', () => {
        this.grabbedHandle = null;
      }),
      () => {
        this.handleEntity.dispose();
        this.railEntity.dispose();
      },
    );
  }

  update(): void {
    // Re-anchor once: sit the rail on the detected floor/table height.
    if (!this.anchored && roomModel.hasSurfaces) {
      this.anchored = true;
      this.railPos.set(0, roomModel.min.y + 1.05, -1.0);
      this.railEntity.object3D?.position.copy(this.railPos);
    }

    const state = weatherStore.state.peek();
    const handle = this.grabbedHandle;
    const hovered = this.queries.hovered.entities.size > 0 || this.grabbedHandle != null;
    this.handleMaterial.emissiveIntensity = hovered
      ? 1.1 + Math.sin(performance.now() * 0.008) * 0.25
      : 0.65;
    if (handle != null) {
      // While held: map handle world X (rail-local) to playhead hours.
      handle.object3D?.getWorldPosition(this.handleWorld);
      this.railEntity.object3D?.getWorldPosition(this.railWorld);
      const localX = Math.max(-RAIL_HALF, Math.min(RAIL_HALF, this.handleWorld.x - this.railWorld.x));
      const t = (localX + RAIL_HALF) / (RAIL_HALF * 2);
      const hours = PLAYHEAD_MIN_H + t * (PLAYHEAD_MAX_H - PLAYHEAD_MIN_H);
      if (Math.abs(hours) <= SNAP_HOURS) weatherStore.goLive();
      else weatherStore.setPlayhead(hours);
    } else {
      // Released: keep the knob where the playhead says it is.
      const t = (state.playheadHours - PLAYHEAD_MIN_H) / (PLAYHEAD_MAX_H - PLAYHEAD_MIN_H);
      this.handleEntity.object3D?.position.set(-RAIL_HALF + t * RAIL_HALF * 2, 0.06, 0);
    }
  }
}
