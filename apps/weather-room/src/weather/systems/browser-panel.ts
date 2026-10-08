/** Native HTML controls for desktop/phone browsers; XR uses the spatial panel. */

import { createSystem } from '@iwsdk/core';
import { PLAYHEAD_MAX_H, PLAYHEAD_MIN_H, WeatherEvent, playheadTime, weatherEvents, weatherStore } from '../weather-state.js';
import type { HourCrossedDetail } from '../weather-state.js';
import { Haptics, pulseHaptics } from '../feedback.js';
import {
  formatHoursFromNow,
  formatMissing,
  getLanguage,
  localizeDataPhrase,
  localizeLoadingLabel,
  localizePlaceLabel,
  localizePresetLabel,
  onLanguageChange,
  providerOf,
  sourceStatus,
  t,
  toggleLanguage,
  weatherCodeName,
  type Language,
} from '../i18n.js';
import { PROVIDER_DISPLAY } from '../providers.js';
import {
  LOCATION_PRESETS,
  getManualLocation,
  parseLatLon,
  setManualLocation,
} from '../weather-data.js';
import { reloadWeather } from './weather-loader.js';

/** Stable DOM id for the browser controls. */
export const BROWSER_PANEL_ROOT_ID = 'weather-browser-panel';

const STYLE_ID = `${BROWSER_PANEL_ROOT_ID}-style`;

const FONT_BASE = `${import.meta.env.BASE_URL}fonts/`;

