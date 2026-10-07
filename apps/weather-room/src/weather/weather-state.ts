/**
 * WEATHER//ROOM timeline state: a plain subscribable store holding the cached
 * hourly dataset and the playhead position (hours relative to NOW, -24..+24).
 *
 * Framework-neutral by design — IWSDK systems peek() this store in update()
 * instead of the store pushing into the render loop. One fetch feeds the whole
 * timeline; scrubbing never triggers network activity.
 */

import { REFRESH_TTL_MS, type WeatherDataset, type WeatherLoadStatus } from './weather-data.js';

export const PLAYHEAD_MIN_H = -24;
export const PLAYHEAD_MAX_H = 24;

/** Instantaneous (interpolated) weather at the playhead. NaN marks unavailable numeric fields; check `available`. */
export interface WeatherFrame {
  readonly time: Date;
  readonly temperatureC: number;
  /** Precipitation mm/h — drives rain intensity. */
  readonly precipitationMm: number;
  /** Snowfall cm/h. */
  readonly snowfallCm: number;
  /** WMO weather code (categorical; nearest hour). */
  readonly weatherCode: number;
  /** Relative humidity %. */
  readonly humidityPct: number;
  /** 1 = daylight, 0 = night (categorical; nearest hour). */
  readonly isDay: number;
  readonly windSpeedKmh: number;
  /** Meteorological direction (wind comes FROM), degrees. */
  readonly windDirectionDeg: number;
  /** Wind gusts km/h. */
  readonly windGustsKmh: number;
  readonly cloudCoverPct: number;
  readonly pressureHpa: number;
  readonly apparentTemperatureC: number;
  readonly precipitationProbabilityPct: number;
  readonly visibilityM: number;
  readonly available: {
    readonly temperatureC: boolean;
    readonly precipitationMm: boolean;
    readonly snowfallCm: boolean;
    readonly weatherCode: boolean;
    readonly humidityPct: boolean;
    readonly isDay: boolean;
    readonly windSpeedKmh: boolean;
    readonly windDirectionDeg: boolean;
    readonly windGustsKmh: boolean;
    readonly cloudCoverPct: boolean;
    readonly pressureHpa: boolean;
    readonly apparentTemperatureC: boolean;
    readonly precipitationProbabilityPct: boolean;
    readonly visibilityM: boolean;
  };
  /** Dataset is older than its 15-minute refresh interval. */
  readonly stale: boolean;
  /** Requested time lies outside the dataset; values are not clamped to an edge hour. */
  readonly outOfCoverage: boolean;
}

/** Normalized 0..1 scene drivers, computed once per frame change. */
export interface WeatherDrivers {
  /** 0 = dry, 1 = downpour (saturates around 8 mm/h). */
  readonly rain: number;
  /** 0 = no snow, 1 = heavy snowfall (saturates around 2 cm/h). */
  readonly snow: number;
  /** 0 = calm, 1 = storm wind (saturates around 50 km/h). */
  readonly wind: number;
  /** 0 = no gusts, 1 = violent gusts (saturates around 80 km/h). */
  readonly gust: number;
  readonly cloud: number;
  /** 0 = cold (-15 °C mapped), 1 = hot (+35 °C mapped). */
  readonly warmth: number;
  /** 0 = low (985 hPa), 1 = high (1040 hPa). */
  readonly pressure: number;
  /** 0 = dry air, 1 = saturated. */
  readonly humidity: number;
  /** 0 = night, 1 = daylight; 0.5 when unknown. */
  readonly daylight: number;
  /** Thunderstorm codes (WMO 95..99). */
  readonly thunder: boolean;
  /** Fog codes (WMO 45/48) or near-saturated air. */
  readonly fog: boolean;
}

class Signal<T> {
  private readonly listeners = new Set<(value: T) => void>();

  private value: T;

  constructor(value: T) {
    this.value = value;
  }

  peek(): T {
    return this.value;
  }

  subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  set(next: T): void {
    if (next === this.value) return;
    this.value = next;
    for (const listener of [...this.listeners]) listener(next);
  }
}

export interface WeatherStoreState {
  readonly status: WeatherLoadStatus;
  readonly dataset: WeatherDataset | null;
  /** Hours from NOW; clamped to PLAYHEAD_MIN_H..PLAYHEAD_MAX_H. */
  readonly playheadHours: number;
  /** True while the playhead sits at 0 (live "now"). */
  readonly isLive: boolean;
}


const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const UNAVAILABLE = Number.NaN;
const isAvailable = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const interpolate = (a: number | null, b: number | null, t: number): number =>
  isAvailable(a) && isAvailable(b) ? lerp(a, b, t) : UNAVAILABLE;

const interpolateDirection = (a: number | null, b: number | null, t: number): number => {
  if (!isAvailable(a) || !isAvailable(b)) return UNAVAILABLE;
  const delta = ((b - a + 540) % 360) - 180;
  return ((a + delta * t) % 360 + 360) % 360;
};

