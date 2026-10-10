/**
 * Framework-neutral weather data layer for WEATHER//ROOM.
 *
 * Loads ~now-24h through ~now+24h through an ordered no-key provider chain
 * (Open-Meteo -> MET Norway -> wttr.in, see providers.ts), normalizes the
 * hourly series, and falls back to a manual, IP-based, or fixed location
 * plus a synthetic demo scenario when every provider is unreachable.
 * Open-Meteo leads as the reference source; on networks where it is blocked
 * (measured: the Quest headset network times it out) the chain falls
 * through to MET Norway automatically.
 * No IWSDK/three imports: pure browser + fetch + geolocation.
 */

import {
  PROVIDER_DISPLAY,
  PROVIDER_ORDER,
  fetchMetNorway,
  fetchWttr,
  getCachedIpLocation,
  refreshIpLocationCache,
} from './providers.js';

export interface WeatherHour {
  /** Hour start, UTC-based Date. */
  readonly time: Date;
  readonly temperatureC: number | null;
  /** Precipitation mm per hour (rain equivalent). */
  readonly precipitationMm: number | null;
  readonly windSpeedKmh: number | null;
  /** Meteorological wind direction, degrees (from = direction wind comes from). */
  readonly windDirectionDeg: number | null;
  readonly cloudCoverPct: number | null;
  readonly pressureHpa: number | null;
  readonly apparentTemperatureC: number | null;
  readonly precipitationProbabilityPct: number | null;
  readonly visibilityM: number | null;
  /** Snowfall cm per hour. */
  readonly snowfallCm: number | null;
  /** WMO weather interpretation code (0 clear .. 95+ thunderstorm). */
  readonly weatherCode: number | null;
  /** Relative humidity %. */
  readonly humidityPct: number | null;
  /** 1 = daylight hour, 0 = night. */
  readonly isDay: number | null;
  /** Wind gusts km/h. */
  readonly windGustsKmh: number | null;
}

export type WeatherSource =
  | 'met-no'
  | 'met-no-manual-location'
  | 'met-no-ip-location'
  | 'met-no-fallback-location'
  | 'open-meteo'
  | 'open-meteo-manual-location'
  | 'open-meteo-ip-location'
  | 'open-meteo-fallback-location'
  | 'wttr'
  | 'wttr-manual-location'
  | 'wttr-ip-location'
  | 'wttr-fallback-location'
  | 'demo';

export interface WeatherDataset {
  readonly source: WeatherSource;
  /** Human-readable location or scenario label. */
  readonly label: string;
  readonly fetchedAt: number;
  readonly latitude: number;
  readonly longitude: number;
  /**
   * Honest provenance of the coordinates. Sibling panels render the location
   * line from this instead of re-parsing the `source` suffix string.
   */
  readonly locationOrigin: LocationOrigin;
  /** Device-fix accuracy in metres when `locationOrigin` is `device`. */
  readonly locationAccuracyM?: number;
  /**
   * GeolocationPositionError code behind a silent device→IP/fixed swap
   * (1 denied, 2 unavailable, 3 timeout); absent when the device answered.
   */
  readonly locationErrorCode?: number;
  /** Hourly entries; guaranteed ordered, ideally covering now-24h .. now+24h. */
  readonly hours: readonly WeatherHour[];
}

export type WeatherLoadStatus =
  | { kind: 'idle' }
  | { kind: 'locating' }
  | { kind: 'loading'; label: string }
  | { kind: 'ready' }
  | { kind: 'demo'; reason: string };

/** Fallback location used when geolocation permission is denied/unavailable. */
export const FALLBACK_LOCATION = {
  label: 'Moscow (fallback)',
  latitude: 55.7558,
  longitude: 37.6173,
} as const;

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
/** Refetch at most this often; timeline scrubbing never refetches. Exported so UI layers can honor the same TTL. */
export const REFRESH_TTL_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const GEOLOCATION_TIMEOUT_MS = 8_000;
/**
 * Bounded wait while the browser's own permission prompt is open: the answer
 * (and the Wi-Fi fix behind it) must arrive before we fall back to IP.
 */
const GEOLOCATION_PROMPT_TIMEOUT_MS = 25_000;