const CSS = `
@font-face {
  font-family: Geologica;
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url("${FONT_BASE}geologica-latin.woff2") format("woff2");
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
@font-face {
  font-family: Geologica;
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url("${FONT_BASE}geologica-cyrillic.woff2") format("woff2");
  unicode-range: U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116;
}
@font-face {
  font-family: Geologica;
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url("${FONT_BASE}geologica-cyrillic-ext.woff2") format("woff2");
  unicode-range: U+0460-052F, U+1C80-1C8A, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F;
}
@font-face {
  font-family: Unbounded;
  font-style: normal;
  font-weight: 200 900;
  font-display: swap;
  src: url("${FONT_BASE}unbounded-latin.woff2") format("woff2");
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
@font-face {
  font-family: Unbounded;
  font-style: normal;
  font-weight: 200 900;
  font-display: swap;
  src: url("${FONT_BASE}unbounded-cyrillic.woff2") format("woff2");
  unicode-range: U+0301, U+0400-045F, U+0490-0491, U+2116;
}
@font-face {
  font-family: Unbounded;
  font-style: normal;
  font-weight: 200 900;
  font-display: swap;
  src: url("${FONT_BASE}unbounded-cyrillic-ext.woff2") format("woff2");
  unicode-range: U+0460-052F, U+1C80-1C8A, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F;
}
#${BROWSER_PANEL_ROOT_ID}[hidden] {
  display: none !important;
}
#${BROWSER_PANEL_ROOT_ID} {
  position: fixed;
  left: calc(12px + env(safe-area-inset-left, 0px));
  right: auto;
  top: auto;
  bottom: calc(12px + env(safe-area-inset-bottom, 0px));
  width: min(400px, calc(100vw - 24px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)));
  max-height: calc(100dvh - 24px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
  overflow-y: auto;
  overscroll-behavior: contain;
  z-index: 20;
  box-sizing: border-box;
  background: rgba(13, 25, 48, 0.88);
  -webkit-backdrop-filter: blur(18px) saturate(1.4);
  backdrop-filter: blur(18px) saturate(1.4);
  color: #eef5ff;
  border: 1px solid rgba(169, 216, 255, 0.19);
  border-radius: 14px;
  padding: 14px 16px 16px;
  font-family: Geologica, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.45;
  box-shadow: inset 0 1px 1px rgba(238, 245, 255, 0.14), 0 14px 44px rgba(1, 5, 16, 0.48);
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-kicker {
  margin: 0 0 2px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.22em;
  color: #79d7f2;
}
#${BROWSER_PANEL_ROOT_ID} h2 {
  margin: 0 0 6px;
  font-family: Unbounded, Geologica, system-ui, sans-serif;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.06em;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin: 0 0 8px;
  font-size: 12px;
  color: #94aac8;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-badge {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 999px;
  background: #79d7f2;
  color: #060b18;
  font-weight: 700;
  font-size: 11px;
  letter-spacing: 0.12em;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-badge[data-mode="demo"] {
  background: #f2b63d;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-info p {
  margin: 2px 0;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-info [data-testid="time-line"],
#${BROWSER_PANEL_ROOT_ID} .browser-panel-info [data-testid="playhead-value"],
#${BROWSER_PANEL_ROOT_ID} .browser-panel-info [data-testid="weather-hero"],
#${BROWSER_PANEL_ROOT_ID} .browser-panel-info [data-testid="weather-line"] {
  font-variant-numeric: tabular-nums;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-info [data-testid="time-line"] {
  font-size: 22px;
  font-weight: 700;
  color: #eef5ff;
  line-height: 1.2;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-info [data-testid="weather-hero"] {
  font-size: 26px;
  font-weight: 700;
  color: #eef5ff;
  line-height: 1.25;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-info [data-testid="weather-line"] {
  font-size: 15px;
  font-weight: 600;
  color: #eef5ff;
  line-height: 1.55;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-info [data-testid="status-line"] {
  font-size: 11px;
  color: #5f7896;
  line-height: 1.4;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
#${BROWSER_PANEL_ROOT_ID} button {
  min-height: 44px;
  min-width: 44px;
  padding: 10px 16px;
  border-radius: 999px;
  border: 1px solid rgba(169, 216, 255, 0.19);
  background: rgba(120, 184, 255, 0.07);
  color: #eef5ff;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  touch-action: manipulation;
}
#${BROWSER_PANEL_ROOT_ID} button:hover,
#${BROWSER_PANEL_ROOT_ID} button:focus-visible {
  border-color: rgba(121, 215, 242, 0.42);
  outline: 2px solid rgba(121, 215, 242, 0.55);
  outline-offset: 1px;
}
#${BROWSER_PANEL_ROOT_ID} button:disabled {
  opacity: 0.45;
  cursor: default;
}
#${BROWSER_PANEL_ROOT_ID} button[data-testid="go-live"] {
  background: #79d7f2;
  border-color: #79d7f2;
  color: #060b18;
}
#${BROWSER_PANEL_ROOT_ID} label.browser-panel-scrub {
  display: block;
  margin-top: 12px;
  font-weight: 600;
  font-size: 12px;
  letter-spacing: 0.08em;
  color: #94aac8;
}
#${BROWSER_PANEL_ROOT_ID} select,
#${BROWSER_PANEL_ROOT_ID} input[type="text"] {
  min-height: 44px;
  min-width: 44px;
  max-width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid rgba(169, 216, 255, 0.19);
  background: rgba(120, 184, 255, 0.07);
  color: #eef5ff;
  font: inherit;
  font-size: 16px;
  touch-action: manipulation;
}
#${BROWSER_PANEL_ROOT_ID} select option {
  color: #060b18;
  background: #eef5ff;
}
#${BROWSER_PANEL_ROOT_ID} input[type="range"] {
  width: 100%;
  min-height: 44px;
  margin: 0;
  touch-action: none;
  accent-color: #79d7f2;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-note {
  margin: 8px 0 0;
  font-size: 12px;
  color: #94aac8;
  font-variant-numeric: tabular-nums;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-utility {
  position: sticky;
  bottom: -1px;
  z-index: 2;
  margin-top: 8px;
  padding: 8px 0 2px;
  background: linear-gradient(to bottom, rgba(13, 25, 48, 0), rgba(13, 25, 48, 0.96) 30%);
}
@media (max-height: 700px) {
  #${BROWSER_PANEL_ROOT_ID} {
    padding: 10px 12px 10px;
    font-size: 13px;
  }
  #${BROWSER_PANEL_ROOT_ID} .browser-panel-info [data-testid="time-line"] {
    font-size: 18px;
  }
  #${BROWSER_PANEL_ROOT_ID} .browser-panel-info [data-testid="weather-hero"] {
    font-size: 21px;
  }
  #${BROWSER_PANEL_ROOT_ID} .browser-panel-info [data-testid="weather-line"] {
    font-size: 14px;
  }
}
@media (max-height: 500px) {
  #${BROWSER_PANEL_ROOT_ID} {
    width: min(340px, calc(100vw - 24px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)));
    padding: 10px 12px 12px;
    font-size: 13px;
  }
  #${BROWSER_PANEL_ROOT_ID} .browser-panel-info [data-testid="time-line"] {
    font-size: 17px;
  }
  #${BROWSER_PANEL_ROOT_ID} label.browser-panel-scrub {
    margin-top: 8px;
  }
}
`;


function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  testid: string,
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.dataset.testid = testid;
  if (text !== '') node.textContent = text;
  return node;
}

