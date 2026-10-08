/**
 * Panel wiring for the WEATHER//ROOM spatial control: concise data hierarchy
 * (playhead hero, location, key values, honest source status), NOW/Reload
 * actions, and the template Enter/Exit XR behavior. Text pushes are throttled
 * to 2 Hz and only fire on actual changes. Placement stays once-per-session
 * via placeControlAtViewer; visibility handling is unchanged.
 */

import {
  createSystem,
  DistanceGrabbable,
  Grabbed,
  Hovered,
  MovementMode,
  OneHandGrabbable,
  RayInteractable,
  UIKitMLAsset,
  VisibilityState,
} from '@iwsdk/core';
import type { Component as UIKitComponent } from '@pmndrs/uikit';
import type { Entity, Object3D } from '@iwsdk/core';
import { WeatherEvent, weatherEvents, weatherStore } from '../weather-state.js';
import type { HourCrossedDetail } from '../weather-state.js';
import { playheadTime } from '../weather-state.js';
import { Haptics, pulseHaptics } from '../feedback.js';
import {
  formatMissing,
  getLanguage,
  localizeDataPhrase,
  localizeLoadingLabel,
  localizePlaceLabel,
  onLanguageChange,
  providerOf,
  sourceStatus,
  t,
  toggleLanguage,
  weatherCodeName,
} from '../i18n.js';
import { PROVIDER_DISPLAY } from '../providers.js';
import { LOCATION_PRESETS, getManualLocation, setManualLocation } from '../weather-data.js';
import { reloadWeather } from './weather-loader.js';
import { PanelMoveGrip } from '../components/timeline-handle.js';
import {
  buildMoveGrip,
  createGripDriver,
  placeControlAtViewer,
} from '../control-placement.js';
import type { GripDriver, MoveGrip } from '../control-placement.js';
import { installSpatialFonts } from '../spatial-fonts.js';

/** Minimum seconds between panel text pushes (2 Hz ceiling). */
const PANEL_PUSH_INTERVAL_S = 0.5;

/**
 * Dedicated whole-panel move grip: a bar hung below the UIKit panel, clear
 * of every button row. Same dual-mesh pattern as the timeline rail grip:
 * near-hand squeeze/pinch on one entity, distance ray trigger on the other.
 */
