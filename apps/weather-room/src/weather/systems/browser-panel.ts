/** Native HTML controls for desktop/phone browsers; XR uses the spatial panel. */

import { createSystem } from '@iwsdk/core';
import { PLAYHEAD_MAX_H, PLAYHEAD_MIN_H, playheadTime, weatherStore } from '../weather-state.js';
import { reloadWeather } from './weather-loader.js';

/** Stable DOM id for the browser controls. */
export const BROWSER_PANEL_ROOT_ID = 'weather-browser-panel';

const STYLE_ID = `${BROWSER_PANEL_ROOT_ID}-style`;

const FONT_BASE = `${import.meta.env.BASE_URL}fonts/`;

const CSS = `
@font-face {
  font-family: Geologica;
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url("${FONT_BASE}geologica-regular.woff2") format("woff2");
}
@font-face {
  font-family: Geologica;
  font-style: normal;
  font-weight: 500;
  font-display: swap;
  src: url("${FONT_BASE}geologica-medium.woff2") format("woff2");
}
@font-face {
  font-family: Geologica;
  font-style: normal;
  font-weight: 600;
  font-display: swap;
  src: url("${FONT_BASE}geologica-semibold.woff2") format("woff2");
}
@font-face {
  font-family: Geologica;
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url("${FONT_BASE}geologica-bold.woff2") format("woff2");
}
@font-face {
  font-family: Unbounded;
  font-style: normal;
  font-weight: 500;
  font-display: swap;
  src: url("${FONT_BASE}unbounded-medium.woff2") format("woff2");
}
@font-face {
  font-family: Unbounded;
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url("${FONT_BASE}unbounded-bold.woff2") format("woff2");
}
#${BROWSER_PANEL_ROOT_ID}[hidden] {
  display: none !important;
}
#${BROWSER_PANEL_ROOT_ID} {
  position: fixed;
  left: calc(12px + env(safe-area-inset-left, 0px));
  right: auto;
  bottom: calc(12px + env(safe-area-inset-bottom, 0px));
  width: min(400px, calc(100vw - 24px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)));
  max-height: calc(100dvh - 24px - env(safe-area-inset-bottom, 0px));
  overflow-y: auto;
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
#${BROWSER_PANEL_ROOT_ID} .browser-panel-info [data-testid="weather-line"] {
  font-variant-numeric: tabular-nums;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-info [data-testid="time-line"] {
  font-size: 20px;
  font-weight: 700;
  color: #eef5ff;
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
#${BROWSER_PANEL_ROOT_ID} button:hover {
  border-color: rgba(121, 215, 242, 0.42);
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
#${BROWSER_PANEL_ROOT_ID} input[type="range"] {
  width: 100%;
  min-height: 44px;
  margin: 0;
  touch-action: pan-y;
  accent-color: #79d7f2;
}
#${BROWSER_PANEL_ROOT_ID} .browser-panel-note {
  margin: 8px 0 0;
  font-size: 12px;
  color: #94aac8;
  font-variant-numeric: tabular-nums;
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
  private weatherLine: HTMLElement | null = null;
  private badge: HTMLElement | null = null;
  private enterButton: HTMLButtonElement | null = null;
  private exitButton: HTMLButtonElement | null = null;
  private reloadButton: HTMLButtonElement | null = null;
  private xrNote: HTMLElement | null = null;
  private dirty = true;
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

    const stepBack = (): void => {
      weatherStore.setPlayhead(weatherStore.state.peek().playheadHours - 6);
    };
    const stepForward = (): void => {
      weatherStore.setPlayhead(weatherStore.state.peek().playheadHours + 6);
    };
    const goLive = (): void => {
      weatherStore.goLive();
    };
    const reload = (): void => {
      void reloadWeather();
    };
    const scrub = (): void => {
      if (this.range == null) return;
      weatherStore.setPlayhead(Number(this.range.value));
    };
    const launchXR = (): void => {
      if (!this.world.xrEnabled) return;
      void this.world.launchXR();
    };
    const exitXR = (): void => {
      void this.world.exitXR();
    };

    this.root?.querySelector('[data-testid="step-back"]')?.addEventListener('click', stepBack);
    this.root?.querySelector('[data-testid="go-live"]')?.addEventListener('click', goLive);
    this.root?.querySelector('[data-testid="step-forward"]')?.addEventListener('click', stepForward);
    this.reloadButton?.addEventListener('click', reload);
    this.range?.addEventListener('input', scrub);
    this.enterButton?.addEventListener('click', launchXR);
    this.exitButton?.addEventListener('click', exitXR);

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
      () => this.enterButton?.removeEventListener('click', launchXR),
      () => this.exitButton?.removeEventListener('click', exitXR),
      unsubscribeStore,
      unsubscribeVisibility,
      () => this.xrManager.removeEventListener('sessionstart', onSessionVisibility),
      () => this.xrManager.removeEventListener('sessionend', onSessionVisibility),
      () => {
        this.disposed = true;
        this.root?.remove();
        document.getElementById(STYLE_ID)?.remove();
        this.root = null;
      },
    );

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
    meta.append(this.badge, version);
    root.appendChild(meta);

    const info = document.createElement('div');
    info.className = 'browser-panel-info';
    info.setAttribute('aria-live', 'polite');
    this.statusLine = el('p', 'status-line', 'Starting…');
    this.locationLine = el('p', 'location-line', '--');
    this.timeLine = el('p', 'time-line', 'NOW');
    this.weatherLine = el('p', 'weather-line', '--');
    info.append(this.statusLine, this.locationLine, this.timeLine, this.weatherLine);
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
    row.append(back, now, forward, this.reloadButton);
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

    const xrRow = document.createElement('div');
    xrRow.className = 'browser-panel-row';
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
    xrRow.append(this.enterButton, this.exitButton);
    root.appendChild(xrRow);
    this.xrNote = el('p', 'xr-note', 'Checking XR support…');
    this.xrNote.className = 'browser-panel-note';
    root.appendChild(this.xrNote);

    document.body.appendChild(root);
    this.root = root;
  }

  /** Browser DOM is not an immersive WebXR layer. */
  private applySessionVisibility(): void {
    if (this.root == null) return;
    // The last XR visibility signal can outlive sessionend until the next render frame.
    const is2D = !this.xrManager.isPresenting;
    this.root.hidden = !is2D;
    this.root.dataset.session = is2D ? 'browser' : 'immersive';
    if (this.enterButton != null) this.enterButton.hidden = !is2D || !this.world.xrEnabled;
    if (this.exitButton != null) this.exitButton.hidden = is2D;
    if (this.xrNote != null && !this.world.xrEnabled) {
      this.xrNote.textContent = 'XR is not enabled in this build. Timeline and reload work in the browser.';
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
        this.xrNote.textContent =
          'XR is not enabled in this build. Timeline and reload work in the browser.';
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
      this.xrNote.textContent = supported
        ? 'Enter AR: use controller rays, hand pinch, or tap the spatial buttons on a phone.'
        : 'AR is not available in this browser. Timeline and reload work here; use a WebXR browser or headset for immersion.';
    }
    this.applySessionVisibility();
  }

  private render(): void {
    if (this.root == null || this.disposed) return;
    this.lastRenderAt = performance.now();
    this.dirty = false;
    this.lastClockMinute = new Date().getMinutes();
    const state = weatherStore.state.peek();
    const { status, dataset, playheadHours, isLive } = state;
    const current = weatherStore.current();
    // A retained synthetic dataset stays DEMO even while a reload is loading.
    const demoDataset = dataset?.source === 'demo';

    if (this.range != null && document.activeElement !== this.range) {
      this.range.value = String(playheadHours);
      this.range.setAttribute(
        'aria-valuetext',
        isLive ? 'live, now' : `${playheadHours > 0 ? '+' : ''}${playheadHours} hours from now`,
      );
    }

    if (this.badge != null) {
      const demo = demoDataset || status.kind === 'demo';
      this.badge.textContent = demo ? 'DEMO' : 'LIVE';
      this.badge.dataset.mode = demo ? 'demo' : 'live';
    }
    if (this.reloadButton != null) {
      const loading = status.kind === 'loading' || status.kind === 'locating';
      this.reloadButton.disabled = loading;
      this.reloadButton.textContent = loading ? 'Loading…' : 'Reload';
    }

    if (current == null || dataset == null) {
      if (this.statusLine != null) {
        this.statusLine.textContent =
          status.kind === 'loading' ? `Loading: ${status.label}` : 'Loading weather…';
      }
      if (this.locationLine != null) this.locationLine.textContent = 'Locating…';
      if (this.timeLine != null) this.timeLine.textContent = isLive ? 'NOW' : `${playheadHours}h`;
      if (this.weatherLine != null) this.weatherLine.textContent = '--';
      if (this.playheadValue != null) this.playheadValue.textContent = isLive ? 'NOW' : `${playheadHours}h`;
      return;
    }

    const { frame } = current;
    const staleSuffix = frame.stale ? ' (cached)' : '';
    if (this.statusLine != null) {
      this.statusLine.textContent =
        status.kind === 'demo'
          ? `Demo data: ${status.reason}`
          : demoDataset
            ? `Demo data — retained while reloading${staleSuffix}`
            : `Live from Open-Meteo${staleSuffix}`;
    }
    if (this.locationLine != null) this.locationLine.textContent = dataset.label;

    const at = playheadTime(dataset, playheadHours, new Date());
    const beyond = frame.outOfCoverage ? ' — beyond data' : '';
    const hours = at.getHours() < 10 ? `0${at.getHours()}` : `${at.getHours()}`;
    const minutes = at.getMinutes() < 10 ? `0${at.getMinutes()}` : `${at.getMinutes()}`;
    const label = isLive ? `NOW${beyond}` : `${hours}:${minutes} (${playheadHours > 0 ? '+' : ''}${playheadHours}h)${beyond}`;
    if (this.timeLine != null) this.timeLine.textContent = label;
    if (this.playheadValue != null) this.playheadValue.textContent = label;

    if (this.weatherLine != null) {
      const temp = Number.isFinite(frame.temperatureC) ? `${frame.temperatureC.toFixed(1)} C` : '-- C';
      const code = frame.available.weatherCode ? weatherCodeName(frame.weatherCode) : '--';
      const rain = Number.isFinite(frame.precipitationMm) ? `${frame.precipitationMm.toFixed(1)} mm/h` : '-- mm/h';
      const wind = Number.isFinite(frame.windSpeedKmh) ? `${Math.round(frame.windSpeedKmh)} km/h` : '-- km/h';
      this.weatherLine.textContent = `${temp} | ${code} | rain ${rain} | wind ${wind}`;
    }
  }
}