export class BrowserPanelSystem extends createSystem({}) {
  private root: HTMLElement | null = null;
  private disposed = false;
  private range: HTMLInputElement | null = null;
  private playheadValue: HTMLElement | null = null;
  private statusLine: HTMLElement | null = null;
  private locationLine: HTMLElement | null = null;
  private timeLine: HTMLElement | null = null;
  private heroLine: HTMLElement | null = null;
  private weatherLine: HTMLElement | null = null;
  private badge: HTMLElement | null = null;
  private enterButton: HTMLButtonElement | null = null;
  private exitButton: HTMLButtonElement | null = null;
  private reloadButton: HTMLButtonElement | null = null;
  private xrNote: HTMLElement | null = null;
  private langButton: HTMLButtonElement | null = null;
  private locationWrap: HTMLElement | null = null;
  private locationSelect: HTMLSelectElement | null = null;
  private locationInput: HTMLInputElement | null = null;
  private locationApply: HTMLButtonElement | null = null;
  private locationClear: HTMLButtonElement | null = null;
  private locationError: HTMLElement | null = null;
  private locationHintEl: HTMLElement | null = null;
  private unsubscribeLanguage: (() => void) | null = null;
  private dirty = true;
  private scrubPointer: number | null = null;
  private lastRenderAt = -Number.MAX_SAFE_INTEGER;
  private lastClockMinute = -1;

