/**
 * Framework-neutral weather data layer for WEATHER//ROOM.
 *
 * Fetches ~24h before NOW through ~24h after NOW from Open-Meteo in one
 * request, normalizes the hourly series, and provides a clearly-labeled
 * fallback location plus a synthetic demo scenario when the network is
 * unavailable. No IWSDK/three imports: pure browser + fetch + geolocation.
 */

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

export type WeatherSource = 'open-meteo' | 'open-meteo-fallback-location' | 'demo';

export interface WeatherDataset {
  readonly source: WeatherSource;
  /** Human-readable location or scenario label. */
  readonly label: string;
  readonly fetchedAt: number;
  readonly latitude: number;
  readonly longitude: number;
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
    hours,
  };
}

export interface GeolocationResult {
  latitude: number;
  longitude: number;
  label: string;
  fallback: boolean;
  fallbackReason?: string;
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

/** Browser geolocation with a bounded wait; falls back to a fixed location.
 * Hand-rolled resolve (not Promise.withResolvers): Quest Browser builds on
 * Chromium < 119 lack that ES2024 API and the loader must not crash on boot. */
export function resolveLocation(): Promise<GeolocationResult> {
  let resolve!: (result: GeolocationResult) => void;
  const promise = new Promise<GeolocationResult>((res) => {
    resolve = res;
  });
  const geolocation = navigator.geolocation;
  if (geolocation == null) {
    resolve({ ...FALLBACK_LOCATION, fallback: true, fallbackReason: 'browser location unavailable' });
    return promise;
  }
  geolocation.getCurrentPosition(
    (position) => {
      const { latitude, longitude } = position.coords;
      resolve({ latitude, longitude, label: `${latitude.toFixed(2)}°, ${longitude.toFixed(2)}°`, fallback: false });
    },
    (error) => {
      const reason =
        error.code === error.PERMISSION_DENIED
          ? 'permission denied'
          : error.code === error.POSITION_UNAVAILABLE
            ? 'device location unavailable'
            : 'location request timed out';
      resolve({ ...FALLBACK_LOCATION, fallback: true, fallbackReason: reason });
    },
    { timeout: GEOLOCATION_TIMEOUT_MS, maximumAge: 5 * 60 * 1000 },
  );
  return promise;
}

/**
 * Loads weather with the full fallback chain:
 * geolocation (else fixed location) -> Open-Meteo (else synthetic demo).
 * `previous` enables a TTL check so refresh actions do not hammer the API.
 */
export async function loadWeather(previous?: WeatherDataset): Promise<WeatherFetchOutcome> {
  if (
    previous != null &&
    previous.source !== 'demo' &&
    Date.now() - previous.fetchedAt < REFRESH_TTL_MS
  ) {
    return { dataset: previous, status: { kind: 'ready' } };
  }

  let location: GeolocationResult;
  try {
    location = await resolveLocation();
  } catch {
    // Legacy engines (Quest Browser < Chromium 119) lack ES2024 APIs used
    // above; degrade to the fixed location instead of rejecting the chain.
    location = { ...FALLBACK_LOCATION, fallback: true, fallbackReason: 'location unavailable on this browser' };
  }
  try {
    const hours = await fetchOpenMeteo(location.latitude, location.longitude);
    return {
      dataset: {
        source: location.fallback ? 'open-meteo-fallback-location' : 'open-meteo',
        label: location.fallback
          ? `${location.label} (${location.fallbackReason})`
          : location.label,
        fetchedAt: Date.now(),
        latitude: location.latitude,
        longitude: location.longitude,
        hours,
      },
      status: { kind: 'ready' },
    };
  } catch (error) {
    // AbortError reads as "signal is aborted without reason" — say it plainly.
    const reason =
      error instanceof DOMException && error.name === 'AbortError'
        ? 'weather service timed out'
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      dataset: {
        ...buildDemoDataset(),
        label: `DEMO - ${location.fallback ? `${location.label} (${location.fallbackReason})` : location.label}`,
      },
      status: { kind: 'demo', reason },
    };
  }
}
