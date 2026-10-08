/**
 * Spatial timeline: clones the reusable `timeline-control` manifest asset
 * (0.96 m exhibition instrument, knob travel ±0.45 m) and drives it.
 * While grabbed, handle X in [-0.45, 0.45] maps to playhead hours [-24, 24].
 * Releasing within +/-0.75 h of 0 snaps back to live. On XR entry the control
 * is placed in front of the tracked viewer once (0.8 m out, 0.4 m below the
 * eyes, face tilted up) then stays fixed in the room.
 *
 * Hover/grab feedback animates the cloned glow-ring/crown emissive and the
 * NOW→playhead light-guide fill on materials cloned once at setup — no
 * per-frame allocations, shared prototype materials untouched.
 */

import {
  createSystem,
  DistanceGrabbable,
  Grabbed,
  Hovered,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OneHandGrabbable,
  RayInteractable,
  Vector3,
  VisibilityState,
} from '@iwsdk/core';
import type { Entity, Object3D } from '@iwsdk/core';
import {
  TIMELINE_CONTROL_ASSET_ID,
  TIMELINE_KNOB_PART,
  TIMELINE_KNOB_REST_Z,
  TIMELINE_TRAVEL_HALF,
} from '../../scene-assets/timeline-control.scene-asset.js';
import { TimelineHandle } from '../components/timeline-handle.js';
import { placeControlAtViewer } from '../control-placement.js';
import { PLAYHEAD_MAX_H, PLAYHEAD_MIN_H, weatherEvents, weatherStore } from '../weather-state.js';

const RAIL_HALF = TIMELINE_TRAVEL_HALF;
const SNAP_HOURS = 0.75;
const DEFAULT_POS = new Vector3(0, 1.05, -1.0);
/** Comfortable reach: inside arm's length, below eye line, face tipped up. */
const PLACEMENT_DISTANCE = 0.8;
const PLACEMENT_HEIGHT_OFFSET = -0.4;
const FACE_TILT_X = -0.28;