  init(): void {
    if (typeof document === 'undefined') return;
    this.disposed = false;
    this.buildPanel();
    this.render();

    const onStore = (): void => {
      if (this.disposed) return;
      // Hidden (immersive) sessions only mark dirty; update() flushes on return.
      if (this.root?.hidden) this.dirty = true;
      else this.render();
    };
    const unsubscribeStore = weatherStore.state.subscribe(onStore);
    const onSessionVisibility = (): void => {
      if (!this.disposed) this.applySessionVisibility();
    };
    const unsubscribeVisibility = this.world.visibilityState.subscribe(onSessionVisibility);
    this.xrManager.addEventListener('sessionstart', onSessionVisibility);
    this.xrManager.addEventListener('sessionend', onSessionVisibility);

    const tick = (): void => {
      weatherEvents.emit(WeatherEvent.UiPress);
      pulseHaptics(this.world, Haptics.lightTap.intensity, Haptics.lightTap.durationMs);
    };
    const firmTap = (): void => {
      pulseHaptics(this.world, Haptics.firmTap.intensity, Haptics.firmTap.durationMs);
    };
    const stepBack = (): void => {
      tick();
      weatherStore.setPlayhead(weatherStore.state.peek().playheadHours - 6);
    };
    const stepForward = (): void => {
      tick();
      weatherStore.setPlayhead(weatherStore.state.peek().playheadHours + 6);
    };
    const goLive = (): void => {
      tick();
      weatherStore.goLive();
    };
    const reload = (): void => {
      tick();
      void reloadWeather();
    };
    const scrub = (): void => {
      if (this.range == null) return;
      weatherStore.setPlayhead(Number(this.range.value));
    };
    // Own the touch gesture: native range handling varies on mobile and
    // must not turn a horizontal scrub into panel scrolling or a canvas ray.
    const scrubAtPointer = (event: PointerEvent): void => {
      const range = this.range;
      if (range == null) return;
      const bounds = range.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
      const hours = PLAYHEAD_MIN_H + fraction * (PLAYHEAD_MAX_H - PLAYHEAD_MIN_H);
      range.value = String(Math.round(hours * 2) / 2);
      scrub();
    };
    const startScrub = (event: PointerEvent): void => {
      if (!event.isPrimary || event.button !== 0 || this.scrubPointer != null || this.range == null) return;
      event.preventDefault();
      event.stopPropagation();
      this.scrubPointer = event.pointerId;
      this.range.focus({ preventScroll: true });
      this.range.setPointerCapture(event.pointerId);
      scrubAtPointer(event);
    };
    const moveScrub = (event: PointerEvent): void => {
      if (event.pointerId !== this.scrubPointer) return;
      event.preventDefault();
      event.stopPropagation();
      scrubAtPointer(event);
    };
    const endScrub = (event: PointerEvent): void => {
      if (event.pointerId !== this.scrubPointer) return;
      event.stopPropagation();
      this.scrubPointer = null;
      if (this.range?.hasPointerCapture(event.pointerId)) this.range.releasePointerCapture(event.pointerId);
      this.render();
    };
    const launchXR = (): void => {
      if (!this.world.xrEnabled) return;
      tick();
      firmTap();
      void this.world.launchXR();
    };
    const exitXR = (): void => {
      tick();
      firmTap();
      void this.world.exitXR();
    };
    const switchLanguage = (): void => {
      tick();
      toggleLanguage();
    };
    const applyManualInput = (): void => {
      if (this.locationInput == null) return;
      tick();
      const parsed = parseLatLon(this.locationInput.value);
      if (parsed == null) {
        if (this.locationError != null) this.locationError.textContent = t('locationInvalid');
        return;
      }
      if (this.locationError != null) this.locationError.textContent = '';
      setManualLocation({
        latitude: parsed.latitude,
        longitude: parsed.longitude,
        label: `${parsed.latitude.toFixed(2)}°, ${parsed.longitude.toFixed(2)}°`,
      });
      void reloadWeather();
    };
    const applyPreset = (): void => {
      if (this.locationSelect == null) return;
      tick();
      const preset = LOCATION_PRESETS.find((item) => item.id === this.locationSelect?.value);
      if (preset == null) return;
      setManualLocation({ latitude: preset.latitude, longitude: preset.longitude, label: preset.label });
      void reloadWeather();
    };
    const clearManual = (): void => {
      tick();
      setManualLocation(null);
      void reloadWeather();
    };

    this.root?.querySelector('[data-testid="step-back"]')?.addEventListener('click', stepBack);
    this.root?.querySelector('[data-testid="go-live"]')?.addEventListener('click', goLive);
    this.root?.querySelector('[data-testid="step-forward"]')?.addEventListener('click', stepForward);
    this.reloadButton?.addEventListener('click', reload);
    this.range?.addEventListener('input', scrub);
    this.range?.addEventListener('pointerdown', startScrub);
    this.range?.addEventListener('pointermove', moveScrub);
    this.range?.addEventListener('pointerup', endScrub);
    this.range?.addEventListener('pointercancel', endScrub);
    this.range?.addEventListener('lostpointercapture', endScrub);
    this.enterButton?.addEventListener('click', launchXR);
    this.exitButton?.addEventListener('click', exitXR);
    this.langButton?.addEventListener('click', switchLanguage);
    this.locationSelect?.addEventListener('change', applyPreset);
    this.locationApply?.addEventListener('click', applyManualInput);
    this.locationClear?.addEventListener('click', clearManual);

    this.cleanupFuncs.push(
      () => {
        this.root?.querySelector('[data-testid="step-back"]')?.removeEventListener('click', stepBack);
        this.root?.querySelector('[data-testid="go-live"]')?.removeEventListener('click', goLive);
        this.root
          ?.querySelector('[data-testid="step-forward"]')
          ?.removeEventListener('click', stepForward);
      },
      () => this.reloadButton?.removeEventListener('click', reload),
      () => this.range?.removeEventListener('input', scrub),
      () => this.range?.removeEventListener('pointerdown', startScrub),
      () => this.range?.removeEventListener('pointermove', moveScrub),
      () => this.range?.removeEventListener('pointerup', endScrub),
      () => this.range?.removeEventListener('pointercancel', endScrub),
      () => this.range?.removeEventListener('lostpointercapture', endScrub),
      () => this.enterButton?.removeEventListener('click', launchXR),
      () => this.exitButton?.removeEventListener('click', exitXR),
      () => this.langButton?.removeEventListener('click', switchLanguage),
      () => this.locationSelect?.removeEventListener('change', applyPreset),
      () => this.locationApply?.removeEventListener('click', applyManualInput),
      () => this.locationClear?.removeEventListener('click', clearManual),
      unsubscribeStore,
      unsubscribeVisibility,
      () => this.xrManager.removeEventListener('sessionstart', onSessionVisibility),
      () => this.xrManager.removeEventListener('sessionend', onSessionVisibility),
      () => {
        this.unsubscribeLanguage?.();
        this.unsubscribeLanguage = null;
      },
      () => {
        this.disposed = true;
        this.root?.remove();
        document.getElementById(STYLE_ID)?.remove();
        this.root = null;
      },
      // Same shared hour moment as the guide fill, spatial panel, room
      // pulse, detent haptic, and tick audio: re-render immediately and
      // flash the NOW badge on a snap arrival.
      weatherEvents.on(WeatherEvent.HourCrossed, (detail: unknown) => {
        const crossed = detail as HourCrossedDetail | undefined;
        if (this.disposed) return;
        if (crossed?.isLive === true) this.flashBadge();
        if (this.root?.hidden) this.dirty = true;
        else this.render();
      }),
    );
    this.unsubscribeLanguage = onLanguageChange(() => {
      if (!this.disposed) this.render();
    });

    this.applySessionVisibility();
    void this.probeXrSupport();
  }