/** values order: temperatureC, precipitationMm, snowfallCm, weatherCode,
 * humidityPct, isDay, windSpeedKmh, windDirectionDeg, windGustsKmh,
 * cloudCoverPct, pressureHpa, apparentTemperatureC,
 * precipitationProbabilityPct, visibilityM. */
type FrameValues = readonly [
  number, number, number, number, number, number, number,
  number, number, number, number, number, number, number,
];

const frameFromValues = (
  dataset: WeatherDataset,
  at: Date,
  values: FrameValues,
  outOfCoverage: boolean,
): WeatherFrame => ({
  time: at,
  temperatureC: values[0],
  precipitationMm: values[1],
  snowfallCm: values[2],
  weatherCode: values[3],
  humidityPct: values[4],
  isDay: values[5],
  windSpeedKmh: values[6],
  windDirectionDeg: values[7],
  windGustsKmh: values[8],
  cloudCoverPct: values[9],
  pressureHpa: values[10],
  apparentTemperatureC: values[11],
  precipitationProbabilityPct: values[12],
  visibilityM: values[13],
  available: {
    temperatureC: Number.isFinite(values[0]),
    precipitationMm: Number.isFinite(values[1]),
    snowfallCm: Number.isFinite(values[2]),
    weatherCode: Number.isFinite(values[3]),
    humidityPct: Number.isFinite(values[4]),
    isDay: Number.isFinite(values[5]),
    windSpeedKmh: Number.isFinite(values[6]),
    windDirectionDeg: Number.isFinite(values[7]),
    windGustsKmh: Number.isFinite(values[8]),
    cloudCoverPct: Number.isFinite(values[9]),
    pressureHpa: Number.isFinite(values[10]),
    apparentTemperatureC: Number.isFinite(values[11]),
    precipitationProbabilityPct: Number.isFinite(values[12]),
    visibilityM: Number.isFinite(values[13]),
  },
  stale: Date.now() - dataset.fetchedAt >= REFRESH_TTL_MS,
  outOfCoverage,
});

const ALL_UNAVAILABLE: FrameValues = [
  Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN,
  Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN,
  Number.NaN, Number.NaN, Number.NaN,
];

/** Categorical fields take the nearest hour instead of interpolating. */
const nearest = (a: number | null, b: number | null, t: number): number =>
  isAvailable(a) || isAvailable(b) ? ((t < 0.5 ? a : b) ?? UNAVAILABLE) : UNAVAILABLE;

/** Interpolate the hourly series at an arbitrary timestamp. */
export function frameAt(dataset: WeatherDataset, at: Date): WeatherFrame {
  const target = at.getTime();
  const { hours } = dataset;
  if (hours.length === 0) return frameFromValues(dataset, at, ALL_UNAVAILABLE, true);
  if (target < hours[0].time.getTime() || target > hours[hours.length - 1].time.getTime()) {
    return frameFromValues(dataset, at, ALL_UNAVAILABLE, true);
  }
  if (target === hours[0].time.getTime()) return frameFromHour(dataset, hours[0], at, false);
  const lastIndex = hours.length - 1;
  if (target === hours[lastIndex].time.getTime()) return frameFromHour(dataset, hours[lastIndex], at, false);

  let lo = 0;
  let hi = lastIndex;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (hours[mid].time.getTime() <= target) lo = mid;
    else hi = mid;
  }
  const a = hours[lo];
  const b = hours[hi];
  const span = b.time.getTime() - a.time.getTime();
  const t = span > 0 ? (target - a.time.getTime()) / span : 0;
  return frameFromValues(dataset, at, [
    interpolate(a.temperatureC, b.temperatureC, t),
    interpolate(a.precipitationMm, b.precipitationMm, t),
    interpolate(a.snowfallCm, b.snowfallCm, t),
    nearest(a.weatherCode, b.weatherCode, t),
    interpolate(a.humidityPct, b.humidityPct, t),
    nearest(a.isDay, b.isDay, t),
    interpolate(a.windSpeedKmh, b.windSpeedKmh, t),
    interpolateDirection(a.windDirectionDeg, b.windDirectionDeg, t),
    interpolate(a.windGustsKmh, b.windGustsKmh, t),
    interpolate(a.cloudCoverPct, b.cloudCoverPct, t),
    interpolate(a.pressureHpa, b.pressureHpa, t),
    interpolate(a.apparentTemperatureC, b.apparentTemperatureC, t),
    interpolate(a.precipitationProbabilityPct, b.precipitationProbabilityPct, t),
    interpolate(a.visibilityM, b.visibilityM, t),
  ], false);
}

