/**
 * Panel wiring for the WEATHER//ROOM HUD: status, location, playhead, live
 * values, NOW/Reload actions, and the template Enter/Exit XR behavior.
 * Text pushes are throttled to 2 Hz and only fire on actual changes.
 */

import { createSystem, UIKitMLAsset, VisibilityState } from '@iwsdk/core';
import type { Component as UIKitComponent } from '@pmndrs/uikit';
import { weatherStore } from '../weather-state.js';
import { playheadTime } from '../weather-state.js';
import { reloadWeather } from './weather-loader.js';

/** Minimum seconds between panel text pushes (2 Hz ceiling). */
const PANEL_PUSH_INTERVAL_S = 0.5;

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

function compassFrom(metDegrees: number): string {
  const to = (((metDegrees + 180) % 360) + 360) % 360;
  return COMPASS[Math.round(to / 45) % 8];
}

/** Format one measurement; `--` marks values the dataset does not provide. */
function valueOrDash(value: number, format: (n: number) => string, unit: string): string {
  return Number.isFinite(value) ? `${format(value)} ${unit}` : `-- ${unit}`;
}

/** A UIKitML text-line container: child text inherits the parent `text` prop. */
interface TextLine {
  setProperties(props: { text: string }): void;
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
  private lastPushAt = -PANEL_PUSH_INTERVAL_S;
  private lastText = '';

  init(): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('weather-panel');
    const xrButton = panel?.getElementById('xr-button');
    const exitButton = panel?.getElementById('exit-button');
    if (panel == null) return;
    this.statusEl = asTextLine(panel.getElementById('status-line'));
    this.locationEl = asTextLine(panel.getElementById('location-line'));
    this.playheadEl = asTextLine(panel.getElementById('playhead-line'));
    this.valuesEl = asTextLine(panel.getElementById('values-line'));

    const nowButton = panel.getElementById('now-button');
    const reloadButton = panel.getElementById('reload-button');
    const goLive = () => weatherStore.goLive();
    const reload = () => {
      void reloadWeather();
    };
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
      () => nowButton?.removeEventListener('click', goLive),
      () => reloadButton?.removeEventListener('click', reload),
    );
  }

  update(_delta: number, time: number): void {
    if (this.statusEl == null || this.valuesEl == null || this.playheadEl == null) return;
    if (time - this.lastPushAt < PANEL_PUSH_INTERVAL_S) return;
    const state = weatherStore.state.peek();
    const current = weatherStore.current();
    if (current == null) {
      this.pushStatus('Loading weather...', state.status.kind === 'demo' ? 'demo' : '');
      this.lastPushAt = time;
      return;
    }
    const { dataset, playheadHours, isLive, status } = state;
    const { frame } = current;
    const staleSuffix = frame.stale ? ' · cached' : '';
    const statusText =
      status.kind === 'demo'
        ? `DEMO: ${status.reason}`
        : status.kind === 'ready'
          ? `Live from Open-Meteo${staleSuffix}`
          : status.kind === 'loading'
            ? `Loading: ${status.label}`
            : status.kind === 'locating'
              ? 'Locating...'
              : 'Ready';
    const locationText = dataset?.label ?? '--';
    const at = playheadTime(dataset!, playheadHours, new Date());
    const clock = `${at.getHours() < 10 ? `0${at.getHours()}` : at.getHours()}:${at.getMinutes() < 10 ? `0${at.getMinutes()}` : at.getMinutes()}`;
    const beyondData = frame.outOfCoverage ? ' · beyond data' : '';
    const deltaLabel = isLive
      ? `NOW${beyondData}`
      : `${clock} / ${playheadHours > 0 ? '+' : ''}${Math.round(playheadHours)}h${beyondData}`;
    const compass =
      frame.available.windSpeedKmh && frame.available.windDirectionDeg
        ? ` ${compassFrom(frame.windDirectionDeg)}`
        : '';
    const valuesText =
      `${valueOrDash(frame.temperatureC, (n) => n.toFixed(1), 'C')}  ` +
      `${valueOrDash(frame.precipitationMm, (n) => n.toFixed(1), 'mm/h')}  ` +
      `${valueOrDash(frame.windSpeedKmh, (n) => String(Math.round(n)), `km/h${compass}`)}  ` +
      `${valueOrDash(frame.cloudCoverPct, (n) => String(Math.round(n)), '%')}  ` +
      `${valueOrDash(frame.pressureHpa, (n) => String(Math.round(n)), 'hPa')}`;
    const combined = `${statusText}|${locationText}|${deltaLabel}|${valuesText}`;
    if (combined === this.lastText) return;
    this.lastText = combined;
    this.lastPushAt = time;
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