  private buildPanel(): void {
    if (document.getElementById(STYLE_ID) == null) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    document.getElementById(BROWSER_PANEL_ROOT_ID)?.remove();

    const root = document.createElement('section');
    root.id = BROWSER_PANEL_ROOT_ID;
    root.dataset.testid = 'browser-panel';
    root.setAttribute('aria-label', 'Weather room browser controls');

    const kicker = document.createElement('p');
    kicker.className = 'browser-panel-kicker';
    kicker.textContent = 'STANIVERSE';
    root.appendChild(kicker);

    const heading = document.createElement('h2');
    heading.textContent = 'WEATHER//ROOM';
    root.appendChild(heading);

    const meta = document.createElement('div');
    meta.className = 'browser-panel-meta';
    this.badge = el('span', 'mode-badge', 'LIVE');
    this.badge.className = 'browser-panel-badge';
    const declaredRevision: unknown = typeof __WEATHER_ROOM_REVISION__ === 'string' ? __WEATHER_ROOM_REVISION__ : 'unknown';
    const version = el('span', 'version-label', `rev ${typeof declaredRevision === 'string' && declaredRevision.length > 0 ? declaredRevision : 'unknown'}`);
    this.langButton = document.createElement('button');
    this.langButton.type = 'button';
    this.langButton.dataset.testid = 'lang-toggle';
    meta.append(this.badge, version, this.langButton);
    root.appendChild(meta);

    const info = document.createElement('div');
    info.className = 'browser-panel-info';
    info.setAttribute('aria-live', 'polite');
    this.statusLine = el('p', 'status-line', 'Starting…');
    this.locationLine = el('p', 'location-line', '--');
    this.timeLine = el('p', 'time-line', 'NOW');
    this.heroLine = el('p', 'weather-hero', '--');
    this.weatherLine = el('p', 'weather-line', '--');
    // Hero readout first (time + temp + condition), secondary diagnostics
    // after the core precip/wind lines: DOM order matches visual hierarchy.
    info.append(this.timeLine, this.heroLine, this.weatherLine, this.locationLine, this.statusLine);
    root.appendChild(info);

    const row = document.createElement('div');
    row.className = 'browser-panel-row';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Timeline controls');
    const back = document.createElement('button');
    back.type = 'button';
    back.dataset.testid = 'step-back';
    back.textContent = '-6h';
    back.setAttribute('aria-label', 'Back 6 hours');
    const now = document.createElement('button');
    now.type = 'button';
    now.dataset.testid = 'go-live';
    now.textContent = 'NOW';
    now.setAttribute('aria-label', 'Return to live time');
    const forward = document.createElement('button');
    forward.type = 'button';
    forward.dataset.testid = 'step-forward';
    forward.textContent = '+6h';
    forward.setAttribute('aria-label', 'Forward 6 hours');
    this.reloadButton = document.createElement('button');
    this.reloadButton.type = 'button';
    this.reloadButton.dataset.testid = 'reload';
    this.reloadButton.textContent = 'Reload';
    this.reloadButton.setAttribute('aria-label', 'Reload weather data');
    // Timeline row keeps the scrub buttons; Reload joins the utility row below.
    row.append(back, now, forward);
    root.appendChild(row);

    const scrubLabel = document.createElement('label');
    scrubLabel.className = 'browser-panel-scrub';
    scrubLabel.setAttribute('for', `${BROWSER_PANEL_ROOT_ID}-playhead`);
    scrubLabel.textContent = 'Timeline';
    root.appendChild(scrubLabel);
    this.range = document.createElement('input');
    this.range.type = 'range';
    this.range.id = `${BROWSER_PANEL_ROOT_ID}-playhead`;
    this.range.dataset.testid = 'playhead';
    this.range.min = String(PLAYHEAD_MIN_H);
    this.range.max = String(PLAYHEAD_MAX_H);
    this.range.step = '0.5';
    this.range.value = '0';
    this.range.setAttribute('aria-label', 'Timeline offset in hours from now');
    root.appendChild(this.range);
    this.playheadValue = el('p', 'playhead-value', 'NOW');
    this.playheadValue.className = 'browser-panel-note';
    root.appendChild(this.playheadValue);

    // Compact manual-location row: preset select + "lat,lon" field + Set/Auto.
    // Same row/heading visual language; no new panel styling beyond layout
    // of the row itself (flex wrap inherited from .browser-panel-row).
    const locLabel = document.createElement('label');
    locLabel.className = 'browser-panel-scrub';
    locLabel.setAttribute('for', `${BROWSER_PANEL_ROOT_ID}-location`);
    locLabel.dataset.testid = 'location-label';
    locLabel.textContent = 'Location';
    root.appendChild(locLabel);
    this.locationWrap = document.createElement('div');
    this.locationWrap.className = 'browser-panel-row';
    this.locationWrap.dataset.testid = 'location-row';
    this.locationSelect = document.createElement('select');
    this.locationSelect.id = `${BROWSER_PANEL_ROOT_ID}-location`;
    this.locationSelect.dataset.testid = 'location-presets';
    for (const preset of LOCATION_PRESETS) {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.label;
      this.locationSelect.appendChild(option);
    }
    this.locationInput = document.createElement('input');
    this.locationInput.type = 'text';
    this.locationInput.dataset.testid = 'location-input';
    this.locationInput.placeholder = 'lat, lon';
    this.locationInput.setAttribute('inputmode', 'decimal');
    this.locationApply = document.createElement('button');
    this.locationApply.type = 'button';
    this.locationApply.dataset.testid = 'location-set';
    this.locationApply.setAttribute('aria-label', 'Set manual location');
    this.locationClear = document.createElement('button');
    this.locationClear.type = 'button';
    this.locationClear.dataset.testid = 'location-auto';
    this.locationClear.setAttribute('aria-label', 'Clear manual location');
    this.locationWrap.append(this.locationSelect, this.locationInput, this.locationApply, this.locationClear);
    root.appendChild(this.locationWrap);
    this.locationError = el('p', 'location-error', '');
    this.locationError.className = 'browser-panel-note';
    root.appendChild(this.locationError);

    // One short hint line: how to show weather for your own place.
    this.locationHintEl = el('p', 'location-hint', t('locationHint'));
    this.locationHintEl.className = 'browser-panel-note';
    root.appendChild(this.locationHintEl);

    // One small utility row (Reload + Enter/Exit): chrome reduction so the
    // hero readout, not buttons, dominates the panel. Testids preserved.
    const xrRow = document.createElement('div');
    xrRow.className = 'browser-panel-row browser-panel-utility';
    xrRow.setAttribute('role', 'group');
    xrRow.setAttribute('aria-label', 'Immersive session controls');
    this.enterButton = document.createElement('button');
    this.enterButton.type = 'button';
    this.enterButton.dataset.testid = 'enter-ar';
    this.enterButton.textContent = 'Enter AR';
    this.exitButton = document.createElement('button');
    this.exitButton.type = 'button';
    this.exitButton.dataset.testid = 'exit-xr';
    this.exitButton.textContent = 'Exit';
    // Reload moves into the utility row (same testid/handlers, new parent).
    const utilityReload = this.reloadButton;
    if (utilityReload != null) xrRow.append(utilityReload);
    xrRow.append(this.enterButton, this.exitButton);
    root.appendChild(xrRow);
    this.xrNote = el('p', 'xr-note', 'Checking XR support…');
    this.xrNote.className = 'browser-panel-note';
    root.appendChild(this.xrNote);

    document.body.appendChild(root);
    this.root = root;
  }

