/** Native HTML controls for desktop/phone browsers AND handheld phone XR; tracked-hands XR uses the spatial panel. */

import { buildSessionInit, createSystem, normalizeReferenceSpec, resolveReferenceSpaceType, SessionMode } from '@iwsdk/core';
import { WeatherEvent, playheadTime, weatherEvents, weatherStore } from '../weather-state.js';
import type { HourCrossedDetail } from '../weather-state.js';
import { Haptics, pulseHaptics } from '../feedback.js';
import {
  formatMissing,
  getLanguage,
  localizeDataPhrase,
  localizeLoadingLabel,
  localizePlaceLabel,
  localizePresetLabel,
  locationOriginLabel,
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
  forgetDeviceLocation,
  geolocationPermissionState,
  getManualLocation,
  loadWeather,
  parseLatLon,
  requestDeviceLocation,
  setManualLocation,
  watchGeolocationPermission,
  type GeolocationPermission,
  type LocationOrigin,
} from '../weather-data.js';
import { reloadWeather } from './weather-loader.js';
import { usesSpatialControls } from '../capabilities.js';

/** Stable DOM id for the browser controls. */
export const BROWSER_PANEL_ROOT_ID = 'weather-browser-panel';

const STYLE_ID = `${BROWSER_PANEL_ROOT_ID}-style`;

const FONT_BASE = `${import.meta.env.BASE_URL}fonts/`;

/**
 * 2D orbit framing: pivot on the room centre (the authored hero view target),
 * stay above the floor, and keep the panel's front face on screen so an orbit
 * can never turn the room into an invisible back side.
 */
const ORBIT_TARGET = { x: 0, y: 1.2, z: -0.3 } as const;
const ORBIT_MIN_RADIUS = 1.6;
const ORBIT_MAX_RADIUS = 9;
const ORBIT_MIN_PITCH = 0.12;
const ORBIT_MAX_PITCH = 1.05;
const ORBIT_YAW_LIMIT = 1.15;

