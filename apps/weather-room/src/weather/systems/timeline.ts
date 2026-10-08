/**
 * Spatial timeline: clones the reusable `timeline-control` manifest asset
 * (0.96 m exhibition instrument, knob travel ±0.45 m) and drives it.
 * While grabbed, handle X in [-0.45, 0.45] maps to playhead hours [-24, 24].
 * Releasing within +/-0.75 h of 0 snaps back to live. On XR entry the control
 * is placed in front of the tracked viewer once (0.9 m out, 0.22 m below the
 * eyes, face tilted up) so the panel and the full rail share one forward
 * glance, then stays fixed in the room.
 *
 * Hover/grab feedback animates the cloned glow-ring/crown emissive and the
 * NOW→playhead light-guide fill on materials cloned once at setup — no
 * per-frame allocations, shared prototype materials untouched. Until the
 * first grab, the knob breathes and a small floating `timelineHint` tag
 * hovers beside it; the first grab retires the cue permanently.
 */

import {
  BufferAttribute,
  BufferGeometry,
  createSystem,
  DistanceGrabbable,
  DoubleSide,
  Grabbed,
  Hovered,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  MovementMode,
  OneHandGrabbable,
  PlaneGeometry,
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
  buildMoveGrip,
  createGripDriver,
  placeControlAtViewer,
} from '../control-placement.js';
import type { GripDriver, MoveGrip } from '../control-placement.js';
import { PLAYHEAD_MAX_H, PLAYHEAD_MIN_H, WeatherEvent, weatherEvents, weatherStore } from '../weather-state.js';
import type { HourCrossedDetail } from '../weather-state.js';
import { Haptics, pulseHaptics } from '../feedback.js';
import { onLanguageChange, t } from '../i18n.js';

const RAIL_HALF = TIMELINE_TRAVEL_HALF;
const SNAP_HOURS = 0.75;
const DEFAULT_POS = new Vector3(0, 1.2, -1.0);
/**
 * One-glance framing: panel (1.5 m out, +0.3 m) and timeline (0.9 m out,
 * -0.22 m) sit in the same forward gaze; the rail stays well above the
 * bottom frustum edge and inside comfortable reach. Face tipped up.
 */
const PLACEMENT_DISTANCE = 0.9;
const PLACEMENT_HEIGHT_OFFSET = -0.22;
const FACE_TILT_X = -0.28;
/** Floating cue tag: compact authored-geometry card, no fonts/DOM. */
const CUE_CARD_W = 0.16;
const CUE_CARD_H = 0.028;
const CUE_DOT_PITCH = 0.0075;
const CUE_DOT_R = 0.0016;
const CUE_TAG_OFFSET = new Vector3(0.0, 0.075, 0.055);
/**
 * Dedicated whole-rail move grip: a bar hung below the housing (clear of
 * the TimeKnob travel band and the cue tag), sized for a comfortable pinch.
 */
const MOVE_GRIP_OFFSET = new Vector3(0.0, -0.075, 0.02);
const MOVE_GRIP_SIZE: readonly [number, number, number] = [0.22, 0.03, 0.03];