  private applySessionVisibility(): void {
    if (this.root == null) return;
    // The last XR visibility signal can outlive sessionend until the next render frame.
    const is2D = !this.xrManager.isPresenting;
    this.root.hidden = !is2D;
    this.root.dataset.session = is2D ? 'browser' : 'immersive';
    if (this.enterButton != null) this.enterButton.hidden = !is2D || !this.world.xrEnabled;
    if (this.exitButton != null) this.exitButton.hidden = is2D;
    if (this.xrNote != null && !this.world.xrEnabled) {
      this.xrNote.textContent = t('xrDisabled');
    }
    if (!this.root.hidden) this.dirty = true;
  }

  /** Throttled visible refresh: the cached frame advances even without store events. */
  update(): void {
    if (this.disposed || this.root == null || this.root.hidden) return;
    const now = performance.now();
    if (now - this.lastRenderAt < 500) return;
    const minute = new Date().getMinutes();
    if (!this.dirty && minute === this.lastClockMinute) return;
    this.render();
  }


  /** Honest capability probe: capability-aware Enter AR, no raw requestSession. */
  private async probeXrSupport(): Promise<void> {
    if (!this.world.xrEnabled) {
      if (!this.disposed && this.xrNote != null) {
        this.xrNote.textContent = t('xrDisabled');
      }
      return;
    }
    let supported = false;
    try {
      const xr = (navigator as Navigator & {
        xr?: { isSessionSupported(mode: string): Promise<boolean> };
      }).xr;
      supported = (await xr?.isSessionSupported('immersive-ar')) ?? false;
    } catch {
      supported = false;
    }
    if (this.disposed) return;
    if (this.enterButton != null) this.enterButton.disabled = !supported;
    if (this.xrNote != null && this.world.xrEnabled) {
      this.xrNote.textContent = supported ? t('xrEnterHint') : t('xrUnavailable');
    }
    this.applySessionVisibility();
  }

