/**
 * Panel system: weather hero, selected time, key values and honest source
 * status; explicit sandbox, location and XR controls. Text pushes are
 * throttled to 2 Hz and deduplicated. Initial placement is once per session;
 * handheld screen AR uses native DOM controls instead of this spatial panel.
 */

import {
  createSystem,
  DistanceGrabbable,
  Grabbed,
  GrabSystem,
  Hovered,
  MovementMode,
  OneHandGrabbable,
  PokeInteractable,
  Pressed,
  RayInteractable,
  UIKitMLAsset,
  VisibilityState,
  Vector3,
} from '@iwsdk/core';
import type { Component as UIKitComponent } from '@pmndrs/uikit';
import type { Entity, Object3D } from '@iwsdk/core';
import { WeatherControlGrip } from './control-grab-intent.js';
import { usesSpatialControls } from '../capabilities.js';
import { WeatherEvent, weatherEvents, weatherStore } from '../weather-state.js';
import type { HourCrossedDetail, SandboxToggleDetail } from '../weather-state.js';
import { playheadTime } from '../weather-state.js';
import { Haptics, pulseHaptics } from '../feedback.js';
import {
  formatMissing,
  getLanguage,
  localizeLoadingLabel,
  localizePlaceLabel,
  localizePresetLabel,
  onLanguageChange,
  providerOf,
  sourceStatus,
  t,
  toggleLanguage,
  weatherCodeName,
} from '../i18n.js';
import { PROVIDER_DISPLAY } from '../providers.js';
import { LOCATION_PRESETS, setManualLocation } from '../weather-data.js';
import { reloadWeather } from './weather-loader.js';
import { PanelMoveGrip } from '../components/timeline-handle.js';
import {
  baselineAngularSize,
  buildAffordance,
  collectHoverHands,
  ContactImpulse,
  createAngularSizeState,
  createGripDriver,
  createSurfaceGrab,
  createViewPullState,
  faceViewer,
  placeControlAtViewer,
  playSandboxCue,
  stepAngularSize,
  stepViewDistance,
  thumbstickY,
  unlockGripAudio,
} from '../control-placement.js';
import type { Affordance, AngularSizeState, GripDriver, Handedness, SurfaceGrab, ViewPullState } from '../control-placement.js';
import { installSpatialFonts } from '../spatial-fonts.js';

/** Minimum seconds between panel text pushes (2 Hz ceiling). */
const PANEL_PUSH_INTERVAL_S = 0.5;

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/** Mode-pill surfaces: live cyan / demo amber (existing panel tokens). */
const PILL_BASE_LIVE = '#79d7f2';
const PILL_BASE_DEMO = '#f2b63d';
const PILL_BASE_LOADING = '#2a3c5e';
/** Hover highlight = base lightened ~30 %; precomputed, no per-frame mix. */
const PILL_HOVER_LIVE = '#a5e5f7';
const PILL_HOVER_DEMO = '#f7d084';
const PILL_FLASH = '#ffffff';
/** Sandbox button surfaces: neutral slate OFF, amber ON (live pill stays cyan). */
const SANDBOX_BG_OFF = '#1d2f52';
const SANDBOX_BG_ON = '#f2b63d';
const SANDBOX_TEXT_OFF = '#d7e6fb';
const SANDBOX_TEXT_ON = '#060b18';
const SANDBOX_VARIANT_OFF = 'secondary';
const SANDBOX_VARIANT_ON = 'primary';
const POKE_IMPULSE_COLOR = 0xbfe9ff;

function compassFrom(metDegrees: number): string {
  const to = (((metDegrees + 180) % 360) + 360) % 360;
  return COMPASS[Math.round(to / 45) % 8];
}

/** Format one measurement; `--` marks values the dataset does not provide. */
function valueOrDash(value: number, format: (n: number) => string, unit: string): string {
  return Number.isFinite(value) ? `${format(value)} ${unit}` : formatMissing(unit);
}

/** A UIKitML text-line container: child text inherits the parent `text` prop. */
interface TextLine {
  setProperties(props: Record<string, unknown>): void;
}

function asTextLine(el: UIKitComponent | null): TextLine | null {
  // UIKitML instantiates <div> lines as Containers whose child Text reads
  // the parent `text` prop (verified in @drawcall/uikitml instantiate.js).
  if (el == null || !('setProperties' in el)) return null;
  const candidate = el as unknown as TextLine;
  return typeof candidate.setProperties === 'function' ? candidate : null;
}