const PANEL_GRIP_OFFSET_Y = -0.42;
const PANEL_GRIP_SIZE: readonly [number, number, number] = [0.22, 0.03, 0.03];

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

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
  moveHovered: { required: [PanelMoveGrip, Hovered] },
  moveGrabbed: { required: [PanelMoveGrip, Grabbed] },
}) {
  private statusEl: TextLine | null = null;
  private locationEl: TextLine | null = null;
  private playheadEl: TextLine | null = null;
  private heroEl: TextLine | null = null;
  private valuesEl: TextLine | null = null;
  private modeEl: TextLine | null = null;
  private revisionEl: TextLine | null = null;
  private lastPushAt = -PANEL_PUSH_INTERVAL_S;
  private lastText = '';
  private needsPlacement = false;
  private placedInSession = false;
  private snapFlashT = -1;
  private pillBase = '#79d7f2';
  /** Dedicated whole-panel move grip (scene-level bar + driver). */
  private moveGrip: MoveGrip | null = null;
  private moveGripObject: Object3D | null = null;
  private moveGripEntity: Entity | null = null;
  private moveNearEntity: Entity | null = null;
  private moveFarEntity: Entity | null = null;
  private moveDriver: GripDriver | null = null;

  init(): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('weather-panel');
    const xrButton = panel?.requireElementById('xr-button');
    const exitButton = panel?.requireElementById('exit-button');
    if (panel == null) return;
    installSpatialFonts(panel);
    const panelRoot = panel.requireElementById('weather-root');
    this.cleanupFuncs.push(this.world.visibilityState.subscribe((state) => {
      panel.visible = state !== VisibilityState.NonImmersive;
      panelRoot.setProperties({ display: panel.visible ? 'flex' : 'none' });
      if (state === VisibilityState.NonImmersive) this.placedInSession = false;
      this.needsPlacement = state === VisibilityState.Visible && !this.placedInSession;
    }));
    this.statusEl = asTextLine(panel.getElementById('status-line'));
    this.locationEl = asTextLine(panel.getElementById('location-line'));
    this.playheadEl = asTextLine(panel.getElementById('playhead-line'));
    this.heroEl = asTextLine(panel.getElementById('hero-line'));
    this.valuesEl = asTextLine(panel.getElementById('values-line'));
    this.modeEl = asTextLine(panel.getElementById('mode-badge'));
    this.revisionEl = asTextLine(panel.getElementById('revision-label'));
    // Fold provider/fallback/timeout provenance into the one dim secondary
    // line: revision keeps the build id plus a short provider token.
    this.revisionEl?.setProperties({ text: `rev ${__WEATHER_ROOM_REVISION__}` });

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
    // Location cycler: Авто (device/IP) -> each preset -> back to Авто.
    // One press = one step plus reload, so the viewer can reach their own
    // coordinates from inside XR where only the spatial panel exists.
    const cycleLocation = () => {
      tick();
      const currentManual = getManualLocation();
      const index =
        currentManual == null
          ? -1
          : LOCATION_PRESETS.findIndex((preset) => preset.label === currentManual.label);
      const next = LOCATION_PRESETS[index + 1];
      if (next == null) {
        setManualLocation(null);
      } else {
        setManualLocation({ latitude: next.latitude, longitude: next.longitude, label: next.label });
      }
      void reloadWeather();
    };
    backButton?.addEventListener('click', stepBack);
    forwardButton?.addEventListener('click', stepForward);
    nowButton?.addEventListener('click', goLive);
    reloadButton?.addEventListener('click', reload);
    langButton?.addEventListener('click', switchLanguage);
    const locationButton = panel.getElementById('location-button');
    if (locationButton != null) locationButton.name = 'weather-cycle-location';
    locationButton?.addEventListener('click', cycleLocation);
    if (xrButton != null && exitButton != null) {
      if (!this.world.xrEnabled) {
        xrButton.setProperties({ display: 'none' });
        exitButton.setProperties({ display: 'none' });
      } else {
        const launchXR = () => {
          tick();
          firmTap();
          void this.world.launchXR();
        };
        const exitXR = () => {
          tick();
          firmTap();
          void this.world.exitXR();
        };
        xrButton.addEventListener('click', launchXR);
        exitButton.addEventListener('click', exitXR);
        this.cleanupFuncs.push(
          () => xrButton.removeEventListener('click', launchXR),
          () => exitButton.removeEventListener('click', exitXR),
          this.world.visibilityState.subscribe((visibilityState) => {
            const is2D = visibilityState === VisibilityState.NonImmersive;
            xrButton.setProperties({ display: is2D ? 'flex' : 'none' });
            exitButton.setProperties({ display: is2D ? 'none' : 'flex' });
          }),
        );
      }
    }
    this.cleanupFuncs.push(
      () => backButton?.removeEventListener('click', stepBack),
      () => forwardButton?.removeEventListener('click', stepForward),
      () => nowButton?.removeEventListener('click', goLive),
      () => reloadButton?.removeEventListener('click', reload),
      () => langButton?.removeEventListener('click', switchLanguage),
      () => locationButton?.removeEventListener('click', cycleLocation),
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
    );
    this.applyStaticLabels(panel);
    this.ensureMoveGrip(panel);
    this.cleanupFuncs.push(() => {
      this.moveNearEntity?.dispose();
      this.moveFarEntity?.dispose();
      this.moveGripEntity?.dispose();
      this.moveGrip?.near.geometry.dispose();
      this.moveGrip?.material.dispose();
      if (this.moveGripObject?.parent != null) this.moveGripObject.parent.remove(this.moveGripObject);
      this.moveGrip = null;
      this.moveGripObject = null;
      this.moveGripEntity = null;
      this.moveNearEntity = null;
      this.moveFarEntity = null;
      this.moveDriver = null;
    });
  }

  /** Scene-level grip group: entity parenting preserves mesh offsets. */
  private ensureMoveGrip(panel: Object3D): void {
    if (this.moveGrip != null) return;
    const grip = buildMoveGrip('Weather Panel Move Grip', PANEL_GRIP_SIZE[0], PANEL_GRIP_SIZE[1], PANEL_GRIP_SIZE[2]);
    grip.near.name = 'Weather Panel Move Grip Near';
    grip.far.name = 'Weather Panel Move Grip Far';
    this.moveGrip = grip;
    this.moveGripObject = grip.group;
    this.moveGripEntity = this.world.createTransformEntity(grip.group);
    this.seatMoveGrip(panel);
    this.moveNearEntity = this.world.createTransformEntity(grip.near, { parent: this.moveGripEntity });
    this.moveFarEntity = this.world.createTransformEntity(grip.far, { parent: this.moveGripEntity });
    this.moveNearEntity.addComponent(PanelMoveGrip, {});
    this.moveFarEntity.addComponent(PanelMoveGrip, {});
    this.moveNearEntity.addComponent(RayInteractable, {});
    this.moveFarEntity.addComponent(RayInteractable, {});
    this.moveNearEntity.addComponent(OneHandGrabbable, { rotate: false });
    this.moveFarEntity.addComponent(DistanceGrabbable, {
      rotate: false,
      scale: false,
      movementMode: MovementMode.MoveAtSource,
      returnToOrigin: false,
    });
    this.moveDriver = createGripDriver(this.world, this.moveNearEntity, this.moveFarEntity, grip, {
      yaw: true,
    });
  }

  /** Re-seat beneath the panel on new-session placement. */
  private seatMoveGrip(panel: Object3D): void {
    const grip = this.moveGrip;
    if (grip == null) return;
    panel.updateWorldMatrix(true, false);
    grip.group.position.set(0, PANEL_GRIP_OFFSET_Y, 0.02);
    panel.localToWorld(grip.group.position);
    grip.group.parent?.worldToLocal(grip.group.position);
    panel.getWorldQuaternion(grip.group.quaternion);
    grip.group.updateMatrixWorld(true);
  }
  update(delta: number, time: number): void {
    // Dedicated whole-panel move grip drives the panel before any text
    // work. Released transforms persist: the one-time session placement
    // below only runs when the flag is set (new session), never as an
    // overwrite after the user moved the panel.
    const panelObject = this.world.getSceneObject<UIKitMLAsset>('weather-panel');
    if (this.moveDriver != null && panelObject != null) {
      this.moveDriver.update(panelObject);
      // After a yawing hold the grip bar must follow the panel's new
      // orientation; position is re-derived from the panel in the same
      // pass so the bar always sits at the panel's bottom edge.
      if (this.moveDriver.consumeReleased()) this.seatMoveGrip(panelObject);
    }
    if (this.needsPlacement) {
      const panel = panelObject ?? this.world.getSceneObject<UIKitMLAsset>('weather-panel');
      if (panel != null) {
        placeControlAtViewer(panel, this.world, 1.5, 0.3);
        this.seatMoveGrip(panel);
      }
      this.needsPlacement = false;
      this.placedInSession = true;
    }
    // NOW-pill snap flash decays on wall-clock delta so it reads the same at
    // any frame rate; the flash color rides on top of the live/demo pill.
    // Direct update() calls without a delta fall back to 16 ms.
    const dt = Number.isFinite(delta) ? Math.min(Math.max(delta, 0), 0.1) : 0.016;
    if (this.snapFlashT >= 0) {
      this.snapFlashT += dt;
      const flash = Math.exp(-this.snapFlashT * 7);
      this.modeEl?.setProperties({
        backgroundColor: flash > 0.15 ? '#ffffff' : this.pillBase,
      });
      if (this.snapFlashT > 0.45) {
        this.snapFlashT = -1;
        this.modeEl?.setProperties({ backgroundColor: this.pillBase });
      }
    }
    if (this.statusEl == null || this.valuesEl == null || this.playheadEl == null) return;
    if (time - this.lastPushAt < PANEL_PUSH_INTERVAL_S && this.snapFlashT < 0) return;
    const lang = getLanguage();
    const state = weatherStore.state.peek();
    const current = weatherStore.current();
    if (current == null) {
      const status = state.status;
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
    // Headset readout hierarchy: provider/fallback/timeout provenance is
    // demoted to ONE dim secondary line (revision + provider token folded
    // in); the hero block above carries NOW + temp + precip + wind only.
    const statusText =
      status.kind === 'demo'
        ? `${t('demoPrefix')}${localizeDataPhrase(status.reason, lang)}`
        : demoDataset
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
    const secondaryText = `${statusText}${providerToken}`;
    const at = playheadTime(dataset!, playheadHours, new Date());
    const clock = `${at.getHours() < 10 ? `0${at.getHours()}` : at.getHours()}:${at.getMinutes() < 10 ? `0${at.getMinutes()}` : at.getMinutes()}`;
    const beyondData = frame.outOfCoverage ? t('beyondSuffixPipe') : '';
    const deltaLabel = isLive
      ? `${t('playheadNow')}${beyondData}`
      : `${clock} / ${playheadHours > 0 ? '+' : ''}${Math.round(playheadHours)}h${beyondData}`;
    const compass =
      frame.available.windSpeedKmh && frame.available.windDirectionDeg
        ? ` ${compassFrom(frame.windDirectionDeg)}`
        : '';
    const weatherCode = frame.available.weatherCode ? weatherCodeName(frame.weatherCode, lang) : t('missingValue');
    // Hero block: NOW + temperature + ONE precipitation + ONE wind line.
    // Cloud/RH/daylight stay out of the hero to keep the readout readable at
    // 0.8-1.2 m in both languages (Russian runs longer).
    const heroText =
      `${valueOrDash(frame.temperatureC, (n) => n.toFixed(1), 'C')} · ${weatherCode}`;
    const valuesText =
      `${t('rain')} ${valueOrDash(frame.precipitationMm, (n) => n.toFixed(1), 'mm/h')} ` +
      `(${valueOrDash(frame.precipitationProbabilityPct, (n) => String(Math.round(n)), '%')})\n` +
      `${t('wind')} ${valueOrDash(frame.windSpeedKmh, (n) => String(Math.round(n)), `km/h${compass}`)}`;
    const modeText = demoDataset || status.kind === 'demo' ? t('badgeDemo') : t('badgeLive');
    this.pillBase = demoDataset || status.kind === 'demo' ? '#f2b63d' : '#79d7f2';
    const combined = `${lang}|${secondaryText}|${locationText}|${deltaLabel}|${heroText}|${valuesText}|${modeText}`;
    if (combined === this.lastText) return;
    this.lastText = combined;
    this.lastPushAt = time;
    if (this.snapFlashT < 0) {
      this.modeEl?.setProperties({ text: modeText, backgroundColor: this.pillBase });
    } else {
      this.modeEl?.setProperties({ text: modeText });
    }
    this.statusEl.setProperties({ text: secondaryText });
    this.locationEl?.setProperties({ text: locationText });
    this.playheadEl.setProperties({ text: deltaLabel });
    this.heroEl?.setProperties({ text: heroText });
    this.valuesEl.setProperties({ text: valuesText });
    this.revisionEl?.setProperties({ text: `rev ${__WEATHER_ROOM_REVISION__}${providerToken}` });
    const panel = this.world.getSceneObject<UIKitMLAsset>('weather-panel');
    if (panel != null) this.applyStaticLabels(panel);
  }

  private pushStatus(statusText: string, locationText: string): void {
    const combined = `${getLanguage()}|${statusText}|${locationText}`;
    if (combined === this.lastText) return;
    this.lastText = combined;
    this.statusEl?.setProperties({ text: statusText });
    this.locationEl?.setProperties({ text: locationText });
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
    setLabel('xr-label', t('enterAr'));
    setLabel('exit-label', t('exit'));
    setLabel('lang-label', t('langName'));
    setLabel('timeline-hint', t('timelineHint'));
    // Spatial cycler label stays one short token (70 px button) while the
    // location line carries the full manual/auto place with provenance.
    setLabel('location-label', t('locationLabelPrefix'));
  }
}
