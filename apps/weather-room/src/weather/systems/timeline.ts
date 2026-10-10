/**
 * Spatial timeline: clones the reusable `timeline-control` manifest asset
 * (0.96 m exhibition instrument, knob travel ±0.45 m) and drives it.
 * While grabbed, handle X in [-0.45, 0.45] maps to playhead hours [-24, 24].
 * Releasing within +/-0.75 h of 0 snaps back to live. On XR entry the control
 * is placed in front of the tracked viewer once (1.05 m out, 0.4 m below
 * the eyes, face tilted up), below the panel and its separate move bar,
 * then stays fixed in the room.
 *
 * Hover/grab feedback animates the cloned glow-ring/crown emissive and the
 * NOW→playhead light-guide fill on materials cloned once at setup — no
 * per-frame allocations, shared prototype materials untouched.
 */

import {
  BoxGeometry,
  createSystem,
  DistanceGrabbable,
  Grabbed,
  Hovered,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  MovementMode,
  OneHandGrabbable,
  RayInteractable,
  Vector3,
  SphereGeometry,
  VisibilityState,
} from '@iwsdk/core';
import type { Entity, Object3D } from '@iwsdk/core';
import {
  TIMELINE_CONTROL_ASSET_ID,
  TIMELINE_KNOB_PART,
  TIMELINE_KNOB_REST_Z,
  TIMELINE_TRAVEL_HALF,
} from '../../scene-assets/timeline-control.scene-asset.js';
import { TimelineHandle, TimelineMoveGrip } from '../components/timeline-handle.js';
import {
  baselineAngularSize,
  buildAffordance,
  ContactImpulse,
  createAngularSizeState,
  createGripDriver,
  createSurfaceGrab,
  createViewPullState,
  faceViewer,
  placeControlAtViewer,
  stepAngularSize,
  stepViewDistance,
  thumbstickY,
  unlockGripAudio,
} from '../control-placement.js';
import type { Affordance, AngularSizeState, GripDriver, Handedness, SurfaceGrab, ViewPullState } from '../control-placement.js';
import { PLAYHEAD_MAX_H, PLAYHEAD_MIN_H, WeatherEvent, weatherEvents, weatherStore } from '../weather-state.js';
import type { HourCrossedDetail } from '../weather-state.js';
import { Haptics, pulseHaptics } from '../feedback.js';

const RAIL_HALF = TIMELINE_TRAVEL_HALF;
const SNAP_HOURS = 0.75;
const DEFAULT_POS = new Vector3(0, 1.2, -1.0);
/**
 * One-glance framing: panel (1.4 m out, +0.18 m, scale 0.18) and timeline
 * (1.05 m out, -0.4 m) keep their controls and move bars separate.
 * Face tipped up; the whole rail remains visible below the panel.
 */
const PLACEMENT_DISTANCE = 1.05;
const PLACEMENT_HEIGHT_OFFSET = -0.4;
const FACE_TILT_X = -0.28;
/**
 * Dedicated whole-rail move affordance: the platform Control Bar (a pill)
 * below the housing, clear of the TimeKnob travel band.
 */
const MOVE_GRIP_OFFSET = new Vector3(0.0, 0.0, 0.02);
const MOVE_GRIP_SIZE: readonly [number, number, number] = [0.22, 0.03, 0.03];
/** Housing half-height (asset envelope y = 0 here), so the Control Bar sits
 *  just below the housing's bottom edge instead of below an arbitrary box. */
const MOVE_AFFORDANCE_HOUSING_H = 0.074;
/**
 * Pinch-scrub strip: one invisible grab shell spanning the whole scale
 * (±0.45 m travel) at knob grip height. A pinch anywhere along the rail
 * grabs it and drives the playhead through the same TimelineHandle mapping
 * (±0.45 m ⇔ ±24 h). Cross-section per spec: 0.90 × 0.02 × 0.02 m.
 */
const SCRUB_STRIP_W_M = 0.9;
const SCRUB_STRIP_T_M = 0.02;
/** Detent impulse color: rail cyan accent. */
const DETENT_IMPULSE_COLOR = 0x79d7f2;