export class PanelSystem extends createSystem({
  grabbed: { required: [Grabbed] },
}) {
  private statusEl: TextLine | null = null;
  private locationEl: TextLine | null = null;
  private playheadEl: TextLine | null = null;
  private heroEl: TextLine | null = null;
  private valuesEl: TextLine | null = null;
  private modeEl: TextLine | null = null;
  private lastPushAt = -PANEL_PUSH_INTERVAL_S;
  private reloadBusy = false;
  private lastText = '';
  private needsPlacement = false;
  private placedInSession = false;
  /** Last computed spatial-panel visibility (usesSpatialControls gate). */
  private spatialVisible = false;
  private snapFlashT = -1;
  private pillBase = PILL_BASE_LOADING;
  /** Whole-panel move affordance (Control Bar + edge handles). */
  private affordance: Affordance | null = null;
  private affordanceEntity: Entity | null = null;
  private affordanceNearEntity: Entity | null = null;
  private affordanceFarEntity: Entity | null = null;
  private moveDriver: GripDriver | null = null;
  private surfaceGrab: SurfaceGrab | null = null;
  private pickerLocationEl: TextLine | null = null;
  private needsAffordanceSeat = true;
  private affordanceBaseScale = 1;
  private panelObject: UIKitMLAsset | null = null;
  private wasCarried = false;
  private readonly angularSize: AngularSizeState = createAngularSizeState();
  private readonly viewPull: ViewPullState = createViewPullState();
  private readonly gripWorldScale = new Vector3();
  private readonly probeTargets: Object3D[] = [];
  /** Panel scene entity carrying PokeInteractable for touch input. */
  private pokeEntity: Entity | null = null;
  /** Raw pill element, the anchor for the poke impulse flash. */
  private modeElement: Object3D | null = null;
  private sandboxElement: Object3D | null = null;
  /** Sandbox button + hint rows as text lines for the toggle copy. */
  private sandboxButtonEl: TextLine | null = null;
  private sandboxLabelEl: TextLine | null = null;
  private sandboxHintEl: TextLine | null = null;
  /** Paired visual for poke presses and sandbox flips. */
  private pokeImpulse: ContactImpulse | null = null;
  /** Poke/ray press flash on the pill: 0 = idle, seconds since start. */
  private pressFlashT = -1;
  private wasPressed = false;
  /** Last pill background written; dedupes the per-frame color path. */
  private lastPillBg: string | null = null;
  private readonly impulseAt = new Vector3();

  init(): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('weather-panel');
    const exitButton = panel?.requireElementById('exit-button');
    if (panel == null) return;
    installSpatialFonts(panel);
    this.enableSurfaceDepth(panel);
    const panelRoot = panel.requireElementById('weather-root');
    // Phone XR (screen/transient-pointer only) keeps native touch controls:
    // the spatial panel + rail are hidden since unhanded taps cannot reach
    // poke/ray targets designed for tracked hands. Checked on visibility
    // edges AND every frame (update) + input-source transitions reveal
    // delayed tracked hands without freezing the UI either way.
    const syncSpatialVisibility = (state: VisibilityState): void => {
      const spatial = state !== VisibilityState.NonImmersive && usesSpatialControls(this.world);
      panel.visible = spatial;
      panelRoot.setProperties({ display: spatial ? 'flex' : 'none' });
      if (state === VisibilityState.NonImmersive) this.placedInSession = false;
      if (state === VisibilityState.Visible) unlockGripAudio();
      this.needsPlacement = state === VisibilityState.Visible && !this.placedInSession && spatial;
      this.spatialVisible = spatial;
    };
    this.cleanupFuncs.push(this.world.visibilityState.subscribe(syncSpatialVisibility));
    syncSpatialVisibility(this.world.visibilityState.peek());
    this.statusEl = asTextLine(panel.getElementById('status-line'));
    this.locationEl = asTextLine(panel.getElementById('location-line'));
    this.pickerLocationEl = asTextLine(panel.getElementById('picker-location-line'));
    this.playheadEl = asTextLine(panel.getElementById('playhead-line'));
    this.heroEl = asTextLine(panel.getElementById('hero-line'));
    this.valuesEl = asTextLine(panel.getElementById('values-line'));
    this.modeEl = asTextLine(panel.getElementById('mode-badge'));
    // Poke: the panel scene entity gains PokeInteractable, so the framework
    // InputSystem enables touch-under-fingertip pointers, computes BVH over
    // the UI meshes in this subtree, and routes contact into the same
    // Hovered/Pressed + UIKit click path the ray pointer already uses.
    const pokeEntity = this.world.getSceneEntity('weather-panel');
    if (pokeEntity != null) {
      pokeEntity.addComponent(PokeInteractable, {});
      this.pokeEntity = pokeEntity;
    }
    this.modeElement = panel.requireElementById('mode-badge');
    this.sandboxElement = panel.requireElementById('sandbox-button');
    this.sandboxButtonEl = asTextLine(panel.getElementById('sandbox-button'));
    this.sandboxLabelEl = asTextLine(panel.getElementById('sandbox-label'));
    this.sandboxHintEl = asTextLine(panel.getElementById('sandbox-hint'));
    this.pokeImpulse = new ContactImpulse(this.world, POKE_IMPULSE_COLOR, 'Panel Poke Impulse');
    this.cleanupFuncs.push(
      () => {
        const entity = this.pokeEntity;
        if (entity != null && entity.active) entity.removeComponent(PokeInteractable);
        this.pokeEntity = null;
      },
      () => {
        this.pokeImpulse?.dispose();
        this.pokeImpulse = null;
      },
    );

    const backButton = panel.requireElementById('back-button');
    const forwardButton = panel.requireElementById('forward-button');
    const nowButton = panel.requireElementById('now-button');
    const reloadButton = panel.requireElementById('reload-button');
    const langButton = panel.getElementById('lang-button');
    backButton.name = 'weather-step-back';
    forwardButton.name = 'weather-step-forward';
    nowButton.name = 'weather-go-live';
    reloadButton.name = 'weather-reload';
    if (langButton != null) langButton.name = 'weather-toggle-language';
    const tick = (): void => {
      weatherEvents.emit(WeatherEvent.UiPress);
      pulseHaptics(this.world, Haptics.lightTap.intensity, Haptics.lightTap.durationMs);
    };
    // Firm single pulse around XR transitions: the click itself is still a
    // deliberate press (light tick via tick()), the firm tap marks entry/exit.
    const firmTap = (): void => {
      pulseHaptics(this.world, Haptics.firmTap.intensity, Haptics.firmTap.durationMs);
    };
    const stepBack = () => {
      tick();
      weatherStore.setPlayhead(weatherStore.state.peek().playheadHours - 6);
    };
    const stepForward = () => {
      tick();
      weatherStore.setPlayhead(weatherStore.state.peek().playheadHours + 6);
    };
    const goLive = () => {
      tick();
      weatherStore.goLive();
    };
    const reload = () => {
      tick();
      void reloadWeather();
    };
    const switchLanguage = () => {
      tick();
      toggleLanguage();
    };
    const openLocations = () => {
      tick();
      this.showLocationPicker(panel, true);
    };
    const closeLocations = () => {
      tick();
      this.showLocationPicker(panel, false);
    };
    for (const preset of LOCATION_PRESETS) {
      const button = panel.requireElementById(`location-${preset.id}`);
      button.name = `weather-location-${preset.id}`;
      const chooseLocation = () => {
        tick();
        setManualLocation({ latitude: preset.latitude, longitude: preset.longitude, label: preset.label });
        this.showLocationPicker(panel, false);
        void reloadWeather();
      };
      button.addEventListener('click', chooseLocation);
      this.cleanupFuncs.push(() => button.removeEventListener('click', chooseLocation));
    }
    const autoButton = panel.requireElementById('location-auto-button');
    autoButton.name = 'weather-location-auto';
    const chooseAuto = () => {
      tick();
      setManualLocation(null);
      this.showLocationPicker(panel, false);
      void reloadWeather();
    };
    const closeButton = panel.requireElementById('location-back-button');
    closeButton.name = 'weather-location-back';
    autoButton.addEventListener('click', chooseAuto);
    closeButton.addEventListener('click', closeLocations);
    this.cleanupFuncs.push(
      () => autoButton.removeEventListener('click', chooseAuto),
      () => closeButton.removeEventListener('click', closeLocations),
    );
    backButton?.addEventListener('click', stepBack);
    forwardButton?.addEventListener('click', stepForward);
    nowButton?.addEventListener('click', goLive);
    reloadButton?.addEventListener('click', reload);
    langButton?.addEventListener('click', switchLanguage);
    const locationButton = panel.getElementById('location-button');
    if (locationButton != null) locationButton.name = 'weather-open-locations';
    locationButton?.addEventListener('click', openLocations);
    // Clap-sandbox toggle: a labelled Button with visible OFF/ON status.
    // The clap detector lives in gesture-sandbox.ts and only fires while
    // the flag is on; hand push (hand-field) is a separate XR-only path.
    const sandboxToggle = panel.requireElementById('sandbox-button');
    sandboxToggle.name = 'weather-toggle-sandbox';
    const toggleSandbox = () => {
      tick();
      weatherStore.setSandbox(!weatherStore.state.peek().sandbox);
    };
    sandboxToggle.addEventListener('click', toggleSandbox);
    this.cleanupFuncs.push(() => sandboxToggle.removeEventListener('click', toggleSandbox));
    if (exitButton != null && this.world.xrEnabled) {
      exitButton.name = 'weather-exit-xr';
      const exitXR = () => {
        tick();
        firmTap();
        void this.world.exitXR();
      };
      exitButton.addEventListener('click', exitXR);
      this.cleanupFuncs.push(() => exitButton.removeEventListener('click', exitXR));
    }
    this.cleanupFuncs.push(
      () => backButton?.removeEventListener('click', stepBack),
      () => forwardButton?.removeEventListener('click', stepForward),
      () => nowButton?.removeEventListener('click', goLive),
      () => reloadButton?.removeEventListener('click', reload),
      () => langButton?.removeEventListener('click', switchLanguage),
      () => locationButton?.removeEventListener('click', openLocations),
      // Instant re-render on language switch: drop the dedupe cache so the
      // next update() push goes through even when the weather is unchanged.
      onLanguageChange(() => {
        this.lastText = '';
        this.applyStaticLabels(panel);
        this.lastPushAt = -PANEL_PUSH_INTERVAL_S;
      }),
      // Same shared hour moment as the guide fill, room pulse, detent
      // haptic, and tick audio: refresh immediately (skip the 2 Hz
      // throttle) and flash the NOW pill on a snap arrival.
      weatherEvents.on(WeatherEvent.HourCrossed, (detail: unknown) => {
        const crossed = detail as HourCrossedDetail | undefined;
        if (crossed?.isLive === true) this.snapFlashT = 0;
        this.lastPushAt = -PANEL_PUSH_INTERVAL_S;
      }),
      // Sandbox flip: restyle the labelled button immediately and answer
      // with the gesture cue pair (audio sweep + impulse at the button)
      // and a controller haptic — hands get the cue pair instead.
      weatherEvents.on(WeatherEvent.SandboxToggle, (detail: unknown) => {
        const on = (detail as SandboxToggleDetail | undefined)?.on === true;
        this.applySandboxState(on);
        playSandboxCue(on);
        pulseHaptics(this.world, Haptics.sandboxToggle.intensity, Haptics.sandboxToggle.durationMs);
        const anchor = this.sandboxElement;
        if (anchor != null && this.pokeImpulse != null) {
          anchor.getWorldPosition(this.impulseAt);
          this.pokeImpulse.trigger(this.impulseAt);
        }
        this.lastText = '';
        this.lastPushAt = -PANEL_PUSH_INTERVAL_S;
      }),
    );
    this.applyStaticLabels(panel);
    this.ensureAffordance(panel);
    const stopSizeWatch = panel.document.rootElement.size?.subscribe(() => {
      this.needsAffordanceSeat = true;
      // A layout pass can replace or add surface meshes; keep their depth
      // writes on so the panel always resolves depth against the rail.
      this.enableSurfaceDepth(panel);
    });
    if (stopSizeWatch != null) this.cleanupFuncs.push(stopSizeWatch);
    this.cleanupFuncs.push(() => {
      this.affordanceNearEntity?.dispose();
      this.affordanceFarEntity?.dispose();
      this.affordanceEntity?.dispose();
      this.affordance?.dispose();
      this.affordance = null;
      this.affordanceEntity = null;
      this.affordanceNearEntity = null;
      this.affordanceFarEntity = null;
      this.moveDriver = null;
      this.surfaceGrab = null;
    });
  }

  /**
   * The UIKit surface is an alpha-blended quad, so by default it never writes
   * depth: the rail's additive light guide could then be drawn over the panel
   * regardless of which one is nearer, and the pair flipped order frame to
   * frame. Writing depth (three's LessEqual test keeps stacked UI layers
   * intact) makes the panel and the rail resolve each other by distance, which
   * is the same rule the native compositor uses. There is one panel in this
   * app, so the shared UIKit material is updated in place rather than cloned -
   * cloning would detach it from the renderer that keeps it in sync.
   */
  private enableSurfaceDepth(panel: UIKitMLAsset): void {
    panel.document?.traverse((child) => {
      // Duck-typed on purpose: the UIKit surface, its MSDF text and any future
      // layer are all renderables carrying a material, and only one flag is
      // touched. The named cast keeps the unchecked read in one place.
      const renderable = child as unknown as { material?: unknown };
      const source = renderable.material;
      if (source == null) return;
      const materials = Array.isArray(source) ? source : [source];
      for (const entry of materials) {
        if (entry == null || typeof entry !== 'object') continue;
        const material = entry as { depthWrite?: boolean };
        if (typeof material.depthWrite === 'boolean') material.depthWrite = true;
      }
    });
  }

  private showLocationPicker(panel: UIKitMLAsset, open: boolean): void {
    panel.requireElementById('weather-view').setProperties({ display: open ? 'none' : 'flex' });
    panel.requireElementById('location-picker').setProperties({ display: open ? 'flex' : 'none' });
  }

  /**
   * Whole-panel move affordance, scene-level so the driver stays 1:1. The
   * resting bar remains discoverable; hover reveals its edge handles in the
   * platform colors.
   */
  private ensureAffordance(panel: UIKitMLAsset): void {
    if (this.affordance != null) return;
    const size = panel.document.rootElement.size?.value;
    panel.updateWorldMatrix(true, true);
    panel.document.getWorldScale(this.gripWorldScale);
    const worldScale = Math.max(1e-4, this.gripWorldScale.x);
    this.affordanceBaseScale = worldScale;
    const heightM = (size?.[1] ?? 410) / 100 * worldScale;
    const affordance = buildAffordance({ name: 'Weather Panel Move Affordance', heightM });
    this.affordance = affordance;
    this.affordanceEntity = this.world.createTransformEntity(affordance.group);
    this.probeTargets.push(panel);
    this.seatAffordance(panel);
    this.affordanceNearEntity = this.world.createTransformEntity(affordance.near, { parent: this.affordanceEntity });
    this.affordanceFarEntity = this.world.createTransformEntity(affordance.far, { parent: this.affordanceEntity });
    this.affordanceNearEntity.addComponent(PanelMoveGrip, {});
    this.affordanceFarEntity.addComponent(PanelMoveGrip, {});
    this.affordanceNearEntity.addComponent(RayInteractable, {});
    this.affordanceFarEntity.addComponent(RayInteractable, {});
    this.affordanceNearEntity.addComponent(OneHandGrabbable, { rotate: false });
    this.affordanceNearEntity.addComponent(WeatherControlGrip, {});
    this.affordanceFarEntity.addComponent(DistanceGrabbable, {
      rotate: false,
      scale: false,
      movementMode: MovementMode.MoveFromTarget,
      returnToOrigin: false,
    });
    this.moveDriver = createGripDriver(this.world, this.affordanceNearEntity, this.affordanceFarEntity, affordance, {
      // Carry keeps the panel facing the viewer (yaw + pitch track the head,
      // roll stays 0) and keeps its angular size while translation stays a
      // kinematic 1:1 - no spring, no inertia, no snap-to-hand.
      onHeld: (root, dt, hand) => this.carryPanel(root, dt, hand),
      // Anywhere on the panel surface counts as hover, not only the thin frame.
      probeHoverHands: (out) => { collectHoverHands(this.world, this.probeTargets, out); },
    });
    // Native window grab: pointing anywhere at the panel and squeezing moves it.
    // A hand already holding the trigger elsewhere (or a direct grab on this
    // hand) keeps its capture; promotion is skipped for that hand.
    this.surfaceGrab = createSurfaceGrab(this.world, this.probeTargets, affordance.far, this.affordanceNearEntity, {
      isHandBusy: (hand) => this.isHandBusy(hand),
    });
  }

  /** True while `hand` already holds any grabbed entity (ray or direct grab). */
  private isHandBusy(hand: Handedness): boolean {
    const grabSystem = this.world.getSystem(GrabSystem) ?? null;
    if (grabSystem == null) return false;
    for (const entity of this.queries.grabbed.entities) {
      if (grabSystem.getHolderHand(entity) === hand) return true;
    }
    return false;
  }

  /**
   * Per-frame carry behaviour: face the viewer, pull/push along the view ray
   * from the holding hand's thumbstick, keep angular size, re-seat the bar.
   */
  private carryPanel(root: Object3D, delta: number, hand: Handedness | null): void {
    const head = this.world.player.head;
    faceViewer(root, head, 'auto');
    stepViewDistance(root, head, thumbstickY(this.world, hand), this.viewPull, delta);
    stepAngularSize(root, head, this.angularSize, delta);
    const panel = this.panelObject;
    if (panel != null) this.seatAffordance(panel);
  }

  /** Glue the frame to the panel's live world transform and scale. */
  private seatAffordance(panel: UIKitMLAsset): void {
    const affordance = this.affordance;
    if (affordance == null) return;
    panel.updateWorldMatrix(true, true);
    panel.document.getWorldPosition(affordance.group.position);
    panel.document.getWorldQuaternion(affordance.group.quaternion);
    panel.document.getWorldScale(this.gripWorldScale);
    affordance.group.scale.setScalar(this.gripWorldScale.x / this.affordanceBaseScale);
    affordance.group.parent?.worldToLocal(affordance.group.position);
    affordance.group.updateMatrixWorld(true);
    this.needsAffordanceSeat = false;
  }
  update(delta: number, time: number): void {
    // The whole-panel move affordance drives the panel before any text work.
    // Released transforms persist: the one-time session placement below only
    // runs when the flag is set (new session), never as an overwrite after the
    // user moved the panel.
    const dt = Number.isFinite(delta) ? Math.min(Math.max(delta, 0), 0.1) : 0.016;
    const panelObject = this.world.getSceneObject<UIKitMLAsset>('weather-panel') ?? this.panelObject;
    this.panelObject = panelObject;
    // Delayed input-source arrival (tracked hands appear after session
    // start) must unhide the spatial panel without a visibility edge.
    const wantSpatial =
      this.world.visibilityState.peek() !== VisibilityState.NonImmersive && usesSpatialControls(this.world);
    if (wantSpatial !== this.spatialVisible && panelObject != null) {
      this.spatialVisible = wantSpatial;
      panelObject.visible = wantSpatial;
      panelObject.requireElementById('weather-root').setProperties({ display: wantSpatial ? 'flex' : 'none' });
      if (wantSpatial && !this.placedInSession) this.needsPlacement = true;
    }
    const carried = this.affordanceNearEntity?.hasComponent(Grabbed) === true
      || this.affordanceFarEntity?.hasComponent(Grabbed) === true;
    if (panelObject != null) {
      if (this.affordance != null) this.affordance.group.visible = panelObject.visible;
      // Angular size is preserved relative to the grab pose, so a fresh grab
      // never jumps and a released size is the new reference. The push/pull
      // velocity restarts from rest on every grab.
      if (carried && !this.wasCarried) {
        baselineAngularSize(panelObject, this.world.player.head, this.angularSize);
        this.viewPull.velocity = 0;
      }
      this.wasCarried = carried;
      if (this.needsAffordanceSeat && !carried) this.seatAffordance(panelObject);
      if (this.moveDriver != null) {
        this.surfaceGrab?.update();
        this.moveDriver.update(panelObject, dt);
        // After a carry that re-oriented the panel the frame must follow the
        // panel's new pose; `seatAffordance` re-derives it from the surface.
        if (this.moveDriver.consumeReleased()) this.seatAffordance(panelObject);
      }
    }
    if (this.needsPlacement) {
      if (panelObject != null) {
        placeControlAtViewer(panelObject, this.world, 1.4, 0.18);
        this.seatAffordance(panelObject);
      }
      this.needsPlacement = false;
      this.placedInSession = true;
    }
    // Pill surface state machine, one write path (flash > hover > base).
    // The NOW-snap flash and the poke/ray press flash share the channel;
    // both decay on wall-clock delta so they read the same at any frame
    // rate. Direct update() calls without a delta fall back to 16 ms.
    const pressed = this.pokeEntity?.hasComponent(Pressed) === true;
    if (pressed && !this.wasPressed) {
      this.pressFlashT = 0;
      // Paired visual for the press: additive flash at the pill. The
      // UiPress tick rides the click path (a poke on a Button fires the
      // same UIKit click the ray pointer produces).
      const pill = this.modeElement;
      if (pill != null && this.pokeImpulse != null) {
        pill.getWorldPosition(this.impulseAt);
        this.pokeImpulse.trigger(this.impulseAt);
      }
    }
    this.wasPressed = pressed;
    if (this.pressFlashT >= 0) this.pressFlashT += dt;
    if (this.pressFlashT > 0.45) this.pressFlashT = -1;
    if (this.snapFlashT >= 0) this.snapFlashT += dt;
    if (this.snapFlashT > 0.45) this.snapFlashT = -1;
    this.pokeImpulse?.update(dt);
    this.pushPillBackground();
    if (this.statusEl == null || this.valuesEl == null || this.playheadEl == null) return;
    if (time - this.lastPushAt < PANEL_PUSH_INTERVAL_S && this.snapFlashT < 0) return;
    const lang = getLanguage();
    const state = weatherStore.state.peek();
    const current = weatherStore.current();
    const busy = state.status.kind === 'loading' || state.status.kind === 'locating';
    if (busy !== this.reloadBusy && panelObject != null) {
      this.reloadBusy = busy;
      this.applyStaticLabels(panelObject);
    }
    if (current == null) {
      const status = state.status;
      this.pillBase = PILL_BASE_LOADING;
      this.modeEl?.setProperties({ text: t('badgeLoading') });
      this.playheadEl.setProperties({ text: '…' });
      this.heroEl?.setProperties({ text: t('missingValue') });
      this.valuesEl.setProperties({ text: t('missingValue') });
      this.pushStatus(
        status.kind === 'loading' ? `${t('loadingPrefix')}${localizeLoadingLabel(status.label, lang)}` : t('statusLoading'),
        status.kind === 'loading' ? t('statusWaiting') : t('missingValue'),
      );
      this.lastPushAt = time;
      return;
    }
    const { dataset, playheadHours, isLive, status } = state;
    const { frame } = current;
    const staleSuffix = frame.stale ? t('staleSuffixPipe') : '';
    // A retained synthetic dataset stays DEMO even while a reload is loading.
    const demoDataset = dataset?.source === 'demo';
    const providerDisplay =
      dataset != null && !demoDataset
        ? (PROVIDER_DISPLAY[providerOf(dataset.source) as keyof typeof PROVIDER_DISPLAY] ?? providerOf(dataset.source))
        : '';
    // The honest status core already names the provider; only append a token
    // when it adds information (demo/loading/locating states).
    const providerToken =
      providerDisplay !== '' && (status.kind === 'loading' || status.kind === 'locating')
        ? ` · ${providerDisplay}`
        : '';
    // Keep provider/fallback provenance in one secondary line.
    const statusText =
      status.kind === 'demo' || demoDataset
        ? `${t('statusDemoSynthetic')}${staleSuffix}`
          : status.kind === 'ready'
            ? `${sourceStatus(providerDisplay, staleSuffix, lang)}`
            : status.kind === 'loading'
              ? `${t('loadingPrefix')}${localizeLoadingLabel(status.label, lang)}`
              : status.kind === 'locating'
                ? t('statusLocating')
                : t('statusReady');
    const locationText =
      dataset != null
        ? localizePlaceLabel(dataset.label.split(' · ').slice(1).join(' · ') || dataset.label, lang)
        : (status.kind === 'loading' ? t('statusRequestingLocation') : t('missingValue'));
    const secondaryText = `${statusText}${providerToken}${frame.outOfCoverage ? t('beyondSuffixPipe') : ''}`;
    const at = playheadTime(dataset!, playheadHours, new Date());
    const clock = `${at.getHours() < 10 ? `0${at.getHours()}` : at.getHours()}:${at.getMinutes() < 10 ? `0${at.getMinutes()}` : at.getMinutes()}`;
    const deltaLabel = isLive
      ? t('playheadNow')
      : `${clock} / ${playheadHours > 0 ? '+' : ''}${Math.round(playheadHours * 2) / 2}h`;
    const compass =
      frame.available.windSpeedKmh && frame.available.windDirectionDeg
        ? ` ${compassFrom(frame.windDirectionDeg)}`
        : '';
    const weatherCode = frame.available.weatherCode ? weatherCodeName(frame.weatherCode, lang) : t('missingValue');
    // Hero block: NOW + temperature + ONE precipitation + ONE wind line.
    // Cloud/RH/daylight stay out of the hero to keep the readout readable at
    // 0.8-1.2 m in both languages (Russian runs longer).
    const heroText =
      `${valueOrDash(frame.temperatureC, (n) => n.toFixed(1), '°C')} · ${weatherCode}`;
    const valuesText =
      `${t('rain')} ${valueOrDash(frame.precipitationMm, (n) => n.toFixed(1), 'mm/h')} ` +
      `(${valueOrDash(frame.precipitationProbabilityPct, (n) => String(Math.round(n)), '%')})\n` +
      `${t('wind')} ${valueOrDash(frame.windSpeedKmh, (n) => String(Math.round(n)), `km/h${compass}`)}`;
    const modeText = demoDataset || status.kind === 'demo' ? t('badgeDemo') : t('badgeLive');
    this.pillBase = demoDataset || status.kind === 'demo' ? PILL_BASE_DEMO : PILL_BASE_LIVE;
    const combined = `${lang}|${secondaryText}|${locationText}|${deltaLabel}|${heroText}|${valuesText}|${modeText}`;
    if (combined === this.lastText) return;
    this.lastText = combined;
    this.lastPushAt = time;
    // The pill surface (base/hover/flash) is owned by pushPillBackground,
    // which runs every frame; only the text rides the 2 Hz push.
    this.modeEl?.setProperties({ text: modeText });
    this.statusEl.setProperties({ text: secondaryText });
    this.locationEl?.setProperties({ text: locationText });
    this.pickerLocationEl?.setProperties({ text: locationText });
    this.playheadEl.setProperties({ text: deltaLabel });
    this.heroEl?.setProperties({ text: heroText });
    this.valuesEl.setProperties({ text: valuesText });
    const panel = this.world.getSceneObject<UIKitMLAsset>('weather-panel');
    if (panel != null) this.applyStaticLabels(panel);
  }

  private pushStatus(statusText: string, locationText: string): void {
    const combined = `${getLanguage()}|${statusText}|${locationText}`;
    if (combined === this.lastText) return;
    this.lastText = combined;
    this.statusEl?.setProperties({ text: statusText });
    this.locationEl?.setProperties({ text: locationText });
    this.pickerLocationEl?.setProperties({ text: locationText });
  }

  /**
   * Mode-pill surface, one write path: white during a snap/press flash, a
   * 30 %-lightened tint while any pointer (finger proximity or ray) hovers
   * the panel entity, the live/demo base otherwise. Deduped per frame.
   */
  private pushPillBackground(): void {
    const flashing = this.snapFlashT >= 0 || this.pressFlashT >= 0;
    const hovered = this.pokeEntity?.hasComponent(Hovered) === true;
    let background = this.pillBase;
    if (flashing) background = PILL_FLASH;
    else if (hovered) background = this.pillBase === PILL_BASE_DEMO ? PILL_HOVER_DEMO : PILL_HOVER_LIVE;
    if (background === this.lastPillBg) return;
    this.lastPillBg = background;
    this.modeEl?.setProperties({ backgroundColor: background });
  }

  /**
   * Sandbox toggle state: labelled Button text flips OFF/ON (whole button
   * repaints via variant + background), the hint line keeps the gesture
   * instructions in both languages. Everything reads from the dictionary.
   */
  private applySandboxState(on: boolean): void {
    const label = this.sandboxLabelEl ?? this.sandboxButtonEl;
    label?.setProperties({ text: on ? t('sandboxOn') : t('sandboxOff') });
    this.sandboxButtonEl?.setProperties({
      variant: on ? SANDBOX_VARIANT_ON : SANDBOX_VARIANT_OFF,
      backgroundColor: on ? SANDBOX_BG_ON : SANDBOX_BG_OFF,
      color: on ? SANDBOX_TEXT_ON : SANDBOX_TEXT_OFF,
    });
    this.sandboxHintEl?.setProperties({ text: on ? t('sandboxHintOn') : t('sandboxHint') });
  }

  /** Static button/hint labels (markup defaults are English-only). */
  private applyStaticLabels(panel: UIKitMLAsset): void {
    const setLabel = (id: string, text: string): void => {
      const node = panel.getElementById(id);
      if (node != null && 'setProperties' in node) {
        (node as unknown as TextLine).setProperties({ text });
      }
    };
    setLabel('back-label', t('stepBack'));
    setLabel('now-label', t('goLive'));
    setLabel('forward-label', t('stepForward'));
    setLabel('reload-label', t('reload'));
    setLabel('exit-label', t('exit'));
    setLabel('lang-label', t('langName'));
    this.applySandboxState(weatherStore.state.peek().sandbox);
    setLabel('location-label', t('locationLabelPrefix'));
    setLabel('location-picker-title', t('locationChoose'));
    setLabel('location-picker-hint', t('locationPickerHint'));
    setLabel('location-auto-label', t('locationClear'));
    setLabel('location-back-label', t('locationBack'));
    for (const preset of LOCATION_PRESETS) {
      setLabel(`location-${preset.id}-label`, preset.id === 'saint-petersburg'
        ? t('presetPetersburgShort')
        : localizePresetLabel(preset.label));
    }
    const busy = weatherStore.state.peek().status.kind === 'loading' || weatherStore.state.peek().status.kind === 'locating';
    panel.requireElementById('reload-button').setProperties({ disabled: busy });
    // The label never grows: the busy wording ("Loading…" / "Загрузка…") is the
    // longest string this panel can write and the 80 px utility box is sized for
    // "Reload" / "Обновить", while the four-column row (4 x 80 px + margins in a
    // 340 px panel) has no width left to grow. The busy state is carried by the
    // disabled styling (already applied above) plus the status line, so the
    // label always fits its box and never reflows.
    setLabel('reload-label', t('reload'));
    setLabel('timeline-hint', t('timelineHint'));
  }
}