  private render(): void {
    if (this.root == null || this.disposed) return;
    this.lastRenderAt = performance.now();
    this.dirty = false;
    this.lastClockMinute = new Date().getMinutes();
    const lang = getLanguage();
    const state = weatherStore.state.peek();
    const { status, dataset, playheadHours, isLive } = state;
    const current = weatherStore.current();
    // A retained synthetic dataset stays DEMO even while a reload is loading.
    const demoDataset = dataset?.source === 'demo';
    this.applyChromeLabels(lang);

    if (this.range != null) {
      if (this.scrubPointer == null) this.range.value = String(playheadHours);
      this.range.setAttribute(
        'aria-valuetext',
        isLive ? t('ariaLiveNow') : formatHoursFromNow(Math.round(playheadHours * 2) / 2, lang),
      );
    }

    if (this.badge != null) {
      const demo = demoDataset || status.kind === 'demo';
      this.badge.textContent = demo ? t('badgeDemo') : t('badgeLive');
      this.badge.dataset.mode = demo ? 'demo' : 'live';
    }
    if (this.reloadButton != null) {
      const loading = status.kind === 'loading' || status.kind === 'locating';
      this.reloadButton.disabled = loading;
      this.reloadButton.textContent = loading ? t('reloading') : t('reload');
    }

    if (current == null || dataset == null) {
      if (this.statusLine != null) {
        this.statusLine.textContent =
          status.kind === 'loading'
            ? `${t('loadingPrefix')}${localizeLoadingLabel(status.label, lang)}`
            : t('statusLoading');
      }
      if (this.locationLine != null) this.locationLine.textContent = t('locatingShort');
      const early = isLive ? t('playheadNow') : `${playheadHours}h`;
      if (this.timeLine != null) this.timeLine.textContent = early;
      if (this.heroLine != null) this.heroLine.textContent = t('missingValue');
      if (this.weatherLine != null) this.weatherLine.textContent = t('missingValue');
      if (this.playheadValue != null) this.playheadValue.textContent = early;
      return;
    }

    const { frame } = current;
    const staleSuffix = frame.stale ? t('staleSuffixParen') : '';
    const providerDisplay =
      !demoDataset
        ? (PROVIDER_DISPLAY[providerOf(dataset.source) as keyof typeof PROVIDER_DISPLAY] ?? providerOf(dataset.source))
        : '';
    // One dim secondary line: honest status core (already names the provider
    // when live) plus a token only when it adds information.
    if (this.statusLine != null) {
      const statusCore =
        status.kind === 'demo'
          ? `${t('demoDataPrefix')}${localizeDataPhrase(status.reason, lang)}`
          : demoDataset
            ? `${t('statusDemoRetained')}${staleSuffix}`
            : `${sourceStatus(providerDisplay, staleSuffix, lang)}`;
      const extraToken =
        providerDisplay !== '' && (status.kind === 'loading' || status.kind === 'locating')
          ? ` · ${providerDisplay}`
          : '';
      this.statusLine.textContent = `${statusCore}${extraToken}`;
    }
    if (this.locationLine != null) {
      this.locationLine.textContent = localizePlaceLabel(
        dataset.label.split(' · ').slice(1).join(' · ') || dataset.label,
        lang,
      );
    }

    const at = playheadTime(dataset, playheadHours, new Date());
    const beyond = frame.outOfCoverage ? t('beyondSuffixDash') : '';
    const hours = at.getHours() < 10 ? `0${at.getHours()}` : `${at.getHours()}`;
    const minutes = at.getMinutes() < 10 ? `0${at.getMinutes()}` : `${at.getMinutes()}`;
    const label = isLive
      ? `${t('playheadNow')}${beyond}`
      : `${hours}:${minutes} (${playheadHours > 0 ? '+' : ''}${playheadHours}h)${beyond}`;
    if (this.timeLine != null) this.timeLine.textContent = label;
    if (this.playheadValue != null) this.playheadValue.textContent = label;

    if (this.heroLine != null) {
      const temp = Number.isFinite(frame.temperatureC) ? `${frame.temperatureC.toFixed(1)} C` : formatMissing('C');
      const code = frame.available.weatherCode ? weatherCodeName(frame.weatherCode, lang) : t('missingValue');
      this.heroLine.textContent = `${temp} · ${code}`;
    }
    if (this.weatherLine != null) {
      const rain = Number.isFinite(frame.precipitationMm)
        ? `${frame.precipitationMm.toFixed(1)} mm/h`
        : formatMissing('mm/h');
      const prob = Number.isFinite(frame.precipitationProbabilityPct)
        ? `${Math.round(frame.precipitationProbabilityPct)} %`
        : formatMissing('%');
      const wind = Number.isFinite(frame.windSpeedKmh)
        ? `${Math.round(frame.windSpeedKmh)} km/h`
        : formatMissing('km/h');
      this.weatherLine.textContent = `${t('rain')} ${rain} (${prob}) · ${t('wind')} ${wind}`;
    }
    this.syncLocationRow(lang);
  }