const CSS = `
body:xr-overlay #scene-container {
  visibility: hidden;
}
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
  display: flex;
  flex-direction: column;
  overflow: hidden;
  z-index: 20;
  /* Native touch controls win over the canvas: the panel owns its touches,
     nothing intercepts them, and the card never clips its own controls. */
  touch-action: pan-y;
  pointer-events: auto;
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
#${BROWSER_PANEL_ROOT_ID} .browser-panel-meta button {
  margin-left: auto;
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
#${BROWSER_PANEL_ROOT_ID} .browser-panel-badge[data-mode="loading"] {
  background: #2a3c5e;
  color: #d7e6fb;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-info p {
  margin: 2px 0;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-info [data-testid="time-line"],
#${BROWSER_PANEL_ROOT_ID} .browser-panel-info [data-testid="weather-hero"],
#${BROWSER_PANEL_ROOT_ID} .browser-panel-info [data-testid="weather-line"] {
  font-variant-numeric: tabular-nums;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-info [data-testid="time-line"] {
  font-size: 19px;
  font-weight: 600;
  color: #eef5ff;
  line-height: 1.2;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-info [data-testid="weather-hero"] {
  font-size: 32px;
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
  font-size: 12px;
  color: #7e99bd;
  line-height: 1.4;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-timeline {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
#${BROWSER_PANEL_ROOT_ID} [data-testid="time-scrub"] {
  display: block;
  width: 100%;
  min-height: 44px;
  margin: 0;
  accent-color: #79d7f2;
  touch-action: none;
}
#${BROWSER_PANEL_ROOT_ID} [data-testid="location-row"] {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
#${BROWSER_PANEL_ROOT_ID} [data-testid="location-row"] select,
#${BROWSER_PANEL_ROOT_ID} [data-testid="location-row"] input {
  grid-column: 1 / -1;
  width: 100%;
  min-width: 0;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-timeline button,
#${BROWSER_PANEL_ROOT_ID} .browser-panel-utility button {
  padding-left: 8px;
  padding-right: 8px;
  /* The loading label swap must never shift or spill out of the button. */
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
#${BROWSER_PANEL_ROOT_ID} details.browser-panel-location {
  margin-top: 12px;
}
#${BROWSER_PANEL_ROOT_ID} details.browser-panel-location > summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 44px;
  padding: 0 12px;
  border: 1px solid rgba(169, 216, 255, 0.19);
  border-radius: 12px;
  background: rgba(120, 184, 255, 0.07);
  list-style: none;
  cursor: pointer;
  user-select: none;
  touch-action: manipulation;
  font-weight: 600;
  font-size: 12px;
  letter-spacing: 0.08em;
  color: #94aac8;
}
#${BROWSER_PANEL_ROOT_ID} details.browser-panel-location > summary::-webkit-details-marker {
  display: none;
}
#${BROWSER_PANEL_ROOT_ID} details.browser-panel-location > summary::after {
  content: "▾";
  font-size: 14px;
  color: #79d7f2;
}
#${BROWSER_PANEL_ROOT_ID} details.browser-panel-location[open] > summary {
  color: #79d7f2;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-location-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-location-content select,
#${BROWSER_PANEL_ROOT_ID} .browser-panel-location-content button[data-testid="location-auto"] {
  width: 100%;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-location-content input[type="text"] {
  flex: 1 1 auto;
  min-width: 0;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-location-content .browser-panel-location-manual {
  display: flex;
  gap: 8px;
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
#${BROWSER_PANEL_ROOT_ID} .browser-panel-note {
  margin: 8px 0 0;
  font-size: 12px;
  color: #94aac8;
  font-variant-numeric: tabular-nums;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-note[data-state="info"] {
  color: #79d7f2;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-note[data-state="warn"] {
  color: #f2b63d;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-note[data-state="error"] {
  color: #ff9d9d;
}
/* Fixed footer outside the scroll area: it can never sit over the content,
   and the primary actions stay reachable without scrolling the card. */
#${BROWSER_PANEL_ROOT_ID} .browser-panel-utility {
  flex: 0 0 auto;
  margin-top: 0;
  padding-top: 12px;
  border-top: 1px solid rgba(169, 216, 255, 0.14);
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-sandbox {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
}
#${BROWSER_PANEL_ROOT_ID} button[data-testid="sandbox-toggle"][data-state="on"] {
  background: #f2b63d;
  border-color: #f2b63d;
  color: #060b18;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  padding-bottom: 4px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-utility > button {
  flex: 1 1 0;
  min-width: 0;
}
@media (max-height: 700px) {
  #${BROWSER_PANEL_ROOT_ID} {
    padding: 10px 12px 10px;
    font-size: 13px;
  }
  #${BROWSER_PANEL_ROOT_ID} .browser-panel-row {
    margin-top: 10px;
  }
  #${BROWSER_PANEL_ROOT_ID} details.browser-panel-location {
    margin-top: 10px;
  }
  #${BROWSER_PANEL_ROOT_ID} .browser-panel-utility {
    padding-top: 10px;
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
/* Short desktop/landscape windows: tighten rhythm so the card scrolls as one
   clean column instead of stacking content under a floating bar. Touch
   targets keep their 44px minimum; only spacing and type shrink. */
@media (max-height: 560px) {
  #${BROWSER_PANEL_ROOT_ID} {
    width: min(340px, calc(100vw - 24px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)));
    padding: 10px 12px 12px;
    font-size: 12.5px;
  }
  #${BROWSER_PANEL_ROOT_ID} h2 {
    font-size: 14px;
    margin-bottom: 4px;
  }
  #${BROWSER_PANEL_ROOT_ID} .browser-panel-meta {
    margin-bottom: 6px;
  }
  #${BROWSER_PANEL_ROOT_ID} .browser-panel-info [data-testid="time-line"] {
    font-size: 16px;
  }
  #${BROWSER_PANEL_ROOT_ID} .browser-panel-info [data-testid="weather-hero"] {
    font-size: 19px;
  }
  #${BROWSER_PANEL_ROOT_ID} .browser-panel-info [data-testid="weather-line"] {
    font-size: 13px;
  }
  #${BROWSER_PANEL_ROOT_ID} .browser-panel-row {
    margin-top: 8px;
    gap: 6px;
  }
  #${BROWSER_PANEL_ROOT_ID} details.browser-panel-location {
    margin-top: 8px;
  }
  #${BROWSER_PANEL_ROOT_ID} .browser-panel-note {
    margin-top: 6px;
  }
  #${BROWSER_PANEL_ROOT_ID} .browser-panel-utility {
    padding-top: 8px;
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
  private statusLine: HTMLElement | null = null;
  private locationLine: HTMLElement | null = null;
  private timeLine: HTMLElement | null = null;
  private heroLine: HTMLElement | null = null;
  private weatherLine: HTMLElement | null = null;
  private timeScrub: HTMLInputElement | null = null;
  private badge: HTMLElement | null = null;
  private enterButton: HTMLButtonElement | null = null;
  private exitButton: HTMLButtonElement | null = null;
  private reloadButton: HTMLButtonElement | null = null;
  private sandboxButton: HTMLButtonElement | null = null;
  private sandboxNote: HTMLElement | null = null;
  private xrNote: HTMLElement | null = null;
  private xrSupported: boolean | null = null;
  private launchingXr = false;
  private xrEntryError: string | null = null;
  private rejectedTouchSession: XRSession | null = null;
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
  private lastRenderAt = -Number.MAX_SAFE_INTEGER;
  private lastClockMinute = -1;
  /** Last Permissions API state for geolocation (null until the precheck answers). */
  private permission: GeolocationPermission | null = null;
  private messageTimer: number | null = null;
  /** `fetchedAt` of the dataset whose substitution message was already shown. */
  private seenDatasetAt = -1;
  private unsubscribePermission: (() => void) | null = null;
  private devObserver: MutationObserver | null = null;
  private readonly suppressedDevHosts = new Set<HTMLElement>();
  // Non-XR orbit camera (desktop/mobile 2D only; XR owns the camera when presenting).
  private orbitListenersAttached = false;
  private readonly orbitPointers = new Map<number, { x: number; y: number }>();
  private orbit: { yaw: number; pitch: number; radius: number; yawBase: number } | null = null;
  private orbitRadiusTarget: number | null = null;
  private orbitCanvas: HTMLCanvasElement | null = null;
  private orbitTouchAction: string | null = null;
  private orbitPinchSpan = 0;

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
    const scrubTime = (): void => {
      if (this.timeScrub != null) weatherStore.setPlayhead(this.timeScrub.valueAsNumber);
    };
    const reload = (): void => {
      tick();
      void reloadWeather();
    };
    const launchXR = (): void => {
      if (!this.world.xrEnabled || this.launchingXr || this.world.xrSession != null) return;
      tick();
      firmTap();
      void this.enterXrWithOverlay();
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
        this.showLocationMessage(t('locationInvalid'), 'error');
        return;
      }
      this.showLocationMessage('', 'info');
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
    const locateMe = (): void => {
      tick();
      void this.detectDeviceLocation();
    };
    const toggleSandbox = (): void => {
      tick();
      weatherStore.setSandbox(!weatherStore.state.peek().sandbox);
    };
    const blockWorldSelect = (event: Event): void => event.preventDefault();
    this.root?.addEventListener('beforexrselect', blockWorldSelect);

    this.root?.querySelector('[data-testid="step-back"]')?.addEventListener('click', stepBack);
    this.root?.querySelector('[data-testid="go-live"]')?.addEventListener('click', goLive);
    this.root?.querySelector('[data-testid="step-forward"]')?.addEventListener('click', stepForward);
    this.reloadButton?.addEventListener('click', reload);
    this.enterButton?.addEventListener('click', launchXR);
    this.exitButton?.addEventListener('click', exitXR);
    this.langButton?.addEventListener('click', switchLanguage);
    this.sandboxButton?.addEventListener('click', toggleSandbox);
    this.timeScrub?.addEventListener('input', scrubTime);
    this.locationSelect?.addEventListener('change', applyPreset);
    this.locationApply?.addEventListener('click', applyManualInput);
    this.locationClear?.addEventListener('click', locateMe);

    this.cleanupFuncs.push(
      () => {
        this.root?.querySelector('[data-testid="step-back"]')?.removeEventListener('click', stepBack);
        this.root?.querySelector('[data-testid="go-live"]')?.removeEventListener('click', goLive);
        this.root
          ?.querySelector('[data-testid="step-forward"]')
          ?.removeEventListener('click', stepForward);
      },
      () => this.reloadButton?.removeEventListener('click', reload),
      () => this.enterButton?.removeEventListener('click', launchXR),
      () => this.sandboxButton?.removeEventListener('click', toggleSandbox),
      () => this.timeScrub?.removeEventListener('input', scrubTime),
      () => this.root?.removeEventListener('beforexrselect', blockWorldSelect),
      () => this.exitButton?.removeEventListener('click', exitXR),
      () => this.langButton?.removeEventListener('click', switchLanguage),
      () => this.locationSelect?.removeEventListener('change', applyPreset),
      () => this.locationApply?.removeEventListener('click', applyManualInput),
      () => this.locationClear?.removeEventListener('click', locateMe),
      unsubscribeStore,
      unsubscribeVisibility,
      () => this.xrManager.removeEventListener('sessionstart', onSessionVisibility),
      () => this.xrManager.removeEventListener('sessionend', onSessionVisibility),
      () => this.detachOrbitListeners(),
      () => {
        this.devObserver?.disconnect();
        this.devObserver = null;
        for (const host of this.suppressedDevHosts) host.style.display = '';
        this.suppressedDevHosts.clear();
      },
      () => {
        this.unsubscribePermission?.();
        this.unsubscribePermission = null;
      },
      () => {
        if (this.messageTimer != null) window.clearTimeout(this.messageTimer);
        this.messageTimer = null;
      },
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
      // Sandbox flip from the spatial Button while the DOM is hidden
      // (tracked-hands XR): mark dirty so the toggle state syncs on return.
      weatherEvents.on(WeatherEvent.SandboxToggle, () => {
        if (this.disposed) return;
        if (this.root?.hidden) this.dirty = true;
        else this.render();
      }),
    );
    this.unsubscribeLanguage = onLanguageChange(() => {
      if (!this.disposed) this.render();
    });

    this.applySessionVisibility();
    this.suppressRedundantDevXrEntry();
    this.syncOrbitListeners();
    void this.probeXrSupport();
    void this.syncPermissionState();
    // React to a permission change made in browser settings: a grant must
    // re-run the chain so the device fix replaces the IP/fixed dataset the
    // TTL would otherwise keep for the whole window.
    this.unsubscribePermission = watchGeolocationPermission((state) => {
      this.permission = state;
      if (this.disposed) return;
      // A remembered device fix is only valid while the permission holds.
      if (state !== 'granted') forgetDeviceLocation();
      if (state === 'granted' && getManualLocation() == null) void this.reloadForced();
      else this.render();
    });
  }

  /**
   * IWSDK 1.0.1's launcher has no DOM-overlay option. Use its public
   * feature/reference builders with standard WebXR and Three session entry;
   * keep the SDK's session-end and deferred camera-restore invariants.
   */
  private async enterXrWithOverlay(): Promise<void> {
    this.launchingXr = true;
    this.xrEntryError = null;
    if (this.enterButton != null) this.enterButton.disabled = true;
    let session: XRSession | null = null;
    try {
      const options = this.world.xrDefaults ?? {};
      const init = buildSessionInit(options);
      init.optionalFeatures = [...(init.optionalFeatures ?? []), 'dom-overlay'];
      init.domOverlay = { root: document.body };
      // Request synchronously in the originating click's activation turn.
      session = await navigator.xr!.requestSession(options.sessionMode ?? SessionMode.ImmersiveAR, init);
      if (this.disposed || this.world.xrSession != null) {
        await session.end();
        return;
      }
      const active = session;
      let ended = false;
      const camera = this.world.camera;
      const position = camera.position.clone();
      const quaternion = camera.quaternion.clone();
      const scale = camera.scale.clone();
      const { aspect, fov, near, far, zoom } = camera;
      active.addEventListener('end', () => {
        ended = true;
        if (this.world.session === active) this.world.session = undefined;
        if (options.restoreCameraOnExit !== false) requestAnimationFrame(() => {
          camera.position.copy(position);
          camera.quaternion.copy(quaternion);
          camera.scale.copy(scale);
          camera.aspect = aspect;
          camera.fov = fov;
          camera.near = near;
          camera.far = far;
          camera.zoom = zoom;
          camera.updateProjectionMatrix();
          camera.updateMatrixWorld(true);
        });
      }, { once: true });
      const reference = normalizeReferenceSpec(options.referenceSpace);
      const type = await resolveReferenceSpaceType(
        active, reference.type, reference.required ? [] : reference.fallbackOrder,
      );
      if (ended) return;
      if (this.disposed) {
        await active.end();
        return;
      }
      this.xrManager.enabled = true;
      this.xrManager.setReferenceSpaceType(type);
      // Same single-depth-owner rule as IWSDK's normal session adopter.
      this.xrManager.getDepthSensingMesh = () => null;
      await this.xrManager.setSession(active);
      if (!ended && !this.disposed) this.world.session = active;
      else if (!ended) await active.end();
    } catch (error) {
      this.xrEntryError = error instanceof Error ? error.message : String(error);
      if (session != null) await session.end().catch((endError: unknown) => {
        console.warn('[weather-room] XR entry cleanup failed', endError);
      });
      if (!this.disposed && this.xrNote != null) this.xrNote.textContent = `${t('xrEntryFailed')} ${this.xrEntryError}`;
      console.error('[weather-room] XR entry failed', error);
    } finally {
      this.launchingXr = false;
      if (!this.disposed && this.enterButton != null) this.enterButton.disabled = this.xrSupported !== true;
    }
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
    this.badge = el('span', 'mode-badge', t('badgeLoading'));
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
    this.statusLine = el('p', 'status-line', 'Starting...');
    this.locationLine = el('p', 'location-line', '--');
    this.timeLine = el('p', 'time-line', 'NOW');
    this.heroLine = el('p', 'weather-hero', '--');
    this.weatherLine = el('p', 'weather-line', '--');
    // Hero readout first (time + temp + condition), secondary diagnostics
    // after the core precip/wind lines: DOM order matches visual hierarchy.
    info.append(this.timeLine, this.heroLine, this.weatherLine, this.locationLine, this.statusLine);
    root.appendChild(info);

    const row = document.createElement('div');
    row.className = 'browser-panel-row browser-panel-timeline';
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
    // Native coarse steps and a full-width touch slider; phone AR never
    // depends on reaching a tracked-hand spatial knob.
    row.append(back, now, forward);
    root.appendChild(row);
    this.timeScrub = document.createElement('input');
    this.timeScrub.type = 'range';
    this.timeScrub.min = '-24';
    this.timeScrub.max = '24';
    this.timeScrub.step = '0.5';
    this.timeScrub.value = '0';
    this.timeScrub.dataset.testid = 'time-scrub';
    this.timeScrub.setAttribute('aria-label', t('ariaTimeScrub'));
    root.appendChild(this.timeScrub);

    // Location controls behind one disclosure: the hero readout and the
    // timeline dominate the card; picking a place is a deliberate second
    // step. Testids keep their names, only the container changes.
    const locationDisclosure = document.createElement('details');
    locationDisclosure.className = 'browser-panel-location';
    locationDisclosure.dataset.testid = 'location-disclosure';
    const locationSummary = document.createElement('summary');
    locationSummary.dataset.testid = 'location-label';
    locationSummary.textContent = t('locationLabelPrefix');
    locationDisclosure.appendChild(locationSummary);
    this.locationWrap = document.createElement('div');
    this.locationWrap.className = 'browser-panel-row browser-panel-location-content';
    this.locationWrap.dataset.testid = 'location-row';
    this.locationSelect = document.createElement('select');
    this.locationSelect.id = `${BROWSER_PANEL_ROOT_ID}-location`;
    this.locationSelect.dataset.testid = 'location-presets';
    this.locationSelect.setAttribute('aria-label', t('locationChoose'));
    const chooseCity = document.createElement('option');
    chooseCity.value = '';
    chooseCity.textContent = t('locationChoose');
    this.locationSelect.appendChild(chooseCity);
    for (const preset of LOCATION_PRESETS) {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.label;
      this.locationSelect.appendChild(option);
    }
    const manualRow = document.createElement('div');
    manualRow.className = 'browser-panel-location-manual';
    this.locationInput = document.createElement('input');
    this.locationInput.type = 'text';
    this.locationInput.dataset.testid = 'location-input';
    this.locationInput.setAttribute('aria-label', t('locationPlaceholder'));
    this.locationInput.placeholder = 'lat, lon';
    this.locationInput.setAttribute('inputmode', 'decimal');
    this.locationApply = document.createElement('button');
    this.locationApply.type = 'button';
    this.locationApply.dataset.testid = 'location-set';
    this.locationApply.setAttribute('aria-label', 'Set manual location');
    manualRow.append(this.locationInput, this.locationApply);
    this.locationClear = document.createElement('button');
    this.locationClear.type = 'button';
    this.locationClear.dataset.testid = 'location-auto';
    this.locationClear.setAttribute('aria-label', t('ariaDetectLocation'));
    this.locationWrap.append(this.locationSelect, manualRow, this.locationClear);
    locationDisclosure.appendChild(this.locationWrap);
    this.locationError = el('p', 'location-error', '');
    this.locationError.className = 'browser-panel-note';
    this.locationError.hidden = true;
    locationDisclosure.appendChild(this.locationError);

    // One short hint line: how to show weather for your own place.
    this.locationHintEl = el('p', 'location-hint', t('locationHint'));
    this.locationHintEl.className = 'browser-panel-note';
    locationDisclosure.appendChild(this.locationHintEl);
    root.appendChild(locationDisclosure);

    // Labelled gesture-sandbox toggle: same store flip as the spatial
    // Button, with visible OFF/ON state. Phone browsers (and phone XR)
    // have no hand tracking, so the note says so instead of faking it.
    const sandboxRow = document.createElement('div');
    sandboxRow.className = 'browser-panel-row browser-panel-sandbox';
    sandboxRow.setAttribute('role', 'group');
    sandboxRow.setAttribute('aria-label', t('ariaSandbox'));
    this.sandboxButton = document.createElement('button');
    this.sandboxButton.type = 'button';
    this.sandboxButton.dataset.testid = 'sandbox-toggle';
    this.sandboxButton.dataset.state = 'off';
    this.sandboxButton.textContent = t('sandboxOff');
    this.sandboxButton.setAttribute('aria-label', t('ariaSandbox'));
    sandboxRow.append(this.sandboxButton);
    root.appendChild(sandboxRow);
    this.sandboxNote = el('p', 'sandbox-note', t('sandboxHint'));
    this.sandboxNote.className = 'browser-panel-note';
    root.appendChild(this.sandboxNote);
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
    this.xrNote = el('p', 'xr-note', 'Checking XR support...');
    this.xrNote.className = 'browser-panel-note';
    root.appendChild(this.xrNote);

    // Split the card into an independently scrolling body and a fixed action
    // footer: the actions can never be painted over by scrolled content, and
    // they stay reachable on short viewports without scrolling the card.
    const body = document.createElement('div');
    body.className = 'browser-panel-body';
    while (root.firstChild != null) body.appendChild(root.firstChild);
    root.append(body, xrRow);

    document.body.appendChild(root);
    this.root = root;
  }

  private applySessionVisibility(): void {
    if (this.root == null) return;
    // Handheld screen/transient-pointer XR has no tracked hands: the DOM
    // panel stays mounted so native touch controls keep working, while
    // the spatial panel (PanelSystem, same helper) hides itself.
    // usesSpatialControls() also re-resolves when delayed tracked sources
    // arrive, so update() re-checks every frame below.
    const presenting = this.xrManager.isPresenting;
    const spatial = presenting && usesSpatialControls(this.world);
    const phoneXr = presenting && !spatial;
    const session = this.world.xrSession;
    if (phoneXr && session != null && session.domOverlayState == null && this.rejectedTouchSession !== session) {
      for (const source of session.inputSources) {
        if (source.targetRayMode !== 'screen' && source.targetRayMode !== 'transient-pointer') continue;
        // A handheld session without a granted overlay has no reachable UI.
        this.rejectedTouchSession = session;
        this.xrEntryError = t('xrTouchUnavailable');
        void this.world.exitXR();
        break;
      }
    }
    const wasHidden = this.root.hidden;
    this.root.hidden = spatial;
    this.root.dataset.session = spatial ? 'immersive' : presenting ? 'phone-xr' : 'browser';
    if (this.enterButton != null) this.enterButton.hidden = presenting || !this.world.xrEnabled;
    if (this.exitButton != null) this.exitButton.hidden = !presenting;
    if (this.xrNote != null && !this.world.xrEnabled) {
      this.xrNote.textContent = t('xrDisabled');
    } else if (this.xrNote != null && phoneXr) {
      this.xrNote.textContent = t('xrPhoneNote');
    } else if (this.xrNote != null && !presenting && this.xrEntryError != null) {
      this.xrNote.textContent = `${t('xrEntryFailed')} ${this.xrEntryError}`;
    }
    if (wasHidden !== spatial && !this.root.hidden) this.dirty = true;
    // XR owns the camera while presenting; the 2D orbit owns it otherwise.
    this.syncOrbitListeners();
    this.syncSandboxNote();
  }
  /** Throttled visible refresh: the cached frame advances even without store events. */
  update(): void {
    // Zoom easing runs every frame (before the panel's throttle guard).
    this.stepOrbitZoom();
    // Delayed tracked-source arrival flips usesSpatialControls mid-session:
    // re-resolve visibility every frame so neither surface freezes.
    this.applySessionVisibility();
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
    this.xrSupported = supported;
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

    if (this.badge != null) {
      const demo = demoDataset || status.kind === 'demo';
      const loading = current == null || dataset == null;
      this.badge.textContent = loading ? t('badgeLoading') : demo ? t('badgeDemo') : t('badgeLive');
      this.badge.dataset.mode = loading ? 'loading' : demo ? 'demo' : 'live';
    }
    if (this.reloadButton != null) {
      const loading = status.kind === 'loading' || status.kind === 'locating';
      // Busy state is carried by the disabled button and the status line; the
      // label never changes, so it can never shift or spill out of the box.
      this.reloadButton.disabled = loading;
      this.reloadButton.setAttribute('aria-busy', loading ? 'true' : 'false');
    }
    if (this.timeScrub != null) {
      this.timeScrub.disabled = current == null;
      this.timeScrub.value = String(playheadHours);
      this.timeScrub.setAttribute('aria-valuetext', isLive ? t('playheadNow') : `${playheadHours}h`);
    }

    if (current == null || dataset == null) {
      if (this.statusLine != null) {
        this.statusLine.textContent =
          status.kind === 'loading'
            ? `${t('loadingPrefix')}${localizeLoadingLabel(status.label, lang)}`
            : t('statusLoading');
      }
      if (this.locationLine != null) this.locationLine.textContent = t('locatingShort');
      if (this.timeLine != null) this.timeLine.textContent = '...';
      if (this.heroLine != null) this.heroLine.textContent = t('missingValue');
      if (this.weatherLine != null) this.weatherLine.textContent = t('missingValue');
      return;
    }

    const { frame } = current;
    const staleSuffix = frame.stale ? t('staleSuffixParen') : '';
    const providerDisplay =
      !demoDataset
        ? (PROVIDER_DISPLAY[providerOf(dataset.source) as keyof typeof PROVIDER_DISPLAY] ?? providerOf(dataset.source))
        : '';
    // One dim secondary line: honest status core (already names the provider
    // when live); no provider token is appended because that only repeated it.
    if (this.statusLine != null) {
      const statusCore =
        status.kind === 'demo'
          ? `${t('demoDataPrefix')}${localizeDataPhrase(status.reason, lang)}`
          : demoDataset
            ? `${t('statusDemoRetained')}${staleSuffix}`
            : `${sourceStatus(providerDisplay, staleSuffix, lang)}`;
      this.statusLine.textContent = statusCore;
    }
    const place = dataset.label.split(' · ').slice(1).join(' · ') || dataset.label;
    if (this.locationLine != null) {
      this.locationLine.textContent = demoDataset
        ? localizePlaceLabel(place, lang)
        : this.composeLocationLine(place, dataset.locationOrigin, dataset.locationAccuracyM, lang);
    }
    // One honest message when the chain silently swapped a device fix for the
    // IP/fixed fallback: the user must know they are not seeing their own place.
    if (!demoDataset && dataset.fetchedAt !== this.seenDatasetAt) {
      this.seenDatasetAt = dataset.fetchedAt;
      const code = dataset.locationErrorCode;
      if (dataset.locationOrigin === 'ip' || dataset.locationOrigin === 'fallback') {
        if (code === 1) this.showLocationMessage(t('geoDenied'), 'warn', 8000);
        else if (code === 2) this.showLocationMessage(t('geoUnavailable'), 'warn', 8000);
        else if (code === 3) this.showLocationMessage(t('geoTimeout'), 'warn', 8000);
      }
    }

    const at = playheadTime(dataset, playheadHours, new Date());
    const beyond = frame.outOfCoverage ? t('beyondSuffixDash') : '';
    const hours = at.getHours() < 10 ? `0${at.getHours()}` : `${at.getHours()}`;
    const minutes = at.getMinutes() < 10 ? `0${at.getMinutes()}` : `${at.getMinutes()}`;
    const label = isLive
      ? `${t('playheadNow')}${beyond}`
      : `${hours}:${minutes} (${playheadHours > 0 ? '+' : ''}${playheadHours}h)${beyond}`;
    if (this.timeLine != null) this.timeLine.textContent = label;

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
    if (this.sandboxButton != null) {
      const on = weatherStore.state.peek().sandbox;
      this.sandboxButton.textContent = on ? t('sandboxOn') : t('sandboxOff');
      this.sandboxButton.dataset.state = on ? 'on' : 'off';
      this.sandboxButton.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  /** Static chrome: buttons, labels, aria, and the location picker skeleton. */
  private applyChromeLabels(lang: Language): void {
    this.root?.setAttribute('aria-label', t('ariaPanel'));
    this.root?.querySelector('.browser-panel-timeline')?.setAttribute('aria-label', t('ariaTimelineGroup'));
    this.root?.querySelector('.browser-panel-utility')?.setAttribute('aria-label', t('ariaXrGroup'));
    this.root?.querySelector('[data-testid="step-back"]')?.setAttribute('aria-label', t('ariaStepBack'));
    this.root?.querySelector('[data-testid="go-live"]')?.setAttribute('aria-label', t('ariaGoLive'));
    this.root?.querySelector('[data-testid="step-forward"]')?.setAttribute('aria-label', t('ariaStepForward'));
    const back = this.root?.querySelector('[data-testid="step-back"]');
    const now = this.root?.querySelector('[data-testid="go-live"]');
    const forward = this.root?.querySelector('[data-testid="step-forward"]');
    if (back != null) back.textContent = t('stepBack');
    if (now != null) now.textContent = t('goLive');
    if (forward != null) forward.textContent = t('stepForward');
    this.timeScrub?.setAttribute('aria-label', t('ariaTimeScrub'));
    if (this.reloadButton != null) {
      this.reloadButton.textContent = t('reload');
      this.reloadButton.setAttribute('aria-label', t('ariaReload'));
    }
    if (this.langButton != null) {
      this.langButton.textContent = t('langName');
      this.langButton.setAttribute('aria-label', t('ariaSwitchLanguage'));
    }
    if (this.enterButton != null) this.enterButton.textContent = t('enterAr');
    if (this.exitButton != null) this.exitButton.textContent = t('exit');
    if (this.xrNote != null) {
      const presenting = this.xrManager.isPresenting;
      const spatial = presenting && usesSpatialControls(this.world);
      this.xrNote.textContent = !this.world.xrEnabled ? t('xrDisabled')
        : spatial ? t('xrEnterHint')
        : presenting ? t('xrPhoneNote')
        : this.xrEntryError != null ? `${t('xrEntryFailed')} ${this.xrEntryError}`
        : this.xrSupported == null ? t('xrChecking')
        : this.xrSupported ? t('xrEnterHint') : t('xrUnavailable');
    }
    this.root?.querySelector('[data-testid="location-label"]')?.replaceChildren(t('locationLabelPrefix'));
    this.locationSelect?.setAttribute('aria-label', t('locationChoose'));
    if (this.locationInput != null) {
      this.locationInput.placeholder = t('locationPlaceholder');
      this.locationInput.setAttribute('aria-label', t('locationPlaceholder'));
    }
    if (this.locationApply != null) {
      this.locationApply.textContent = t('locationApply');
      this.locationApply.setAttribute('aria-label', t('locationApply'));
    }
    if (this.locationClear != null) {
      this.locationClear.textContent = t('locationClear');
      this.locationClear.setAttribute('aria-label', t('ariaDetectLocation'));
    }
    if (this.sandboxButton != null) {
      const on = weatherStore.state.peek().sandbox;
      this.sandboxButton.textContent = on ? t('sandboxOn') : t('sandboxOff');
      this.sandboxButton.dataset.state = on ? 'on' : 'off';
      this.sandboxButton.setAttribute('aria-label', t('ariaSandbox'));
      this.sandboxButton.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    this.root?.querySelector('.browser-panel-sandbox')?.setAttribute('aria-label', t('ariaSandbox'));
    this.syncSandboxNote();
  }

  /** Keep the preset select in sync with the persisted manual location. */
  private syncLocationRow(lang: Language): void {
    const manual = getManualLocation();
    if (this.locationSelect != null) {
      const options = this.locationSelect.querySelectorAll('option');
      const chooseCity = options.item(0);
      if (chooseCity != null) chooseCity.textContent = t('locationChoose');
      LOCATION_PRESETS.forEach((preset, index) => {
        const option = options.item(index + 1);
        if (option != null) option.textContent = localizePresetLabel(preset.label, lang);
      });
      this.locationSelect.value = LOCATION_PRESETS.find((preset) => preset.label === manual?.label)?.id ?? '';
    }
    if (this.locationInput != null && document.activeElement !== this.locationInput) {
      this.locationInput.value = manual != null ? `${manual.latitude}, ${manual.longitude}` : '';
    }
  }
  /**
   * Sandbox explainer: gestures require tracked XR input; native touch
   * controls never claim that a phone/browser can detect a clap.
   */
  private syncSandboxNote(): void {
    if (this.sandboxNote == null) return;
    const on = weatherStore.state.peek().sandbox;
    this.sandboxNote.textContent = `${on ? t('sandboxHintOn') : t('sandboxHint')} ${t('sandboxPhoneNote')}`;
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

  /** Honest location line: origin token first, then the place/coords it names. */
  private composeLocationLine(
    place: string,
    origin: LocationOrigin,
    accuracyM: number | undefined,
    lang: Language,
  ): string {
    if (origin === 'device') return `${locationOriginLabel('device', lang, accuracyM)} · ${place}`;
    if (origin === 'ip') {
      const city = /^IP-based location \((.*)\)$/.exec(place)?.[1] ?? '';
      return city === '' ? locationOriginLabel('ip', lang) : `${locationOriginLabel('ip', lang)} · ${city}`;
    }
    if (origin === 'manual') {
      return `${locationOriginLabel('manual', lang)} · ${place.replace(' (manual location)', '')}`;
    }
    return locationOriginLabel('fallback', lang);
  }

  /**
   * In-flow status/toast line under the location row. `timeoutMs` clears it
   * again (transient toast); omitting it keeps the text until replaced. Kept
   * inside the card flow so a message can never overlap a control.
   */
  private showLocationMessage(text: string, state: 'info' | 'warn' | 'error', timeoutMs?: number): void {
    const node = this.locationError;
    if (node == null) return;
    if (this.messageTimer != null) {
      window.clearTimeout(this.messageTimer);
      this.messageTimer = null;
    }
    node.textContent = text;
    node.dataset.state = state;
    node.hidden = text === '';
    if (text !== '' && timeoutMs != null) {
      this.messageTimer = window.setTimeout(() => {
        this.messageTimer = null;
        if (this.disposed) return;
        node.textContent = '';
        node.hidden = true;
      }, timeoutMs);
    }
  }

  /** Permissions API precheck; drives the hint line and the onchange reaction. */
  private async syncPermissionState(): Promise<void> {
    const state = await geolocationPermissionState();
    if (this.disposed) return;
    this.permission = state;
    this.render();
  }

  /** Refetch bypassing the TTL (used after a fresh permission grant). */
  private async reloadForced(): Promise<void> {
    weatherStore.setStatus({ kind: 'locating' });
    const { dataset, status } = await loadWeather(undefined, { force: true });
    if (this.disposed) return;
    weatherStore.setDataset(dataset);
    if (status.kind !== 'ready') weatherStore.setStatus(status);
  }

  /**
   * "Locate me" gesture: clear any manual override, escalate a device fix via
   * `watchPosition(enableHighAccuracy)`, then load weather at that fix. Every
   * failure mode is reported by its geolocation error code (1/2/3) instead of
   * one generic message.
   */
  private async detectDeviceLocation(): Promise<void> {
    if (this.locationClear != null) this.locationClear.disabled = true;
    this.showLocationMessage(t('locationDetecting'), 'info');
    try {
      const outcome = await requestDeviceLocation({ enableHighAccuracy: true });
      if (this.disposed) return;
      if (!outcome.ok || outcome.location == null) {
        // Non-destructive: a manual override and the current dataset stay put.
        this.showLocationMessage(
          outcome.errorCode === 1 ? t('geoDenied')
            : outcome.errorCode === 2 ? t('geoUnavailable')
            : outcome.errorCode === 3 ? t('geoTimeout')
            : t('geoUnsupported'),
          'warn',
        );
        return;
      }
      // The device fix is now the answer: drop a stored override so later
      // loads do not silently revert to the manual city.
      setManualLocation(null);
      const { dataset, status } = await loadWeather(undefined, {
        force: true,
        location: outcome.location,
      });
      if (this.disposed) return;
      weatherStore.setDataset(dataset);
      if (status.kind !== 'ready') weatherStore.setStatus(status);
      this.showLocationMessage('', 'info');
    } finally {
      if (!this.disposed && this.locationClear != null) this.locationClear.disabled = false;
    }
  }

  /**
   * IWSDK's dev harness injects its own "Enter XR" pill into an open shadow
   * root (dev-server only; absent from production builds). The panel's Enter AR
   * is the product's single entry, so that duplicate is hidden as soon as it is
   * attached, without touching the harness API (CLI `xr enter` and
   * `world.launchXR()` keep working).
   */
  private suppressRedundantDevXrEntry(): void {
    const scan = (): void => {
      for (const child of Array.from(document.body.children)) {
        const host = child as HTMLElement;
        if (host.shadowRoot == null || this.suppressedDevHosts.has(host)) continue;
        if (host.shadowRoot.textContent?.includes('Enter XR') !== true) continue;
        this.suppressedDevHosts.add(host);
        host.style.display = 'none';
      }
    };
    scan();
    this.devObserver = new MutationObserver(scan);
    this.devObserver.observe(document.body, { childList: true });
  }

  /** Attach the 2D orbit listeners to the renderer canvas only, never the panel. */
  private syncOrbitListeners(): void {
    const canvas = (this.world.renderer?.domElement ?? null) as HTMLCanvasElement | null;
    const shouldAttach = canvas != null && !this.xrManager.isPresenting;
    if (shouldAttach && !this.orbitListenersAttached) this.attachOrbitListeners(canvas);
    else if (!shouldAttach && this.orbitListenersAttached) this.detachOrbitListeners();
  }

  private attachOrbitListeners(canvas: HTMLCanvasElement): void {
    this.orbitCanvas = canvas;
    this.orbitTouchAction = canvas.style.touchAction;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', this.onOrbitPointerDown);
    canvas.addEventListener('pointermove', this.onOrbitPointerMove);
    canvas.addEventListener('pointerup', this.onOrbitPointerUp);
    canvas.addEventListener('pointercancel', this.onOrbitPointerUp);
    canvas.addEventListener('wheel', this.onOrbitWheel, { passive: false });
    this.orbitListenersAttached = true;
  }

  private detachOrbitListeners(): void {
    const canvas = this.orbitCanvas;
    if (canvas != null) {
      canvas.removeEventListener('pointerdown', this.onOrbitPointerDown);
      canvas.removeEventListener('pointermove', this.onOrbitPointerMove);
      canvas.removeEventListener('pointerup', this.onOrbitPointerUp);
      canvas.removeEventListener('pointercancel', this.onOrbitPointerUp);
      canvas.removeEventListener('wheel', this.onOrbitWheel);
      canvas.style.touchAction = this.orbitTouchAction ?? '';
    }
    this.orbitPointers.clear();
    this.orbitPinchSpan = 0;
    this.orbitCanvas = null;
    this.orbitListenersAttached = false;
  }

  /** Derive the orbit from the authored camera pose so drag starts 1:1. */
  private ensureOrbit(): void {
    if (this.orbit != null) return;
    const camera = this.world.camera;
    const dx = camera.position.x - ORBIT_TARGET.x;
    const dy = camera.position.y - ORBIT_TARGET.y;
    const dz = camera.position.z - ORBIT_TARGET.z;
    const distance = Math.hypot(dx, dy, dz);
    const radius = Math.max(ORBIT_MIN_RADIUS, Math.min(ORBIT_MAX_RADIUS, distance));
    const yaw = Math.atan2(dx, dz);
    const pitch = Math.asin(Math.max(-1, Math.min(1, dy / (distance || 1))));
    this.orbit = {
      yaw,
      pitch: Math.max(ORBIT_MIN_PITCH, Math.min(ORBIT_MAX_PITCH, pitch)),
      radius,
      yawBase: yaw,
    };
    this.orbitRadiusTarget = radius;
  }

  /** Write the orbit pose to the camera; a no-op while XR owns the camera. */
  private applyOrbit(): void {
    const orbit = this.orbit;
    if (orbit == null || this.xrManager.isPresenting) return;
    const cosPitch = Math.cos(orbit.pitch);
    const camera = this.world.camera;
    camera.position.set(
      ORBIT_TARGET.x + orbit.radius * cosPitch * Math.sin(orbit.yaw),
      ORBIT_TARGET.y + orbit.radius * Math.sin(orbit.pitch),
      ORBIT_TARGET.z + orbit.radius * cosPitch * Math.cos(orbit.yaw),
    );
    // lookAt reads matrixWorld, which is stale mid-frame; refresh it first so
    // the orientation matches the position written just above.
    camera.updateWorldMatrix(true, false);
    camera.lookAt(ORBIT_TARGET.x, ORBIT_TARGET.y, ORBIT_TARGET.z);
    // Read-only state for tooling/verification (never consumed by the app).
    if (this.root != null) {
      this.root.dataset.orbit =
        `${orbit.yaw.toFixed(3)},${orbit.pitch.toFixed(3)},${orbit.radius.toFixed(3)},` +
        `${camera.position.x.toFixed(3)},${camera.position.y.toFixed(3)},${camera.position.z.toFixed(3)}`;
    }
  }

  /** Multiplicative zoom with hard limits; the radius eases in update(). */
  private zoomOrbit(factor: number): void {
    const base = this.orbitRadiusTarget ?? this.orbit?.radius ?? 0;
    if (!(base > 0) || !Number.isFinite(factor)) return;
    this.orbitRadiusTarget = Math.max(ORBIT_MIN_RADIUS, Math.min(ORBIT_MAX_RADIUS, base * factor));
  }

  private pointerSpan(): number {
    const points = [...this.orbitPointers.values()];
    if (points.length < 2) return 0;
    return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
  }

  private readonly onOrbitPointerDown = (event: PointerEvent): void => {
    // Panel-first: taps that start on the DOM card (or any non-canvas
    // surface) never start an orbit; the canvas cannot swallow a control.
    if (event.target !== this.orbitCanvas) return;
    const canvas = this.orbitCanvas;
    if (canvas == null || event.button !== 0) return;
    event.preventDefault();
    this.orbitPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is best-effort; drag still works without it.
    }
    if (this.orbitPointers.size === 2) this.orbitPinchSpan = this.pointerSpan();
    this.ensureOrbit();
  };

  private readonly onOrbitPointerMove = (event: PointerEvent): void => {
    const start = this.orbitPointers.get(event.pointerId);
    const orbit = this.orbit;
    if (start == null || orbit == null || this.xrManager.isPresenting) return;
    event.preventDefault();
    this.orbitPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.orbitPointers.size >= 2) {
      // Two-finger pinch: zoom, never orbit, so the frame cannot lurch.
      const span = this.pointerSpan();
      if (this.orbitPinchSpan > 0 && span > 0) this.zoomOrbit(this.orbitPinchSpan / span);
      this.orbitPinchSpan = span;
      return;
    }
    const yaw = orbit.yaw - (event.clientX - start.x) * 0.006;
    const pitch = orbit.pitch + (event.clientY - start.y) * 0.006;
    orbit.yaw = Math.max(orbit.yawBase - ORBIT_YAW_LIMIT, Math.min(orbit.yawBase + ORBIT_YAW_LIMIT, yaw));
    orbit.pitch = Math.max(ORBIT_MIN_PITCH, Math.min(ORBIT_MAX_PITCH, pitch));
    this.applyOrbit();
  };

  private readonly onOrbitPointerUp = (event: PointerEvent): void => {
    if (!this.orbitPointers.delete(event.pointerId)) return;
    const canvas = this.orbitCanvas;
    if (canvas != null && canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    if (this.orbitPointers.size < 2) this.orbitPinchSpan = 0;
  };

  private readonly onOrbitWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.ensureOrbit();
    this.zoomOrbit(Math.exp(event.deltaY * 0.0012));
  };

  /** Ease the zoomed radius toward its target; drag stays exactly 1:1. */
  private stepOrbitZoom(): void {
    const orbit = this.orbit;
    const target = this.orbitRadiusTarget;
    if (orbit == null || target == null || this.disposed || this.xrManager.isPresenting) return;
    const delta = target - orbit.radius;
    if (Math.abs(delta) < 0.002) {
      if (orbit.radius === target) return;
      orbit.radius = target;
    } else {
      orbit.radius += delta * 0.22;
    }
    this.applyOrbit();
  }
}
