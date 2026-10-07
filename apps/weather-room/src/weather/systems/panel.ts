/**
 * Panel wiring for the WEATHER//ROOM spatial control: concise data hierarchy
 * (playhead hero, location, key values, honest source status), NOW/Reload
 * actions, and the template Enter/Exit XR behavior. Text pushes are throttled
 * to 2 Hz and only fire on actual changes. Placement stays once-per-session
 * via placeControlAtViewer; visibility handling is unchanged.
 */

import { createSystem, UIKitMLAsset, VisibilityState } from '@iwsdk/core';
import type { Component as UIKitComponent } from '@pmndrs/uikit';
import { weatherStore } from '../weather-state.js';
import { playheadTime } from '../weather-state.js';
import { reloadWeather } from './weather-loader.js';
import { placeControlAtViewer } from '../control-placement.js';

/** Minimum seconds between panel text pushes (2 Hz ceiling). */
const PANEL_PUSH_INTERVAL_S = 0.5;

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

function compassFrom(metDegrees: number): string {
  const to = (((metDegrees + 180) % 360) + 360) % 360;
  return COMPASS[Math.round(to / 45) % 8];
}
function weatherCodeName(code: number): string {
  if (code === 0) return 'Clear';
  if (code <= 3) return 'Clouds';
  if (code === 45 || code === 48) return 'Fog';
  if (code >= 51 && code <= 57) return 'Drizzle';
  if (code >= 61 && code <= 67) return 'Rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'Snow';
  if (code >= 80 && code <= 82) return 'Showers';
  if (code >= 95) return 'Thunder';
  return 'Weather';
}