  /** Static chrome: buttons, labels, aria, and the location picker skeleton. */
  private applyChromeLabels(lang: Language): void {
    this.root?.setAttribute('aria-label', t('ariaPanel'));
    this.root?.querySelector('[data-testid="step-back"]')?.setAttribute('aria-label', t('ariaStepBack'));
    this.root?.querySelector('[data-testid="go-live"]')?.setAttribute('aria-label', t('ariaGoLive'));
    this.root?.querySelector('[data-testid="step-forward"]')?.setAttribute('aria-label', t('ariaStepForward'));
    const back = this.root?.querySelector('[data-testid="step-back"]');
    const now = this.root?.querySelector('[data-testid="go-live"]');
    const forward = this.root?.querySelector('[data-testid="step-forward"]');
    if (back != null) back.textContent = t('stepBack');
    if (now != null) now.textContent = t('goLive');
    if (forward != null) forward.textContent = t('stepForward');
    if (this.reloadButton != null) this.reloadButton.setAttribute('aria-label', t('ariaReload'));
    if (this.range != null) this.range.setAttribute('aria-label', t('ariaScrub'));
    if (this.langButton != null) {
      this.langButton.textContent = t('langName');
      this.langButton.setAttribute('aria-label', t('ariaSwitchLanguage'));
    }
    if (this.enterButton != null) this.enterButton.textContent = t('enterAr');
    if (this.exitButton != null) this.exitButton.textContent = t('exit');
    this.root?.querySelector('[data-testid="location-label"]')?.replaceChildren(t('locationLabelPrefix'));
    if (this.locationInput != null) this.locationInput.placeholder = t('locationPlaceholder');
    if (this.locationApply != null) this.locationApply.textContent = t('locationApply');
    if (this.locationClear != null) this.locationClear.textContent = t('locationClear');
    if (this.locationHintEl != null) this.locationHintEl.textContent = t('locationHint');
    if (this.locationError != null && this.locationError.textContent !== '') {
      this.locationError.textContent = t('locationInvalid');
    }
    void lang;
  }

  /** Keep the preset select in sync with the persisted manual location. */
  private syncLocationRow(lang: Language): void {
    const manual = getManualLocation();
    if (this.locationSelect != null) {
      const options = this.locationSelect.querySelectorAll('option');
      LOCATION_PRESETS.forEach((preset, index) => {
        const option = options.item(index);
        if (option != null) option.textContent = localizePresetLabel(preset.label, lang);
      });
      if (manual != null) {
        const match = LOCATION_PRESETS.find((preset) => preset.label === manual.label);
        if (match != null) this.locationSelect.value = match.id;
      }
    }
    if (this.locationInput != null && document.activeElement !== this.locationInput) {
      this.locationInput.value = manual != null ? `${manual.latitude}, ${manual.longitude}` : '';
    }
  }

  /**
   * Unmistakable NOW snap on the DOM surface: briefly invert the badge to
   * white-on-dark, then restore the live/demo pill. Timer-owned, no layout
   * change, same shared hour moment as the spatial pill flash.
   */
  private flashBadge(): void {
    if (this.badge == null || this.disposed) return;
    const badge = this.badge;
    const previous = badge.style.background;
    badge.style.background = '#ffffff';
    window.setTimeout(() => {
      if (this.disposed) return;
      badge.style.background = previous;
    }, 450);
  }
}