const HOURLY_FIELDS = [
  'temperature_2m',
  'apparent_temperature',
  'precipitation',
  'precipitation_probability',
  'snowfall',
  'weather_code',
  'relative_humidity_2m',
  'is_day',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'cloud_cover',
  'surface_pressure',
  'visibility',
];

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

interface OpenMeteoHourly {
  time: unknown[];
  temperature_2m?: unknown[];
  apparent_temperature?: unknown[];
  precipitation?: unknown[];
  precipitation_probability?: unknown[];
  snowfall?: unknown[];
  weather_code?: unknown[];
  relative_humidity_2m?: unknown[];
  is_day?: unknown[];
  wind_speed_10m?: unknown[];
  wind_direction_10m?: unknown[];
  wind_gusts_10m?: unknown[];
  cloud_cover?: unknown[];
  surface_pressure?: unknown[];
  visibility?: unknown[];
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Open-Meteo HTTP ${response.status}`);
    }
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function parseOpenMeteo(payload: unknown, _latitude: number, _longitude: number): WeatherHour[] {
  const hourly = (payload as { hourly?: OpenMeteoHourly } | null)?.hourly;
  if (hourly == null || !Array.isArray(hourly.time)) {
    throw new Error('Open-Meteo payload has no hourly.time');
  }
  const hours: WeatherHour[] = [];
  for (let i = 0; i < hourly.time.length; i += 1) {
    const rawTime = hourly.time[i];
    // Open-Meteo timeformat=unixtime is seconds since epoch. String timestamps,
    // if encountered, are explicitly treated as UTC rather than local time.
    const time = typeof rawTime === 'number'
      ? new Date(rawTime * 1000)
      : new Date(typeof rawTime === 'string' && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(rawTime)
        ? `${rawTime}Z`
        : String(rawTime));
    if (!Number.isFinite(time.getTime())) continue;
    const temperatureC = num(hourly.temperature_2m?.[i]);
    const apparentTemperatureC = num(hourly.apparent_temperature?.[i]);
    const precipitationMm = num(hourly.precipitation?.[i]);
    const precipitationProbabilityPct = num(hourly.precipitation_probability?.[i]);
    const visibilityM = num(hourly.visibility?.[i]);
    const snowfallCm = num(hourly.snowfall?.[i]);
    const weatherCode = num(hourly.weather_code?.[i]);
    const humidityPct = num(hourly.relative_humidity_2m?.[i]);
    const isDay = num(hourly.is_day?.[i]);
    const windSpeedKmh = num(hourly.wind_speed_10m?.[i]);
    const windDirectionDeg = num(hourly.wind_direction_10m?.[i]);
    const windGustsKmh = num(hourly.wind_gusts_10m?.[i]);
    const cloudCoverPct = num(hourly.cloud_cover?.[i]);
    const pressureHpa = num(hourly.surface_pressure?.[i]);
    if (
      temperatureC == null && apparentTemperatureC == null &&
      precipitationMm == null && precipitationProbabilityPct == null &&
      visibilityM == null && snowfallCm == null && weatherCode == null &&
      humidityPct == null && isDay == null && windSpeedKmh == null &&
      windDirectionDeg == null && windGustsKmh == null &&
      cloudCoverPct == null && pressureHpa == null
    ) continue;
    hours.push({
      time,
      temperatureC,
      apparentTemperatureC,
      precipitationMm,
      precipitationProbabilityPct,
      visibilityM,
      snowfallCm,
      weatherCode,
      humidityPct,
      isDay,
      windSpeedKmh,
      windDirectionDeg,
      windGustsKmh,
      cloudCoverPct,
      pressureHpa,
    });
  }
  hours.sort((a, b) => a.time.getTime() - b.time.getTime());
  if (hours.length === 0) {
    throw new Error('Open-Meteo returned no hours with valid weather values');
  }
  return hours;
}

/**
 * Deterministic synthetic scenario: a full weather arc over 72h so the
 * -24h..+24h timeline stays meaningful offline. Clearly labeled as demo.
 */
export function buildDemoDataset(now = new Date()): WeatherDataset {
  const t0 = Math.floor(now.getTime() / 3_600_000) * 3_600_000;
  const hours: WeatherHour[] = [];
  for (let i = -36; i <= 36; i += 1) {
    const time = new Date(t0 + i * 3_600_000);
    const phase = (i + 36) / 72; // 0..1 across the arc
    const dayWave = Math.sin((time.getUTCHours() - 6) / 24 * Math.PI * 2);
    // Precipitation: dry -> steady rain -> dry again.
    const rainHump = Math.max(0, 1 - Math.abs(phase - 0.5) * 6);
    hours.push({
      time,
      temperatureC: 9 + 8 * Math.sin(phase * Math.PI) + 3 * dayWave,
      apparentTemperatureC: 7 + 8 * Math.sin(phase * Math.PI) + 2 * dayWave,
      precipitationProbabilityPct: Math.round(rainHump * 92),
      visibilityM: Math.max(350, 24_000 - rainHump * 18_000),
      precipitationMm: Number((4.2 * rainHump).toFixed(2)),
      snowfallCm: phase > 0.72 ? Number((0.5 * (phase - 0.72) * 10).toFixed(2)) : 0,
      weatherCode: phase > 0.5 && phase <= 0.58 ? 95 : rainHump > 0.25 ? 63 : phase > 0.8 ? 71 : 3,
      humidityPct: Math.round(55 + 35 * rainHump),
      isDay: time.getUTCHours() >= 6 && time.getUTCHours() < 20 ? 1 : 0,
      windSpeedKmh: 6 + 22 * Math.abs(Math.sin(phase * Math.PI * 1.5)),
      windDirectionDeg: Math.round((200 + 120 * phase) % 360),
      windGustsKmh: Math.round(12 + 40 * Math.abs(Math.sin(phase * Math.PI * 1.5))),
      cloudCoverPct: Math.round(Math.min(100, 25 + 70 * rainHump + 20 * Math.sin(phase * 9))),
      pressureHpa: Math.round((1006 + 14 * Math.cos(phase * Math.PI * 2)) * 10) / 10,
    });
  }
  return {
    source: 'demo',
    label: 'DEMO synthetic scenario',
    fetchedAt: Date.now(),
    latitude: FALLBACK_LOCATION.latitude,
    longitude: FALLBACK_LOCATION.longitude,
    locationOrigin: 'fallback',
    hours,
  };
}

export type LocationOrigin = 'device' | 'manual' | 'ip' | 'fallback';

export interface GeolocationResult {
  latitude: number;
  longitude: number;
  label: string;
  origin: LocationOrigin;
  /** Kept for the previous `fallback: boolean` contract. */
  fallback: boolean;
  fallbackReason?: string;
  /** IANA-offset minutes east of UTC, from IP lookup when known. */
  utcOffsetMin?: number;
  /** Device-fix accuracy in metres (device origin only). */
  accuracyM?: number;
  /** GeolocationPositionError code behind a silent fallback: 1 denied, 2 unavailable, 3 timeout. */
  errorCode?: number;
}

/** City presets offered to the manual-location picker (owned by the panels). */
export interface LocationPreset {
  readonly id: string;
  readonly label: string;
  readonly latitude: number;
  readonly longitude: number;
}

export const LOCATION_PRESETS: readonly LocationPreset[] = [
  { id: 'moscow', label: 'Moscow', latitude: 55.7558, longitude: 37.6173 },
  { id: 'saint-petersburg', label: 'Saint Petersburg', latitude: 59.9343, longitude: 30.3351 },
  { id: 'london', label: 'London', latitude: 51.5074, longitude: -0.1278 },
  { id: 'berlin', label: 'Berlin', latitude: 52.52, longitude: 13.405 },
  { id: 'new-york', label: 'New York', latitude: 40.7128, longitude: -74.006 },
  { id: 'tokyo', label: 'Tokyo', latitude: 35.6762, longitude: 139.6503 },
];

const MANUAL_LOCATION_KEY = 'weather-room:manual-location';

export interface ManualLocation {
  readonly latitude: number;
  readonly longitude: number;
  readonly label: string;
}

const validCoords = (latitude: unknown, longitude: unknown): boolean =>
  typeof latitude === 'number' &&
  typeof longitude === 'number' &&
  Number.isFinite(latitude) &&
  Number.isFinite(longitude) &&
  Math.abs(latitude) <= 90 &&
  Math.abs(longitude) <= 180;

/** Persisted manual override; null when the user never set one. */
export function getManualLocation(): ManualLocation | null {
  try {
    const raw = localStorage.getItem(MANUAL_LOCATION_KEY);
    if (raw == null) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<ManualLocation>;
    if (!validCoords(parsed.latitude, parsed.longitude)) {
      return null;
    }
    return {
      latitude: parsed.latitude as number,
      longitude: parsed.longitude as number,
      label: typeof parsed.label === 'string' && parsed.label.trim() !== ''
        ? parsed.label
        : `${(parsed.latitude as number).toFixed(2)}°, ${(parsed.longitude as number).toFixed(2)}°`,
    };
  } catch {
    return null;
  }
}

/**
 * Persist a manual location override. Pass null to clear it. Throws on
 * out-of-range coordinates so the picker can report the mistake.
 */
export function setManualLocation(location: ManualLocation | null): void {
  if (location == null) {
    try {
      localStorage.removeItem(MANUAL_LOCATION_KEY);
    } catch {
      // Private mode: clearing is best-effort.
    }
    return;
  }
  if (!validCoords(location.latitude, location.longitude)) {
    throw new Error(`Invalid coordinates ${location.latitude}, ${location.longitude}`);
  }
  const label = location.label.trim() === ''
    ? `${location.latitude.toFixed(2)}°, ${location.longitude.toFixed(2)}°`
    : location.label;
  try {
    localStorage.setItem(
      MANUAL_LOCATION_KEY,
      JSON.stringify({ latitude: location.latitude, longitude: location.longitude, label }),
    );
  } catch {
    // Private mode: the override applies to this load only.
  }
}

/** Parse a "lat,lon" text field into coordinates; null when not parseable. */
export function parseLatLon(text: string): { latitude: number; longitude: number } | null {
  const parts = text.split(/[;,\s]+/).filter((part) => part !== '');
  if (parts.length !== 2) {
    return null;
  }
  const latitude = Number(parts[0]);
  const longitude = Number(parts[1]);
  return validCoords(latitude, longitude) ? { latitude, longitude } : null;
}

/** One Open-Meteo request covering at least now-24h .. now+24h. */
async function fetchOpenMeteo(latitude: number, longitude: number): Promise<WeatherHour[]> {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    hourly: HOURLY_FIELDS.join(','),
    past_days: '2',
    forecast_days: '3',
    wind_speed_unit: 'kmh',
    timeformat: 'unixtime',
    timezone: 'UTC',
  });
  const payload = await fetchJson(`${OPEN_METEO_URL}?${params.toString()}`);
  return parseOpenMeteo(payload, latitude, longitude);
}

export interface WeatherFetchOutcome {
  dataset: WeatherDataset;
  status: WeatherLoadStatus;
}

const withOrigin = (
  latitude: number,
  longitude: number,
  label: string,
  origin: LocationOrigin,
  fallbackReason?: string,
  utcOffsetMin?: number,
  accuracyM?: number,
  errorCode?: number,
): GeolocationResult => ({
  latitude,
  longitude,
  label,
  origin,
  fallback: origin !== 'device',
  fallbackReason,
  utcOffsetMin,
  accuracyM,
  errorCode,
});

/** Provenance encoded in a `WeatherSource` string (`...-ip-location` → `ip`). */
export function originOfSource(source: WeatherSource): LocationOrigin {
  if (source === 'demo' || source.endsWith('-fallback-location')) return 'fallback';
  if (source.endsWith('-ip-location')) return 'ip';
  if (source.endsWith('-manual-location')) return 'manual';
  return 'device';
}

export type GeolocationPermission = 'granted' | 'denied' | 'prompt' | 'unsupported';

/**
 * Location behaviour by platform (the chain never blocks a load):
 * - Quest 3 / Android WebXR: no GPS hardware, so the fix is a coarse Wi-Fi
 *   estimate or POSITION_UNAVAILABLE. An immersive session cannot show a
 *   permission prompt, so the prompt is only raised by the panel's "Locate me"
 *   click (a real user gesture) while not presenting.
 * - iPhone/iPad WebAR: Safari exposes geolocation but requires HTTPS and shows
 *   its own prompt; a denied prompt arrives as code 1 and is stated plainly.
 * - Desktop: permission is granted once and the Permissions API is available,
 *   so the panel precheck and its onchange re-run the chain after a grant.
 * In every case the honest origin (device / manual / ip / fixed) travels on the
 * dataset and is rendered by the panel; IP and fixed never look like a device.
 */

/**
 * Permissions API precheck. Quest Browser and Safari may omit the API or throw
 * for the `geolocation` name, so every access is guarded and the unknown state
 * is reported honestly as `unsupported` (the caller then just attempts a fix).
 */
export async function geolocationPermissionState(): Promise<GeolocationPermission> {
  try {
    const permissions = navigator.permissions;
    if (permissions?.query == null) return 'unsupported';
    const status = await permissions.query({ name: 'geolocation' });
    const state = status.state;
    return state === 'granted' || state === 'denied' || state === 'prompt' ? state : 'unsupported';
  } catch {
    return 'unsupported';
  }
}

/**
 * Subscribe to live geolocation-permission changes (`PermissionStatus.onchange`)
 * so a grant made in the browser UI re-runs the location chain without a reload.
 * Returns an unsubscribe; a no-op when the Permissions API is unavailable.
 */
export function watchGeolocationPermission(
  listener: (state: GeolocationPermission) => void,
): () => void {
  const permissions = navigator.permissions;
  if (permissions?.query == null) return () => {};
  let disposed = false;
  let status: PermissionStatus | null = null;
  const onChange = (): void => {
    if (!disposed && status != null) listener(status.state as GeolocationPermission);
  };
  void permissions
    .query({ name: 'geolocation' })
    .then((next) => {
      if (disposed) {
        return;
      }
      status = next;
      status.addEventListener('change', onChange);
    })
    .catch(() => undefined);
  return () => {
    disposed = true;
    status?.removeEventListener('change', onChange);
    status = null;
  };
}

/** Human reason for a silent device→IP/fixed substitution, keyed by error code. */
const DEVICE_ERROR_REASON: Record<number, string> = {
  1: 'device location permission denied',
  2: 'device location unavailable',
  3: 'device location request timed out',
};

const DEVICE_LOCATION_KEY = 'weather-room:device-location';

/** A device fix is only reused while the permission stays granted. */
function cachedDeviceResult(permission: GeolocationPermission): GeolocationResult | null {
  if (permission !== 'granted') return null;
  try {
    const raw = localStorage.getItem(DEVICE_LOCATION_KEY);
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as Partial<GeolocationResult>;
    if (!validCoords(parsed.latitude, parsed.longitude)) return null;
    return withOrigin(
      parsed.latitude as number,
      parsed.longitude as number,
      typeof parsed.label === 'string' && parsed.label !== ''
        ? parsed.label
        : `${(parsed.latitude as number).toFixed(2)}°, ${(parsed.longitude as number).toFixed(2)}°`,
      'device',
      undefined,
      undefined,
      typeof parsed.accuracyM === 'number' ? parsed.accuracyM : undefined,
    );
  } catch {
    return null;
  }
}

/** Remember a device fix so later 2D entries do not re-ask (Quest Wi-Fi is slow). */
function rememberDeviceLocation(result: GeolocationResult): void {
  try {
    localStorage.setItem(
      DEVICE_LOCATION_KEY,
      JSON.stringify({
        latitude: result.latitude,
        longitude: result.longitude,
        label: result.label,
        accuracyM: result.accuracyM,
      }),
    );
  } catch {
    // Private mode: the fix simply is not reused across loads.
  }
}

/** Drop the remembered fix; called when the permission state changes. */
export function forgetDeviceLocation(): void {
  try {
    localStorage.removeItem(DEVICE_LOCATION_KEY);
  } catch {
    // Best effort, same as remembering.
  }
}

const cachedIpResult = (errorCode?: number): GeolocationResult | null => {
  // Cached IP coords (best-effort, labeled as such) beat the fixed point; a
  // refresh for the NEXT load starts only after device resolution finished.
  const cached = getCachedIpLocation();
  if (cached == null) return null;
  const place = cached.place === '' ? 'IP-based location' : `IP-based location (${cached.place})`;
  return withOrigin(
    cached.latitude,
    cached.longitude,
    place,
    'ip',
    DEVICE_ERROR_REASON[errorCode ?? 0] ?? 'device location unavailable',
    cached.utcOffsetMin,
    undefined,
    errorCode,
  );
};

const fixedResult = (errorCode?: number): GeolocationResult => ({
  ...FALLBACK_LOCATION,
  origin: 'fallback',
  fallback: true,
  fallbackReason: DEVICE_ERROR_REASON[errorCode ?? 0] ?? 'device location unavailable',
  errorCode,
});

/** Browser geolocation with a bounded wait; rejects nowhere, reports origin.
 * Hand-rolled resolve (not Promise.withResolvers): Quest Browser builds on
 * Chromium < 119 lack that ES2024 API and the loader must not crash on boot.
 * Device first: on the 2D surface a 'prompt' permission is answered by the
 * browser's own dialog (Quest returns a Wi-Fi fix), and IP is only consulted
 * after the device refuses or is unavailable. */
export async function resolveLocation(): Promise<GeolocationResult> {
  // A stored manual override wins before geolocation is even attempted: on
  // networks where device location always times out (Quest), the user picks
  // once and every load uses it. Labeled honestly — never as device.
  const manual = getManualLocation();
  if (manual != null) {
    return withOrigin(manual.latitude, manual.longitude, manual.label, 'manual');
  }
  const permission = await geolocationPermissionState();
  // Reuse an earlier granted fix instead of asking again on every entry.
  const remembered = cachedDeviceResult(permission);
  if (remembered != null) return remembered;
  // A denial is honest and instant: no pointless wait that can never succeed.
  if (permission === 'denied') {
    return cachedIpResult(1) ?? fixedResult(1);
  }
  // 'prompt' means the browser will show its own dialog, so give it time to be
  // answered; an unknown state falls back to the plain bounded wait.
  const waitMs = permission === 'prompt' ? GEOLOCATION_PROMPT_TIMEOUT_MS : GEOLOCATION_TIMEOUT_MS;
  let resolve!: (result: GeolocationResult) => void;
  const promise = new Promise<GeolocationResult>((res) => {
    resolve = res;
  });
  const geolocation = navigator.geolocation;
  if (geolocation == null) {
    // No geolocation API: report it as "position unavailable" so the silent
    // fallback is stated instead of looking like a device reading.
    resolve(cachedIpResult(2) ?? fixedResult(2));
    return promise;
  }
  // Safety net: some engines never invoke either callback (Quest Browser).
  const safety = setTimeout(() => settle(cachedIpResult(3) ?? fixedResult(3)), waitMs + 2_000);
  let settled = false;
  const settle = (result: GeolocationResult): void => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(safety);
    resolve(result);
  };
  geolocation.getCurrentPosition(
    (position) => {
      const { latitude, longitude, accuracy } = position.coords;
      const fix = withOrigin(
        latitude,
        longitude,
        `${latitude.toFixed(2)}°, ${longitude.toFixed(2)}°`,
        'device',
        undefined,
        undefined,
        Number.isFinite(accuracy) ? accuracy : undefined,
      );
      rememberDeviceLocation(fix);
      settle(fix);
    },
    (error) => {
      // Keep the browser's code (1 denied / 2 unavailable / 3 timeout) so the
      // UI can distinguish the three cases instead of one generic message.
      settle(cachedIpResult(error.code) ?? fixedResult(error.code));
    },
    { timeout: waitMs, maximumAge: 5 * 60 * 1000 },
  );
  return promise;
}

export interface DeviceLocateOutcome {
  readonly ok: boolean;
  /** Present when a fix was obtained. */
  readonly location?: GeolocationResult;
  /** GeolocationPositionError code: 1 denied, 2 unavailable, 3 timeout, 0 none. */
  readonly errorCode?: number;
  /** Best accuracy in metres seen before the escalation ended. */
  readonly accuracyM?: number;
}

/**
 * Explicit, user-gesture device locate: `watchPosition` with
 * `enableHighAccuracy` keeps the best fix, ends early on a good enough
 * accuracy, and always `clearWatch`es on the bounded timeout. The error code
 * is preserved so the caller can be honest (denied / unavailable / timeout).
 */
export function requestDeviceLocation(
  options: { enableHighAccuracy?: boolean; timeoutMs?: number } = {},
): Promise<DeviceLocateOutcome> {
  const enableHighAccuracy = options.enableHighAccuracy ?? true;
  const timeoutMs = options.timeoutMs ?? 12_000;
  const geolocation = navigator.geolocation;
  if (geolocation == null) {
    return Promise.resolve({ ok: false, errorCode: 0 });
  }
  return new Promise<DeviceLocateOutcome>((resolve) => {
    let best: GeolocationResult | null = null;
    let bestAccuracy = Number.POSITIVE_INFINITY;
    let settled = false;
    let watchId: number | null = null;
    let rescueTimer: number | undefined;
    const finish = (outcome: DeviceLocateOutcome): void => {
      if (settled) return;
      settled = true;
      if (watchId != null) {
        try {
          geolocation.clearWatch(watchId);
        } catch {
          // clearWatch on an already-retired watch: nothing to do.
        }
      }
      clearTimeout(timer);
      clearTimeout(rescueTimer);
      if (outcome.ok && outcome.location != null) rememberDeviceLocation(outcome.location);
      resolve(outcome);
    };
    const timer = setTimeout(
      () =>
        finish(
          best != null
            ? { ok: true, location: best, accuracyM: Number.isFinite(bestAccuracy) ? bestAccuracy : undefined }
            : { ok: false, errorCode: 3 },
        ),
      timeoutMs,
    );
    const noteFix = (position: GeolocationPosition): void => {
      const { latitude, longitude, accuracy } = position.coords;
      const accuracyM = Number.isFinite(accuracy) ? accuracy : undefined;
      // Keep the most accurate fix, not merely the latest one.
      if (accuracyM != null && accuracyM > bestAccuracy) return;
      best = withOrigin(
        latitude,
        longitude,
        `${latitude.toFixed(2)}°, ${longitude.toFixed(2)}°`,
        'device',
        undefined,
        undefined,
        accuracyM,
      );
      if (accuracyM != null) bestAccuracy = accuracyM;
      // A good enough fix ends the escalation early (street level).
      if (accuracyM != null && accuracyM <= 50) finish({ ok: true, location: best, accuracyM });
    };
    try {
      watchId = geolocation.watchPosition(noteFix, (error) => finish({ ok: false, errorCode: error.code }), {
        enableHighAccuracy,
        timeout: timeoutMs,
        maximumAge: 0,
      });
    } catch {
      finish({ ok: false, errorCode: 0 });
      return;
    }
    // Rescue: some engines starve a fresh watch while another geolocation
    // request is still pending (the load-time getCurrentPosition), and Quest
    // Browser sometimes never calls either callback. One plain one-shot
    // attempt after a short grace keeps the gesture honest without giving up
    // the high-accuracy escalation.
    rescueTimer = setTimeout(() => {
      if (settled || best != null) return;
      try {
        geolocation.getCurrentPosition(noteFix, () => undefined, {
          timeout: Math.max(2000, timeoutMs - 4000),
          maximumAge: 30_000,
        });
      } catch {
        // The watch stays armed; the overall timer still bounds the wait.
      }
    }, 3500);
  });
}

const sourceFor = (provider: (typeof PROVIDER_ORDER)[number], origin: LocationOrigin): WeatherSource => {
  if (origin === 'device') {
    return provider;
  }
  return `${provider}-${origin === 'manual' ? 'manual' : origin === 'ip' ? 'ip' : 'fallback'}-location` as WeatherSource;
};

export interface LoadWeatherOptions {
  /** Skip the TTL reuse entirely (explicit reload, freshly granted permission). */
  force?: boolean;
  /** Pre-resolved location, e.g. a device fix from the "locate me" gesture. */
  location?: GeolocationResult;
}

/**
 * Loads weather with the full fallback chain:
 * device geolocation (else manual override, else cached IP, else fixed) ->
 * Open-Meteo -> MET Norway -> wttr.in -> synthetic demo.
 * `previous` enables a TTL check so refresh actions do not hammer the API.
 */
export async function loadWeather(
  previous?: WeatherDataset,
  options?: LoadWeatherOptions,
): Promise<WeatherFetchOutcome> {
  const reusable =
    previous != null && previous.source !== 'demo' && Date.now() - previous.fetchedAt < REFRESH_TTL_MS;
  // A dataset that silently fell back to IP/fixed must not lock out a device
  // fix for the whole TTL once the user actually grants permission.
  const previousOrigin = previous == null ? null : originOfSource(previous.source);
  const permissionGranted =
    reusable &&
    !options?.force &&
    previousOrigin !== 'device' &&
    previousOrigin !== 'manual' &&
    getManualLocation() == null &&
    (await geolocationPermissionState()) === 'granted';
  if (reusable && !options?.force && !permissionGranted) {
    return { dataset: previous as WeatherDataset, status: { kind: 'ready' } };
  }

  let location: GeolocationResult;
  if (options?.location != null) {
    location = options.location;
  } else {
    try {
      location = await resolveLocation();
    } catch {
      // Legacy engines (Quest Browser < Chromium 119) lack ES2024 APIs used
      // above; degrade to the fixed location instead of rejecting the chain.
      location = withOrigin(
        FALLBACK_LOCATION.latitude,
        FALLBACK_LOCATION.longitude,
        FALLBACK_LOCATION.label,
        'fallback',
        'location unavailable on this browser',
      );
    }
  }

  // Best-effort IP refresh for the NEXT load, started strictly AFTER the
  // device/manual attempt so a same-load cache write can never outrank the
  // device fix. Skipped when the device or a manual override already answered.
  if (location.origin !== 'device' && location.origin !== 'manual') {
    void refreshIpLocationCache();
  }

  const providerFailures: string[] = [];
  for (const provider of PROVIDER_ORDER) {
    try {
      const hours = provider === 'open-meteo'
        ? await fetchOpenMeteo(location.latitude, location.longitude)
        : provider === 'met-no'
          ? await fetchMetNorway(location.latitude, location.longitude)
          : await fetchWttr(location.latitude, location.longitude, location.utcOffsetMin);
      // The ip branch already reads "IP-based location (…)" from
      // resolveLocation; repeating the qualifier here is redundant.
      const place = location.origin === 'manual'
        ? `${location.label} (manual location)`
        : location.origin === 'ip'
          ? location.label
          : location.origin === 'fallback'
            ? `${location.label} (${location.fallbackReason ?? 'fallback location'})`
            : location.label;
      return {
        dataset: {
          source: sourceFor(provider, location.origin),
          // Provider first: sibling panels hardcode their status line, so the
          // location line they render verbatim is the only honest source tag.
          label: `${PROVIDER_DISPLAY[provider]} · ${place}`,
          fetchedAt: Date.now(),
          latitude: location.latitude,
          longitude: location.longitude,
          locationOrigin: location.origin,
          locationAccuracyM: location.accuracyM,
          locationErrorCode: location.errorCode,
          hours,
        },
        status: { kind: 'ready' },
      };
    } catch (error) {
      // AbortError reads as "signal is aborted without reason" — say it plainly.
      const detail =
        error instanceof DOMException && error.name === 'AbortError'
          ? 'weather service timed out'
          : error instanceof Error
            ? error.message
            : String(error);
      providerFailures.push(`${PROVIDER_DISPLAY[provider]}: ${detail}`);
    }
  }
  return {
    dataset: {
      ...buildDemoDataset(),
      label: `DEMO - ${location.label}`,
      locationOrigin: location.origin,
      locationAccuracyM: location.accuracyM,
      locationErrorCode: location.errorCode,
    },
    status: { kind: 'demo', reason: `all providers failed (${providerFailures.join('; ')})` },
  };
}