export class TimelineSystem extends createSystem({
  hovered: { required: [TimelineHandle, Hovered] },
  grabbed: { required: [TimelineHandle, Grabbed] },
  handles: { required: [TimelineHandle] },
}) {
  private railEntity: Entity | null = null;
  private handleEntity: Entity | null = null;
  private grabbedHandle: Entity | null = null;
  /** Separate invisible ray target; never shares Object3D ownership. */
  private scrubProxyEntity: Entity | null = null;
  /** Wide invisible pinch-scrub shell across the whole scale. */
  private scrubStripEntity: Entity | null = null;
  /** Paired visual for the hourly detent tick while pinch-scrubbing. */
  private detentImpulse: ContactImpulse | null = null;
  /** Whole-rail move affordance: Control Bar pill below the housing. */
  private moveAffordance: Affordance | null = null;
  private moveGripEntity: Entity | null = null;
  private moveNearEntity: Entity | null = null;
  private moveFarEntity: Entity | null = null;
  private moveDriver: GripDriver | null = null;
  private surfaceGrab: SurfaceGrab | null = null;
  /** Aiming anywhere on the rail counts as aiming at the window. */
  private readonly carrySurface: Object3D[] = [];
  private wasCarried = false;
  private readonly angularSize: AngularSizeState = createAngularSizeState();
  private readonly viewPull: ViewPullState = createViewPullState();
  private needsPlacement = false;
  private placedInSession = false;
  private readonly handleWorld = new Vector3();
  private glowMaterial: MeshStandardMaterial | null = null;
  private crownMaterial: MeshStandardMaterial | null = null;
  private fillMaterial: MeshBasicMaterial | null = null;
  private fillMesh: Object3D | null = null;
  /** NOW-pill snap flash: 0 = idle, otherwise seconds since the flash start. */
  private snapFlashT = -1;
  /** Hour-crossing detent flash on the guide fill: 0..1 decay, no allocation. */
  private hourPing = 0;

  init(): void {
    this.detentImpulse = new ContactImpulse(this.world, DETENT_IMPULSE_COLOR, 'Timeline Detent Impulse');
    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((state) => {
        if (state === VisibilityState.NonImmersive) this.placedInSession = false;
        if (state === VisibilityState.Visible) unlockGripAudio();
        this.needsPlacement = state === VisibilityState.Visible && !this.placedInSession;
        // The flat page shows the DOM panel only: the whole rail rig —
        // housing, knob, scrub proxies, move affordance — hangs off
        // the rail entity, so hiding its root hides all of it, mirroring the
        // panel's own NonImmersive behaviour.
        const railObject = this.railEntity?.object3D;
        if (railObject != null) railObject.visible = state !== VisibilityState.NonImmersive;
      }),
      this.queries.grabbed.subscribe('qualify', (entity) => {
        // The shared `grabbed` query also matches the rail move-grip
        // entities; only TimelineHandle holders (knob near entity or ray
        // scrub proxy) drive the playhead. Move-grip feedback lives in its
        // driver, so ignoring it here changes no bus behavior.
        if (!entity.hasComponent(TimelineHandle)) return;
        this.grabbedHandle = entity;
        weatherEvents.emit(WeatherEvent.TimelineGrab);
        pulseHaptics(this.world, Haptics.grab.intensity, Haptics.grab.durationMs);
      }),
      this.queries.grabbed.subscribe('disqualify', (entity) => {
        const wasLive = weatherStore.state.peek().isLive;
        // Two TimelineHandle grabs can overlap — a hand pinching the scrub
        // strip while a ray holds the ray proxy — and releasing either one
        // fires this handler. Re-elect the survivor instead of killing
        // scrubbing for both; a released non-holder (the move grip) must not
        // disturb the live grab at all.
        if (this.grabbedHandle != null && this.grabbedHandle !== entity) return;
        const next =
          [...this.queries.grabbed.entities].find(
            (candidate) => candidate !== entity && candidate.hasComponent(TimelineHandle),
          ) ?? null;
        this.grabbedHandle = next;
        if (next != null) return;
        weatherEvents.emit(WeatherEvent.TimelineRelease);
        // Release outside the snap zone gets a subtle single settle tap so
        // it still acknowledges; snap-to-live arrivals already got the
        // double pulse via the store-emitted TimelineSnap.
        if (!wasLive) {
          pulseHaptics(this.world, Haptics.settle.intensity, Haptics.settle.durationMs);
        }
      }),
      // The guide fill follows the same room-wide hour moment as the panels,
      // room pulse, detent haptic, and tick audio: a brief ping on every
      // crossing, and an unmistakable flash-and-collapse on the NOW snap.
      // Snap haptics/audio ride the store-emitted TimelineSnap + HourCrossed
      // events (one detent per hour, double pulse + two-tone on snap) so
      // every playhead source shares one snap moment.
      weatherEvents.on(WeatherEvent.HourCrossed, (detail: unknown) => {
        const crossed = detail as HourCrossedDetail | undefined;
        if (crossed?.isLive === true) this.snapFlashT = 0;
        else {
          this.hourPing = 1;
          pulseHaptics(this.world, Haptics.hourTick.intensity, Haptics.hourTick.durationMs);
          // Paired visual for the detent tick (hands have no haptics): a
          // flash at the held handle — knob, ray proxy, or pinch strip —
          // while a scrub is actually in progress.
          const held = this.grabbedHandle;
          if (held != null && this.detentImpulse != null) {
            held.object3D?.getWorldPosition(this.handleWorld);
            this.detentImpulse.trigger(this.handleWorld);
          }
        }
      }),
      weatherEvents.on(WeatherEvent.TimelineSnap, () => {
        pulseHaptics(this.world, Haptics.snapFirst.intensity, Haptics.snapFirst.durationMs);
        const world = this.world;
        window.setTimeout(
          () => pulseHaptics(world, Haptics.snapSecond.intensity, Haptics.snapSecond.durationMs),
          70,
        );
      }),
      () => {
        this.detentImpulse?.dispose();
        this.detentImpulse = null;
      },
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
      } else if (child.name === 'TickMarks' || child.name.startsWith('Signpost')) {
        // 95%-opaque hairlines and signposts: keep them opaque with depth writes
        // so they occlude by distance like the housing instead of riding the
        // transparent sort against the panel UI. The additive light guide, the
        // endpoint glows and the knob glow ring stay transparent.
        const sources = Array.isArray(child.material) ? child.material : [child.material];
        const clones = sources.map((entry) => {
          const clone = entry.clone();
          clone.transparent = false;
          clone.opacity = 1;
          clone.depthWrite = true;
          return clone;
        });
        child.material = Array.isArray(child.material) ? clones : clones[0];
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
    // SDK grab components are mutually exclusive on one entity.
    this.handleEntity.addComponent(OneHandGrabbable, { rotate: false });
    const rayTarget = new Mesh(
      new SphereGeometry(0.032, 12, 8),
      new MeshBasicMaterial({ colorWrite: false, depthWrite: false }),
    );
    rayTarget.name = 'Weather Timeline Ray Handle';
    rayTarget.position.copy(knob.position);
    this.scrubProxyEntity = this.world.createTransformEntity(rayTarget, { parent: this.railEntity });
    this.scrubProxyEntity.addComponent(TimelineHandle, {});
    this.scrubProxyEntity.addComponent(RayInteractable, {});
    this.scrubProxyEntity.addComponent(DistanceGrabbable, {
      rotate: false,
      scale: false,
      movementMode: MovementMode.MoveAtSource,
      returnToOrigin: false,
    });
    // Pinch-scrub strip: the wide invisible grab shell across the whole
    // scale. OneHandGrabbable only (the ray already owns the knob proxy
    // above), so pointing behavior is unchanged; a pinch anywhere along
    // the rail grabs the strip and the TimelineHandle mapping below writes
    // the playhead from its world X (same ±0.45 m ⇔ ±24 h route as the
    // knob). The strip is pinned back to rest every held frame, so grabs
    // never drift it along the rail.
    const scrubStrip = new Mesh(
      new BoxGeometry(SCRUB_STRIP_W_M, SCRUB_STRIP_T_M, SCRUB_STRIP_T_M),
      new MeshBasicMaterial({ colorWrite: false, depthWrite: false }),
    );
    scrubStrip.name = 'Weather Timeline Pinch Scrub';
    scrubStrip.position.set(0, 0, TIMELINE_KNOB_REST_Z);
    this.scrubStripEntity = this.world.createTransformEntity(scrubStrip, { parent: this.railEntity });
    this.scrubStripEntity.addComponent(TimelineHandle, {});
    this.scrubStripEntity.addComponent(OneHandGrabbable, { rotate: false });
    // Whole-rail move affordance: a Control Bar pill below the housing, clear
    // of the knob travel band (|x| <= 0.45) and the cue tag above. The rail is
    // a bar instrument, not a window, so it gets the platform Control Bar only
    // (no edge frame): its own bezel is the edge, and the pill is the handle.
    // Two coincident collision shells because OneHandGrabbable (near:
    // squeeze/pinch) and DistanceGrabbable (ray trigger) are mutually
    // exclusive per entity.
    const moveAffordance = buildAffordance({
      name: 'Weather Timeline Move Affordance',
      heightM: MOVE_AFFORDANCE_HOUSING_H,
      pillWidthM: MOVE_GRIP_SIZE[0],
    });
    moveAffordance.group.position.copy(MOVE_GRIP_OFFSET);
    this.moveAffordance = moveAffordance;
    this.moveGripEntity = this.world.createTransformEntity(moveAffordance.group, { parent: this.railEntity });
    this.moveNearEntity = this.world.createTransformEntity(moveAffordance.near, { parent: this.moveGripEntity });
    this.moveFarEntity = this.world.createTransformEntity(moveAffordance.far, { parent: this.moveGripEntity });
    this.moveNearEntity.addComponent(TimelineMoveGrip, {});
    this.moveFarEntity.addComponent(TimelineMoveGrip, {});
    this.moveNearEntity.addComponent(RayInteractable, {});
    this.moveFarEntity.addComponent(RayInteractable, {});
    this.moveNearEntity.addComponent(OneHandGrabbable, { rotate: false });
    this.moveFarEntity.addComponent(DistanceGrabbable, {
      rotate: false,
      scale: false,
      movementMode: MovementMode.MoveAtSource,
      returnToOrigin: false,
    });
    this.moveDriver = createGripDriver(this.world, this.moveNearEntity, this.moveFarEntity, moveAffordance, {
      // Carry turns the rail about Y only: its authored 16 deg up-tilt stays,
      // roll stays 0, angular size is kept across depth translation, and the
      // thumbstick pushes/pulls it along the view ray.
      onHeld: (root, dt, hand) => {
        const head = this.world.player.head;
        faceViewer(root, head, FACE_TILT_X);
        stepViewDistance(root, head, thumbstickY(this.world, hand), this.viewPull, dt);
        stepAngularSize(root, head, this.angularSize, dt);
      },
    });
    // Native window grab: pointing anywhere at the rail and squeezing moves it.
    this.carrySurface.push(model);
    this.surfaceGrab = createSurfaceGrab(this.world, this.carrySurface, moveAffordance.far, this.moveNearEntity);

    this.cleanupFuncs.push(() => {
      this.moveNearEntity?.dispose();
      this.moveFarEntity?.dispose();
      this.scrubProxyEntity?.dispose();
      this.scrubStripEntity?.dispose();
      scrubStrip.geometry.dispose();
      scrubStrip.material.dispose();
      rayTarget.geometry.dispose();
      rayTarget.material.dispose();
      this.moveGripEntity?.dispose();
      this.moveAffordance?.dispose();
      this.moveAffordance = null;
      this.surfaceGrab = null;
      this.handleEntity?.dispose();
      this.railEntity?.dispose();
    });
  }

  update(delta: number): void {
    if (this.railEntity == null || this.handleEntity == null) return;
    // Whole-rail move affordance runs before knob math: the rail (and
    // therefore the knob constraint frame) may move under the hand. Moving
    // the rail never writes the playhead; the knob pass below still maps the
    // handle inside the moved frame.
    const rail = this.railEntity.object3D;
    if (this.moveDriver != null && rail != null) {
      const carried = this.moveNearEntity?.hasComponent(Grabbed) === true
        || this.moveFarEntity?.hasComponent(Grabbed) === true;
      if (carried && !this.wasCarried) {
        baselineAngularSize(rail, this.world.player.head, this.angularSize);
        this.viewPull.velocity = 0;
      }
      this.wasCarried = carried;
      this.surfaceGrab?.update();
      this.moveDriver.update(rail, delta);
    }

    if (this.needsPlacement && this.railEntity.object3D != null) {
      placeControlAtViewer(this.railEntity.object3D, this.world, PLACEMENT_DISTANCE, PLACEMENT_HEIGHT_OFFSET);
      this.railEntity.object3D.rotateX(FACE_TILT_X);
      this.railEntity.object3D.updateMatrixWorld(true);
      this.needsPlacement = false;
      this.placedInSession = true;
    }

    const state = weatherStore.state.peek();
    const handle = this.grabbedHandle;
    const grabbed = handle != null;
    const hovered = this.queries.hovered.entities.size > 0 || grabbed;

    // NOW-snap flash: the store announces every live arrival on the shared
    // hour bus (knob drag, step buttons, DOM scrub alike); the ring flashes
    // bright once then decays over ~0.45 s. Decay from the passed delta so
    // the flash reads identically at any frame rate. Direct update() calls
    // without a delta (as in screen-input-smoke.html) fall back to 16 ms.
    const dt = Number.isFinite(delta) ? Math.min(Math.max(delta, 0), 0.1) : 0.016;
    if (this.snapFlashT >= 0) this.snapFlashT += dt;
    if (this.snapFlashT > 0.45) this.snapFlashT = -1;
    if (this.hourPing > 0) this.hourPing = Math.max(0, this.hourPing - dt * 3);
    const snapFlash = this.snapFlashT >= 0 ? Math.exp(-this.snapFlashT * 7) : 0;

    // State feedback on the pre-cloned materials only.
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.008);
    if (this.glowMaterial != null) {
      this.glowMaterial.emissiveIntensity = grabbed ? 3.2 + pulse * 0.8 : hovered ? 2.4 : 1.6;
      // Unmistakable NOW snap: the glow ring carries the snap flash on top
      // of hover/grab feedback for one shared moment.
      this.glowMaterial.emissiveIntensity += snapFlash * 3.0;
    }
    if (this.crownMaterial != null) {
      this.crownMaterial.emissiveIntensity = grabbed ? 0.6 : hovered ? 0.35 : 0.15;
    }
    if (this.fillMaterial != null) {
      this.fillMaterial.opacity = grabbed ? 1.0 : hovered ? 0.9 : 0.75;
      // Same room-wide moment on the guide: detent ping per crossed hour,
      // full-bright snap on live arrival.
      this.fillMaterial.opacity = Math.min(1, this.fillMaterial.opacity + this.hourPing * 0.25 + snapFlash * 0.25);
    }

    let knobX: number;
    if (grabbed) {
      // Map the held near knob or separate ray target into rail-local X.
      handle.object3D?.getWorldPosition(this.handleWorld);
      this.railEntity.object3D?.worldToLocal(this.handleWorld);
      const localX = Math.max(-RAIL_HALF, Math.min(RAIL_HALF, this.handleWorld.x));
      const t = (localX + RAIL_HALF) / (RAIL_HALF * 2);
      const hours = PLAYHEAD_MIN_H + t * (PLAYHEAD_MAX_H - PLAYHEAD_MIN_H);
      // Snap routing stays identical (±0.75 h zone collapses to live) but the
      // snap haptics/audio now fire once from the store on live arrival, so
      // knob drags, step buttons, and DOM scrubs share one snap moment.
      if (Math.abs(hours) <= SNAP_HOURS) weatherStore.goLive();
      else weatherStore.setPlayhead(hours);
      knobX = localX;
      if (Math.abs(hours) <= SNAP_HOURS && this.fillMaterial != null) {
        this.fillMaterial.opacity = 1;
      }
      // The pinch strip is a fixed shell: after its world X has been read
      // into the mapping above, pin it back to rest so the grab drag never
      // drifts it along the rail.
      if (this.scrubStripEntity?.hasComponent(Grabbed) === true) {
        this.scrubStripEntity.object3D?.position.set(0, 0, TIMELINE_KNOB_REST_Z);
      }
    } else {
      // Released: keep the knob where the playhead says it is. The knob is
      // authored to travel local X, so it inherently retains its X
      // constraint after the parent rail was moved or rotated.
      const t = (state.playheadHours - PLAYHEAD_MIN_H) / (PLAYHEAD_MAX_H - PLAYHEAD_MIN_H);
      knobX = -RAIL_HALF + t * RAIL_HALF * 2;
    }
    // The visible knob always stays on its rail, even during a hand drag.
    this.handleEntity.object3D?.position.set(knobX, 0, TIMELINE_KNOB_REST_Z);
    if (this.grabbedHandle !== this.scrubProxyEntity) {
      this.scrubProxyEntity?.object3D?.position.set(knobX, 0, TIMELINE_KNOB_REST_Z);
    }

    // Luminous NOW→playhead segment follows the knob (transform only); on a
    // NOW snap it collapses to a dot so the snap reads as a collapse.
    if (this.fillMesh != null) {
      const clamped = Math.max(-RAIL_HALF, Math.min(RAIL_HALF, knobX));
      const snapped = Math.abs(clamped) < 0.05 && state.isLive;
      this.fillMesh.scale.x = snapped ? 0.0001 : (Math.abs(clamped) < 0.0001 ? 0.0001 : clamped);
    }
    this.detentImpulse?.update(dt);
  }

}