/** Format one measurement; `--` marks values the dataset does not provide. */
function valueOrDash(value: number, format: (n: number) => string, unit: string): string {
  return Number.isFinite(value) ? `${format(value)} ${unit}` : `-- ${unit}`;
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

export class PanelSystem extends createSystem({}) {
  private statusEl: TextLine | null = null;
  private locationEl: TextLine | null = null;
  private playheadEl: TextLine | null = null;
  private valuesEl: TextLine | null = null;
  private modeEl: TextLine | null = null;
  private revisionEl: TextLine | null = null;
  private lastPushAt = -PANEL_PUSH_INTERVAL_S;
  private lastText = '';
  private needsPlacement = false;
  private placedInSession = false;

  init(): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('weather-panel');
    const xrButton = panel?.requireElementById('xr-button');
    const exitButton = panel?.requireElementById('exit-button');
    if (panel == null) return;
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
    this.valuesEl = asTextLine(panel.getElementById('values-line'));
    this.modeEl = asTextLine(panel.getElementById('mode-badge'));
    this.revisionEl = asTextLine(panel.getElementById('revision-label'));
    this.revisionEl?.setProperties({ text: `rev ${__WEATHER_ROOM_REVISION__}` });

    const backButton = panel.requireElementById('back-button');
    const forwardButton = panel.requireElementById('forward-button');
    const nowButton = panel.requireElementById('now-button');
    const reloadButton = panel.requireElementById('reload-button');
    backButton.name = 'weather-step-back';
    forwardButton.name = 'weather-step-forward';
    nowButton.name = 'weather-go-live';
    reloadButton.name = 'weather-reload';
    const stepBack = () => weatherStore.setPlayhead(weatherStore.state.peek().playheadHours - 6);
    const stepForward = () => weatherStore.setPlayhead(weatherStore.state.peek().playheadHours + 6);
    const goLive = () => weatherStore.goLive();
    const reload = () => {
      void reloadWeather();
    };
    backButton?.addEventListener('click', stepBack);
    forwardButton?.addEventListener('click', stepForward);
    nowButton?.addEventListener('click', goLive);
    reloadButton?.addEventListener('click', reload);
    if (xrButton != null && exitButton != null) {
      if (!this.world.xrEnabled) {
        xrButton.setProperties({ display: 'none' });
        exitButton.setProperties({ display: 'none' });
      } else {
        const launchXR = () => this.world.launchXR();
        const exitXR = () => this.world.exitXR();
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
    );
  }

  update(_delta: number, time: number): void {
    if (this.needsPlacement) {
      const panel = this.world.getSceneObject<UIKitMLAsset>('weather-panel');
      if (panel != null) placeControlAtViewer(panel, this.world, 1.5, 0.3);
      this.needsPlacement = false;
      this.placedInSession = true;
    }
    if (this.statusEl == null || this.valuesEl == null || this.playheadEl == null) return;
    if (time - this.lastPushAt < PANEL_PUSH_INTERVAL_S) return;
    const state = weatherStore.state.peek();
    const current = weatherStore.current();
    if (current == null) {
      const status = state.status;
      this.pushStatus(
        status.kind === 'loading' ? `Loading: ${status.label}` : 'Loading weather...',
        status.kind === 'loading' ? 'Waiting for device location / forecast...' : '--',
      );
      this.lastPushAt = time;
      return;
    }
    const { dataset, playheadHours, isLive, status } = state;
    const { frame } = current;
    const staleSuffix = frame.stale ? ' | cached' : '';
    // A retained synthetic dataset stays DEMO even while a reload is loading.
    const demoDataset = dataset?.source === 'demo';
    const statusText =
      status.kind === 'demo'
        ? `DEMO: ${status.reason}`
        : demoDataset
          ? `DEMO synthetic data${staleSuffix}`
          : status.kind === 'ready'
            ? `Live from Open-Meteo${staleSuffix}`
            : status.kind === 'loading'
              ? `Loading: ${status.label}`
              : status.kind === 'locating'
                ? 'Locating...'
                : 'Ready';
    const locationText =
      dataset?.label ?? (status.kind === 'loading' ? 'Requesting device location...' : '--');
    const at = playheadTime(dataset!, playheadHours, new Date());
    const clock = `${at.getHours() < 10 ? `0${at.getHours()}` : at.getHours()}:${at.getMinutes() < 10 ? `0${at.getMinutes()}` : at.getMinutes()}`;
    const beyondData = frame.outOfCoverage ? ' | beyond data' : '';
    const deltaLabel = isLive
      ? `NOW${beyondData}`
      : `${clock} / ${playheadHours > 0 ? '+' : ''}${Math.round(playheadHours)}h${beyondData}`;
    const compass =
      frame.available.windSpeedKmh && frame.available.windDirectionDeg
        ? ` ${compassFrom(frame.windDirectionDeg)}`
        : '';
    const weatherCode = frame.available.weatherCode ? weatherCodeName(frame.weatherCode) : '--';
    // Concise hero hierarchy: hero temp + condition, then one compact row each
    // for precip/wind/sky. Full detail stays in the browser panel.
    const valuesText =
      `${valueOrDash(frame.temperatureC, (n) => n.toFixed(1), 'C')} ` +
      `(${valueOrDash(frame.apparentTemperatureC, (n) => n.toFixed(1), 'C')} feels) · ${weatherCode}\n` +
      `rain ${valueOrDash(frame.precipitationMm, (n) => n.toFixed(1), 'mm/h')} ` +
      `(${valueOrDash(frame.precipitationProbabilityPct, (n) => String(Math.round(n)), '%')}) · ` +
      `wind ${valueOrDash(frame.windSpeedKmh, (n) => String(Math.round(n)), `km/h${compass}`)}\n` +
      `cloud ${valueOrDash(frame.cloudCoverPct, (n) => String(Math.round(n)), '%')} · ` +
      `RH ${valueOrDash(frame.humidityPct, (n) => String(Math.round(n)), '%')} · ` +
      `${frame.available.isDay ? (frame.isDay === 1 ? 'daylight' : 'night') : 'light --'}`;
    const modeText = demoDataset || status.kind === 'demo' ? 'DEMO' : 'LIVE';
    const combined = `${statusText}|${locationText}|${deltaLabel}|${valuesText}|${modeText}`;
    if (combined === this.lastText) return;
    this.lastText = combined;
    this.lastPushAt = time;
    this.modeEl?.setProperties({
      text: modeText,
      backgroundColor: demoDataset || status.kind === 'demo' ? '#f2b63d' : '#79d7f2',
    });
    this.statusEl.setProperties({ text: statusText });
    this.locationEl?.setProperties({ text: locationText });
    this.playheadEl.setProperties({ text: deltaLabel });
    this.valuesEl.setProperties({ text: valuesText });
  }

  private pushStatus(statusText: string, locationText: string): void {
    const combined = `${statusText}|${locationText}`;
    if (combined === this.lastText) return;
    this.lastText = combined;
    this.statusEl?.setProperties({ text: statusText });
    this.locationEl?.setProperties({ text: locationText });
  }
}