export class TimelineSystem extends createSystem({
  hovered: { required: [TimelineHandle, Hovered] },
  grabbed: { required: [TimelineHandle, Grabbed] },
  handles: { required: [TimelineHandle] },
  moveHovered: { required: [TimelineMoveGrip, Hovered] },
  moveGrabbed: { required: [TimelineMoveGrip, Grabbed] },
}) {
  private railEntity: Entity | null = null;
  private handleEntity: Entity | null = null;
  private grabbedHandle: Entity | null = null;
  /** Separate invisible ray target; never shares Object3D ownership. */
  private scrubProxyEntity: Entity | null = null;
  /** Dedicated whole-rail move grip (near + distance entities + driver). */
  private moveGrip: MoveGrip | null = null;
  private moveGripEntity: Entity | null = null;
  private moveNearEntity: Entity | null = null;
  private moveFarEntity: Entity | null = null;
  private moveDriver: GripDriver | null = null;
  private needsPlacement = false;
  private placedInSession = false;
  private readonly handleWorld = new Vector3();
  private readonly cueLocal = new Vector3();
  private glowMaterial: MeshStandardMaterial | null = null;
  private crownMaterial: MeshStandardMaterial | null = null;
  private fillMaterial: MeshBasicMaterial | null = null;
  private fillMesh: Object3D | null = null;
  private cueTag: Object3D | null = null;
  private cueDots: MeshBasicMaterial | null = null;
  /** First successful grab retires the cue for the whole page lifetime. */
  private cueRetired = false;
  /** NOW-pill snap flash: 0 = idle, otherwise seconds since the flash start. */
  private snapFlashT = -1;
  /** Hour-crossing detent flash on the guide fill: 0..1 decay, no allocation. */
  private hourPing = 0;

  init(): void {
    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((state) => {
        if (state === VisibilityState.NonImmersive) this.placedInSession = false;
        this.needsPlacement = state === VisibilityState.Visible && !this.placedInSession;
      }),
      this.queries.grabbed.subscribe('qualify', (entity) => {
        // The shared `grabbed` query also matches the rail move-grip
        // entities; only TimelineHandle holders (knob near entity or ray
        // scrub proxy) drive the playhead. Move-grip feedback lives in its
        // driver, so ignoring it here changes no bus behavior.
        if (!entity.hasComponent(TimelineHandle)) return;
        this.grabbedHandle = entity;
        if (!this.cueRetired) {
          this.cueRetired = true;
          this.hideCueTag();
        }
        weatherEvents.emit(WeatherEvent.TimelineGrab);
        pulseHaptics(this.world, Haptics.grab.intensity, Haptics.grab.durationMs);
      }),
      this.queries.grabbed.subscribe('disqualify', () => {
        const wasLive = weatherStore.state.peek().isLive;
        this.grabbedHandle = null;
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
    // Dedicated whole-rail move grip: hangs below the housing, clear of the
    // knob travel band (|x| <= 0.45) and the cue tag above. Two coincident
    // meshes because OneHandGrabbable (near: squeeze/pinch) and
    // DistanceGrabbable (ray trigger) are mutually exclusive per entity.
    const moveGrip = buildMoveGrip('Weather Timeline Move Grip', MOVE_GRIP_SIZE[0], MOVE_GRIP_SIZE[1], MOVE_GRIP_SIZE[2]);
    moveGrip.group.position.copy(MOVE_GRIP_OFFSET);
    moveGrip.near.name = 'Weather Timeline Move Grip Near';
    moveGrip.far.name = 'Weather Timeline Move Grip Far';
    this.moveGrip = moveGrip;
    this.moveGripEntity = this.world.createTransformEntity(moveGrip.group, { parent: this.railEntity });
    this.moveNearEntity = this.world.createTransformEntity(moveGrip.near, { parent: this.moveGripEntity });
    this.moveFarEntity = this.world.createTransformEntity(moveGrip.far, { parent: this.moveGripEntity });
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
    this.moveDriver = createGripDriver(this.world, this.moveNearEntity, this.moveFarEntity, moveGrip);

    this.cleanupFuncs.push(() => {
      this.moveNearEntity?.dispose();
      this.moveFarEntity?.dispose();
      this.scrubProxyEntity?.dispose();
      rayTarget.geometry.dispose();
      rayTarget.material.dispose();
      this.moveGripEntity?.dispose();
      moveGrip.near.geometry.dispose();
      moveGrip.material.dispose();
      this.handleEntity?.dispose();
      this.railEntity?.dispose();
    });
  }

  /**
   * Floating first-use tag: a small cyan card + a `timelineHint`-length row of
   * authored dots (pure geometry, no fonts/DOM), parented to the rail above
   * the knob so it never covers the weather panel. The dot count tracks the
   * hint length, so EN/RU both shape the tag without new dictionary keys.
   */
  private buildCueTag(): void {
    const rail = this.railEntity?.object3D;
    if (rail == null || this.cueTag != null) return;
    const card = new Mesh(
      new PlaneGeometry(CUE_CARD_W, CUE_CARD_H),
      new MeshBasicMaterial({ color: 0x060b18, transparent: true, opacity: 0.82, side: DoubleSide }),
    );
    card.name = 'TimelineCueCard';
    card.position.copy(CUE_TAG_OFFSET);
    rail.add(card);
    this.cueTag = card;
    this.refreshCueDots();
    const refresh = (): void => {
      if (!this.cueRetired && this.cueTag != null) this.refreshCueDots();
    };
    this.cleanupFuncs.push(onLanguageChange(refresh));
  }

  /** Dot row length follows the active `timelineHint` string, wrapped in two rows. */
  private refreshCueDots(): void {
    const tag = this.cueTag;
    if (tag == null) return;
    const previous = tag.getObjectByName('TimelineCueDots');
    if (previous != null) tag.remove(previous);
    const hint = t('timelineHint');
    const slots = Math.max(8, Math.min(28, hint.length));
    const cols = Math.min(slots, 14);
    const rows = Math.ceil(slots / cols);
    const positions: number[] = [];
    for (let i = 0; i < slots; i += 1) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx = (col - (cols - 1) / 2) * CUE_DOT_PITCH;
      const cy = rows === 1 ? 0 : ((rows - 1) / 2 - row) * CUE_DOT_PITCH * 1.6;
      const segments = 8;
      for (let s = 0; s < segments; s += 1) {
        const a0 = (s / segments) * Math.PI * 2;
        const a1 = ((s + 1) / segments) * Math.PI * 2;
        positions.push(
          cx, cy, 0.0008,
          cx + Math.cos(a0) * CUE_DOT_R, cy + Math.sin(a0) * CUE_DOT_R, 0.0008,
          cx + Math.cos(a1) * CUE_DOT_R, cy + Math.sin(a1) * CUE_DOT_R, 0.0008,
        );
      }
    }
    const dotsGeometry = new BufferGeometry();
    dotsGeometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    dotsGeometry.computeVertexNormals();
    if (this.cueDots == null) {
      this.cueDots = new MeshBasicMaterial({ color: 0x79d7f2, side: DoubleSide });
    }
    const dots = new Mesh(dotsGeometry, this.cueDots);
    dots.name = 'TimelineCueDots';
    tag.add(dots);
  }

  private hideCueTag(): void {
    const tag = this.cueTag;
    if (tag != null && tag.parent != null) tag.parent.remove(tag);
    this.cueTag = null;
  }

  update(delta: number): void {
    if (this.railEntity == null || this.handleEntity == null) return;
    // Dedicated whole-rail move grip runs before knob math: the rail (and
    // therefore the knob constraint frame) may move under the hand. Moving
    // the rail never writes the playhead; the knob pass below still maps the
    // handle inside the moved frame.
    if (this.moveDriver != null && this.railEntity.object3D != null) {
      this.moveDriver.update(this.railEntity.object3D);
    }

    if (this.needsPlacement && this.railEntity.object3D != null) {
      placeControlAtViewer(this.railEntity.object3D, this.world, PLACEMENT_DISTANCE, PLACEMENT_HEIGHT_OFFSET);
      this.railEntity.object3D.rotateX(FACE_TILT_X);
      this.railEntity.object3D.updateMatrixWorld(true);
      this.needsPlacement = false;
      this.placedInSession = true;
      if (!this.cueRetired && this.cueTag == null) this.buildCueTag();
    }

    const state = weatherStore.state.peek();
    const handle = this.grabbedHandle;
    const grabbed = handle != null;
    const hovered = this.queries.hovered.entities.size > 0 || grabbed;
    const cueActive = !this.cueRetired && this.cueTag != null;

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
      this.glowMaterial.emissiveIntensity = grabbed
        ? 3.2 + pulse * 0.8
        : hovered ? 2.4 : cueActive ? 1.6 + pulse * 1.2 : 1.6;
      // Unmistakable NOW snap: the glow ring carries the snap flash on top
      // of hover/grab feedback for one shared moment.
      this.glowMaterial.emissiveIntensity += snapFlash * 3.0;
    }
    if (this.crownMaterial != null) {
      this.crownMaterial.emissiveIntensity = grabbed ? 0.6 : hovered ? 0.35 : cueActive ? 0.15 + pulse * 0.35 : 0.15;
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
    // The cue tag rides above the knob and breathes with it — no allocation.
    if (this.cueTag != null) {
      this.cueLocal.set(knobX * 0.35, CUE_TAG_OFFSET.y + Math.sin(performance.now() * 0.0032) * 0.004, CUE_TAG_OFFSET.z);
      this.cueTag.position.copy(this.cueLocal);
    }
  }

}