export class TimelineSystem extends createSystem({
  hovered: { required: [TimelineHandle, Hovered] },
  grabbed: { required: [TimelineHandle, Grabbed] },
  handles: { required: [TimelineHandle] },
}) {
  private railEntity: Entity | null = null;
  private handleEntity: Entity | null = null;
  private grabbedHandle: Entity | null = null;
  private needsPlacement = false;
  private placedInSession = false;
  private readonly handleWorld = new Vector3();
  private glowMaterial: MeshStandardMaterial | null = null;
  private crownMaterial: MeshStandardMaterial | null = null;
  private fillMaterial: MeshBasicMaterial | null = null;
  private fillMesh: Object3D | null = null;

  init(): void {
    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((state) => {
        if (state === VisibilityState.NonImmersive) this.placedInSession = false;
        this.needsPlacement = state === VisibilityState.Visible && !this.placedInSession;
      }),
      this.queries.grabbed.subscribe('qualify', (entity) => {
        this.grabbedHandle = entity;
        weatherEvents.emit('timeline-grab');
        this.pulseControllers(0.5, 40);
      }),
      this.queries.grabbed.subscribe('disqualify', () => {
        this.grabbedHandle = null;
        weatherEvents.emit('timeline-release');
      }),
    );
    // elics `System.init()` is synchronous and never awaited (no official
    // async-init API), so report clone/registration failures loudly instead
    // of leaving an unhandled rejection.
    this.setupControl().catch((error: unknown) => {
      console.error('[TimelineSystem] failed to instantiate timeline-control asset:', error);
    });
  }

  /** Clone the registered prototype, restyle state materials once, wire ECS. */
  private async setupControl(): Promise<void> {
    const model = await this.world.assets.instantiate<Object3D>(TIMELINE_CONTROL_ASSET_ID);
    model.name = 'Weather Timeline';
    model.position.copy(DEFAULT_POS);
    model.rotation.x = FACE_TILT_X;
    this.railEntity = this.world.createTransformEntity(model);

    // One-time material clones for per-instance state feedback (the manifest
    // contract: reassigning mesh.material on a clone restyles one instance).
    model.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      if (child.name === 'KnobGlowRing' && child.material instanceof MeshStandardMaterial) {
        const cloned = child.material.clone();
        child.material = cloned;
        this.glowMaterial = cloned;
      } else if (child.name === 'KnobCrown' && child.material instanceof MeshStandardMaterial) {
        const cloned = child.material.clone();
        child.material = cloned;
        this.crownMaterial = cloned;
      } else if (child.name === 'LightGuideFill' && child.material instanceof MeshBasicMaterial) {
        const cloned = child.material.clone();
        child.material = cloned;
        this.fillMaterial = cloned;
        this.fillMesh = child;
      }
    });

    const knob = model.getObjectByName(TIMELINE_KNOB_PART);
    if (knob == null) {
      throw new Error(`timeline-control asset is missing its ${TIMELINE_KNOB_PART} part`);
    }
    knob.name = 'Weather Timeline Handle';
    knob.position.set(0, 0, TIMELINE_KNOB_REST_Z);
    this.handleEntity = this.world.createTransformEntity(knob, { parent: this.railEntity });
    this.handleEntity.addComponent(TimelineHandle, {});
    this.handleEntity.addComponent(RayInteractable, {});
    this.handleEntity.addComponent(DistanceGrabbable, { rotate: false });
    this.handleEntity.addComponent(OneHandGrabbable, { rotate: false });

    this.cleanupFuncs.push(() => {
      this.handleEntity?.dispose();
      this.railEntity?.dispose();
    });
  }

  update(): void {
    if (this.railEntity == null || this.handleEntity == null) return;

    if (this.needsPlacement && this.railEntity.object3D != null) {
      placeControlAtViewer(this.railEntity.object3D, this.world, PLACEMENT_DISTANCE, PLACEMENT_HEIGHT_OFFSET);
      this.railEntity.object3D.rotateX(FACE_TILT_X);
      this.needsPlacement = false;
      this.placedInSession = true;
    }

    const state = weatherStore.state.peek();
    const handle = this.grabbedHandle;
    const grabbed = handle != null;
    const hovered = this.queries.hovered.entities.size > 0 || grabbed;

    // State feedback on the pre-cloned materials only.
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.008);
    if (this.glowMaterial != null) {
      this.glowMaterial.emissiveIntensity = grabbed ? 2.2 + pulse * 0.6 : hovered ? 1.6 : 0.9;
    }
    if (this.crownMaterial != null) {
      this.crownMaterial.emissiveIntensity = grabbed ? 0.5 : hovered ? 0.22 : 0.06;
    }
    if (this.fillMaterial != null) {
      this.fillMaterial.opacity = grabbed ? 0.95 : hovered ? 0.8 : 0.55;
    }

    let knobX: number;
    if (grabbed) {
      // While held: map handle world X (rail-local) to playhead hours.
      handle.object3D?.getWorldPosition(this.handleWorld);
      this.railEntity.object3D?.worldToLocal(this.handleWorld);
      const localX = Math.max(-RAIL_HALF, Math.min(RAIL_HALF, this.handleWorld.x));
      const t = (localX + RAIL_HALF) / (RAIL_HALF * 2);
      const hours = PLAYHEAD_MIN_H + t * (PLAYHEAD_MAX_H - PLAYHEAD_MIN_H);
      if (Math.abs(hours) <= SNAP_HOURS) {
        if (!state.isLive) {
          weatherEvents.emit('timeline-snap');
          this.pulseControllers(0.3, 25);
          window.setTimeout(() => this.pulseControllers(0.6, 60), 70);
        }
        weatherStore.goLive();
      } else weatherStore.setPlayhead(hours);
      knobX = localX;
    } else {
      // Released: keep the knob where the playhead says it is.
      const t = (state.playheadHours - PLAYHEAD_MIN_H) / (PLAYHEAD_MAX_H - PLAYHEAD_MIN_H);
      knobX = -RAIL_HALF + t * RAIL_HALF * 2;
      this.handleEntity.object3D?.position.set(knobX, 0, TIMELINE_KNOB_REST_Z);
    }

    // Luminous NOW→playhead segment follows the knob (transform only).
    if (this.fillMesh != null) {
      const clamped = Math.max(-RAIL_HALF, Math.min(RAIL_HALF, knobX));
      this.fillMesh.scale.x = Math.abs(clamped) < 0.0001 ? 0.0001 : clamped;
    }
  }

  /**
   * Pulse every connected XR controller. WebXR gamepads expose
   * hapticActuators[].pulse(); guarded because hands and desktop lack them.
   */
  private pulseControllers(intensity: number, durationMs: number): void {
    const session = this.world.renderer.xr.getSession();
    if (session == null) return;
    for (const source of session.inputSources) {
      const actuators = (source.gamepad as (Gamepad & { hapticActuators?: { pulse(v: number, ms: number): Promise<boolean> }[] }) | null)
        ?.hapticActuators ?? [];
      for (const actuator of actuators) void actuator.pulse(intensity, durationMs).catch(() => undefined);
    }
  }
}