function frameFromHour(dataset: WeatherDataset, hour: WeatherDataset['hours'][number], at: Date, outOfCoverage: boolean): WeatherFrame {
  return frameFromValues(dataset, at, [
    hour.temperatureC ?? UNAVAILABLE,
    hour.precipitationMm ?? UNAVAILABLE,
    hour.snowfallCm ?? UNAVAILABLE,
    hour.weatherCode ?? UNAVAILABLE,
    hour.humidityPct ?? UNAVAILABLE,
    hour.isDay ?? UNAVAILABLE,
    hour.windSpeedKmh ?? UNAVAILABLE,
    hour.windDirectionDeg ?? UNAVAILABLE,
    hour.windGustsKmh ?? UNAVAILABLE,
    hour.cloudCoverPct ?? UNAVAILABLE,
    hour.pressureHpa ?? UNAVAILABLE,
    hour.apparentTemperatureC ?? UNAVAILABLE,
    hour.precipitationProbabilityPct ?? UNAVAILABLE,
    hour.visibilityM ?? UNAVAILABLE,
  ], outOfCoverage);
}

/** Neutral fallbacks mirror the visual systems' `??` defaults. */
export function driversFromFrame(frame: WeatherFrame): WeatherDrivers {
  const rain = frame.available.precipitationMm ? Math.min(1, frame.precipitationMm / 8) : 0;
  const snow = frame.available.snowfallCm ? Math.min(1, frame.snowfallCm / 2) : 0;
  const wind = frame.available.windSpeedKmh ? Math.min(1, frame.windSpeedKmh / 50) : 0;
  const gust = frame.available.windGustsKmh ? Math.min(1, frame.windGustsKmh / 80) : 0;
  const cloud = frame.available.cloudCoverPct ? Math.min(1, Math.max(0, frame.cloudCoverPct / 100)) : 0.3;
  const thermal = frame.available.apparentTemperatureC ? frame.apparentTemperatureC : frame.temperatureC;
  const warmth = Number.isFinite(thermal) ? Math.min(1, Math.max(0, (thermal + 15) / 50)) : 0.5;
  const pressure = frame.available.pressureHpa ? Math.min(1, Math.max(0, (frame.pressureHpa - 985) / 55)) : 0.5;
  const humidity = frame.available.humidityPct ? Math.min(1, Math.max(0, frame.humidityPct / 100)) : 0.5;
  const daylight = frame.available.isDay ? frame.isDay : 0.5;
  const code = frame.available.weatherCode ? frame.weatherCode : 0;
  const lowVisibility = frame.available.visibilityM && frame.visibilityM <= 1200;
  return {
    rain, snow, wind, gust, cloud, warmth, pressure, humidity, daylight,
    thunder: code >= 95,
    fog: code === 45 || code === 48 || lowVisibility || humidity >= 0.97,
  };
}

/** Timestamp the playhead currently points at. */
export function playheadTime(dataset: WeatherDataset, playheadHours: number, now: Date): Date {
  return new Date(now.getTime() + playheadHours * 3_600_000);
}

class WeatherStore {
  private cachedDataset: WeatherDataset | null = null;
  private cachedPlayheadHours = Number.NaN;
  private cachedMinute = Number.NaN;
  private cachedCurrent: { frame: WeatherFrame; drivers: WeatherDrivers } | null = null;

  readonly state = new Signal<WeatherStoreState>({
    status: { kind: 'idle' },
    dataset: null,
    playheadHours: 0,
    isLive: true,
  });
  setStatus(status: WeatherLoadStatus): void {
    const prev = this.state.peek();
    this.state.set({ ...prev, status });
  }

  setDataset(dataset: WeatherDataset): void {
    const prev = this.state.peek();
    this.state.set({ ...prev, dataset, status: { kind: 'ready' } });
  }

  setPlayhead(hours: number): void {
    const playheadHours = Math.min(PLAYHEAD_MAX_H, Math.max(PLAYHEAD_MIN_H, hours));
    const prev = this.state.peek();
    if (prev.playheadHours === playheadHours) return;
    this.state.set({ ...prev, playheadHours, isLive: playheadHours === 0 });
  }

  /** Jump back to NOW (used by the timeline's reset affordance). */
  goLive(): void {
    this.setPlayhead(0);
  }

  /** Current frame + drivers; same cached object is returned within a minute. */
  current(now?: Date): { frame: WeatherFrame; drivers: WeatherDrivers } | null {
    const { dataset, playheadHours } = this.state.peek();
    if (dataset == null) return null;
    const minute = Math.floor((now?.getTime() ?? Date.now()) / 60_000);
    if (
      dataset === this.cachedDataset &&
      playheadHours === this.cachedPlayheadHours &&
      minute === this.cachedMinute &&
      this.cachedCurrent != null
    ) return this.cachedCurrent;

    const at = new Date(minute * 60_000 + playheadHours * 3_600_000);
    const frame = frameAt(dataset, at);
    this.cachedDataset = dataset;
    this.cachedPlayheadHours = playheadHours;
    this.cachedMinute = minute;
    this.cachedCurrent = { frame, drivers: driversFromFrame(frame) };
    return this.cachedCurrent;
  }
}

/** App-wide singleton; the only shared mutable weather state. */
export const weatherStore = new WeatherStore();
