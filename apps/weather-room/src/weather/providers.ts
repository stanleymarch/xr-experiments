/**
 * Multi-provider weather + IP-location fetch for WEATHER//ROOM.
 *
 * Ordered no-key chain: Open-Meteo -> MET Norway -> wttr.in -> synthetic
 * demo. Open-Meteo leads as the reference source (fullest field coverage:
 * the only provider with apparent temperature, snowfall, visibility, gusts,
 * and precipitation probability); any failure degrades to the next provider
 * automatically. Measured from the Quest headset (published build, in-page
 * fetch): api.open-meteo.com can be unreachable from that network
 * (10 s timeout) while api.met.no answers in ~111 ms — on such networks the
 * chain falls through to MET Norway without user action. wttr.in is the
 * last resort before the synthetic demo. Open-Meteo keeps its existing
 * fetch/normalizer in weather-data.ts; this module owns MET Norway + wttr.in
 * (fetch, validation, normalization) plus the shared resampling/window /
 * IP-lookup helpers. No IWSDK/three imports.
 *
 * Request-window pinning (≈ now-24h .. now+24h, 1-hour resolution):
 * - Open-Meteo: past_days=2 + forecast_days=3 already returns a superset of
 *   the window at 1-hour steps; kept as-is, no clamp needed.
 * - MET Norway `compact` is forecast-only (no past hours). The grid therefore
 *   starts at the first native entry: past hours stay uncovered (downstream
 *   out-of-coverage) rather than extrapolated. Early steps are 1-hourly;
 *   later steps widen (observed live: 1-hourly for ~60h, then 6-hourly; other
 *   responses may use 3-hourly blocks). All cases are linearly resampled to
 *   exact whole UTC hours by resampleToHourlyGrid; the 6-hourly tail falls
 *   outside our window and is clamped away.
 * - wttr.in `?format=j1` returns 3 days x 8 entries (00,03,..,21 location
 *   local). Native 3-hour steps are linearly resampled to exact UTC hours.
 *   precipMM is a per-block total, so each hour gets block/3 (proven live:
 *   the 1800-local block matching a MET/OM rain event reports 0.1 mm while
 *   both hourly providers show ~0.1–0.2 mm/h — consistent with a 3 h total,
 *   not an hourly rate). Day 0 starts at local midnight, so past coverage
 *   reaches back to local midnight only — same forecast-only shape as
 *   MET Norway.
 *
 * Field equivalence vs Open-Meteo (the reference; full README table under
 * “Provider equivalence”): MET Norway lacks apparentTemperatureC,
 * precipitationProbabilityPct, snowfallCm, visibilityM, windGustsKmh (all
 * normalized to null, never 0) and computes isDay via solarIsDay; wttr.in
 * lacks only snowfallCm but reports 3-hourly location-local blocks (precipMM
 * per block ÷ 3) and WWO condition codes mapped to WMO-ish values. What is
 * lost on fallback: Open-Meteo → MET Norway loses feels-like, probability,
 * snow, visibility, gusts (→ `--` + neutral drivers), surface→sea-level
 * pressure, native WMO codes, and past-24h hours; MET Norway → wttr.in
 * regains feels-like/probability/gusts/visibility but drops to 3-hourly
 * native resolution with WWO-code approximations.
 *
 * MET Norway field mapping (instant.details + next_1_hours preferred):
 * - air_temperature -> temperatureC (C, direct)
 * - precipitation_amount: next_1_hours is the exact hourly amount; when
 *   absent, next_6_hours/12 amount is divided by 6/12 as an hourly rate; when
 *   no next_* block exists (far tail entries carry instant only) -> null
 * - wind_speed (m/s) -> windSpeedKmh (x3.6); wind_from_direction -> direct
 * - cloud_area_fraction -> cloudCoverPct; relative_humidity -> humidityPct
 * - air_pressure_at_sea_level -> pressureHpa (hPa, direct)
 * - symbol_code (next_1/6/12_hours summaries, _day/_night suffix stripped)
 *   -> weatherCode via MET_SYMBOL_TO_WMO (WMO-ish approximation)
 * - Unavailable from this API: apparentTemperatureC, precipitationProbability,
 *   visibilityM, snowfallCm, windGustsKmh -> null. isDay is computed by
 *   solarIsDay (the API carries no daylight flag).
 *
 * wttr.in field mapping (hourly[] entries; values arrive as numeric strings):
 * - tempC -> temperatureC; FeelsLikeC -> apparentTemperatureC
 * - precipMM/3 -> precipitationMm (see block assumption above)
 * - chanceofrain -> precipitationProbabilityPct (%, direct)
 * - humidity, cloudcover, pressure (mbar = hPa) -> direct
 * - visibility (km) -> visibilityM (x1000)
 * - weatherCode -> weatherCode via WWO_CODE_TO_WMO (WorldWeatherOnline codes
 *   are NOT WMO codes; mapping is an approximation, unknown codes -> null)
 * - windspeedKmph, winddirDegree, WindGustKmph -> direct
 * - snowfallCm -> null (only a per-day totalSnow_cm exists; not distributed)
 * - isDay via solarIsDay. The top-level current_condition snapshot is
 *   ignored: only the hourly series feeds the timeline.
 * - Entry times are location-local wall clock (date + time HHMM) with no
 *   timezone field, so UTC = local - offset. The offset prefers a hint from
 *   the IP-location services (same metro area) and otherwise estimates the
 *   standard zone as round(longitude/15); DST/political zones can shift this
 *   estimate by ~1h, acceptable for the last-resort provider.
 *
 * MET Norway asks clients to send a descriptive User-Agent. Browsers treat
 * User-Agent as a forbidden header (silently dropped), so in-page requests
 * rely on the browser UA; the header is still set here so non-browser
 * runtimes (Node verification) send `xr-experiments-weather-room`.
 *
 * IP location is best-effort and never blocks the weather chain: the
 * workstation reaches ipapi.co/ipwho.is/bigdatacloud, but from the headset
 * network ipapi.co fails (CORS/TLS) and bigdatacloud times out. api.ipify.org
 * answers from the headset but returns an IP only (no coordinates), so it is
 * deliberately NOT a location source. Successful lookups are cached to
 * localStorage for the next load; the current load always proceeds with
 * manual/fallback coordinates instead of waiting.
 */

import type { WeatherHour } from './weather-data.js';

/** Per-provider network budget: one dead host must not stall the chain. */
export const PROVIDER_TIMEOUT_MS = 8_000;

/** Per-service budget inside the IP-location fallback (tried in order). */
const IP_LOOKUP_TIMEOUT_MS = 5_000;

export type ProviderId = 'open-meteo' | 'met-no' | 'wttr';

/**
 * Chain order: Open-Meteo first (reference source, fullest fields), then
 * MET Norway, then wttr.in, then the synthetic demo.
 */
export const PROVIDER_ORDER: readonly ProviderId[] = ['open-meteo', 'met-no', 'wttr'];

export const PROVIDER_DISPLAY: Record<ProviderId, string> = {
  'met-no': 'MET Norway',
  'open-meteo': 'Open-Meteo',
  'wttr': 'wttr.in',
};

/** A resampled payload covering fewer window hours than this counts as failed. */
export const MIN_HOURLY_COVERAGE = 12;

/** Whole-hour grid spanning ~ now-24h .. now+24h (49 hourly points). */
export function hourlyWindow(nowMs = Date.now()): { startMs: number; endMs: number } {
  const startMs = Math.floor((nowMs - 24 * 3_600_000) / 3_600_000) * 3_600_000;
  const endMs = Math.ceil((nowMs + 24 * 3_600_000) / 3_600_000) * 3_600_000;
  return { startMs, endMs };
}

async function fetchJsonWithTimeout(
  url: string,
  label: string,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store', headers });
    if (!response.ok) {
      throw new Error(`${label} HTTP ${response.status}`);
    }
    return (await response.json()) as unknown;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`${label} timed out`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Coerces JSON numbers and numeric strings (wttr.in quotes every value). */
const toNum = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const toFiniteHour = (value: unknown): number | null => {
  const parsed = toNum(value);
  return parsed == null ? null : parsed;
};

/**
 * Daylight from solar elevation (low-precision solar position, good to ~1
 * minute for a boolean daylight flag). Day when the sun's upper limb clears
 * -0.833 degrees. Shared by MET Norway + wttr.in, neither of which reports
 * a daylight flag; categorical, so resampling takes nearest instead of
 * interpolating.
 */
export function solarIsDay(timeMs: number, latitude: number, longitude: number): boolean {
  const rad = Math.PI / 180;
  const norm360 = (deg: number): number => ((deg % 360) + 360) % 360;
  const julianDay = timeMs / 86_400_000 + 2_440_587.5;
  const daysSinceJ2000 = julianDay - 2_451_545.0;
  const meanLongitude = norm360(280.46 + 0.9856474 * daysSinceJ2000);
  const anomaly = norm360(357.528 + 0.9856003 * daysSinceJ2000) * rad;
  const eclipticLongitude =
    (meanLongitude + 1.915 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly)) * rad;
  const obliquity = (23.439 - 0.0000004 * daysSinceJ2000) * rad;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
  const rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLongitude),
    Math.cos(eclipticLongitude),
  );
  const greenwichSidereal = norm360(280.46061837 + 360.98564736629 * daysSinceJ2000);
  const hourAngle = (greenwichSidereal + longitude - rightAscension / rad) * rad;
  const latitudeRad = latitude * rad;
  const elevation = Math.asin(
    Math.sin(declination) * Math.sin(latitudeRad) +
      Math.cos(declination) * Math.cos(latitudeRad) * Math.cos(hourAngle),
  );
  return elevation / rad > -0.833;
}

/** MET Norway symbol base (suffix stripped) -> WMO-ish weather code. */
const MET_SYMBOL_TO_WMO: Record<string, number> = {
  clearsky: 0,
  fair: 1,
  partlycloudy: 2,
  cloudy: 4,
  fog: 45,
  lightrainshowers: 80,
  rainshowers: 81,
  heavyrainshowers: 82,
  lightrain: 61,
  rain: 63,
  heavyrain: 65,
  lightsleet: 68,
  sleet: 68,
  heavysleet: 68,
  lightsnow: 71,
  snow: 73,
  heavysnow: 75,
  lightsnowshowers: 85,
  snowshowers: 86,
  heavysnowshowers: 86,
  lightrainandthunder: 95,
  rainandthunder: 95,
  heavyrainandthunder: 95,
  lightrainshowersandthunder: 95,
  rainshowersandthunder: 95,
  heavyrainshowersandthunder: 95,
  lightsleetandthunder: 95,
  sleetandthunder: 95,
  heavysleetandthunder: 95,
  lightsnowshowersandthunder: 95,
  snowshowersandthunder: 95,
  heavysnowshowersandthunder: 95,
};

/** WorldWeatherOnline condition code (wttr.in weatherCode) -> WMO-ish code. */
const WWO_CODE_TO_WMO: Record<number, number> = {
  113: 0, // Clear/Sunny
  116: 2, // Partly cloudy
  119: 3, // Cloudy
  122: 3, // Overcast
  143: 45, // Mist
  149: 4, // Smoky haze -> smoke-obscured overcast
  150: 45, // Overcast with low cloud (rare)
  152: 4, // Smog -> obscured/overcast
  176: 61, // Patchy rain possible
  179: 71, // Patchy snow possible
  182: 68, // Patchy sleet possible
  185: 57, // Patchy freezing drizzle possible
  200: 95, // Thundery outbreaks possible
  227: 73, // Blowing snow
  230: 75, // Blizzard
  248: 45, // Fog
  260: 48, // Freezing fog
  263: 51, // Patchy light drizzle
  266: 53, // Light drizzle
  281: 66, // Freezing rain
  284: 57, // Heavy freezing drizzle
  293: 61, // Patchy light rain
  296: 63, // Light rain
  299: 63, // Moderate rain at times
  302: 65, // Moderate rain
  305: 65, // Heavy rain at times
  308: 65, // Heavy rain
  311: 66, // Light freezing rain
  314: 67, // Moderate/heavy freezing rain
  317: 68, // Light sleet
  320: 68, // Moderate/heavy sleet
  323: 71, // Patchy light snow
  326: 73, // Light snow
  329: 75, // Patchy moderate snow
  332: 73, // Moderate snow
  335: 75, // Patchy heavy snow
  338: 75, // Heavy snow
  350: 79, // Ice pellets
  353: 80, // Light rain shower
  356: 81, // Moderate/heavy rain shower
  359: 82, // Torrential rain shower
  362: 80, // Light sleet showers
  365: 81, // Moderate/severe sleet showers
  368: 85, // Light snow showers
  371: 86, // Moderate/heavy snow showers
  374: 79, // Moderate/heavy showers of ice pellets
  377: 96, // Moderate/severe hail
  386: 95, // Patchy light rain with thunder
  389: 95, // Moderate/heavy rain with thunder
  392: 95, // Patchy light snow with thunder
  395: 95, // Moderate/heavy snow with thunder
};

type LerpKey =
  | 'temperatureC'
  | 'apparentTemperatureC'
  | 'precipitationMm'
  | 'precipitationProbabilityPct'
  | 'snowfallCm'
  | 'visibilityM'
  | 'humidityPct'
  | 'windSpeedKmh'
  | 'windGustsKmh'
  | 'cloudCoverPct'
  | 'pressureHpa';

const LERP_KEYS: readonly LerpKey[] = [
  'temperatureC',
  'apparentTemperatureC',
  'precipitationMm',
  'precipitationProbabilityPct',
  'snowfallCm',
  'visibilityM',
  'humidityPct',
  'windSpeedKmh',
  'windGustsKmh',
  'cloudCoverPct',
  'pressureHpa',
];

/**
 * Resample an irregular native series onto exact whole-hour UTC grid points.
 * No extrapolation: grid hours outside the native span are skipped, so
 * forecast-only providers (MET Norway, wttr.in) yield a shorter past tail
 * instead of invented history. Continuous fields interpolate linearly (a
 * single-sided null holds the available side); circular/categorical fields
 * (wind direction, weather code, isDay) take the nearest native sample.
 */
export function resampleToHourlyGrid(
  samples: readonly WeatherHour[],
  startMs: number,
  endMs: number,
): WeatherHour[] {
  const sorted = [...samples]
    .filter((sample) => Number.isFinite(sample.time.getTime()))
    .sort((a, b) => a.time.getTime() - b.time.getTime());
  if (sorted.length === 0) {
    return [];
  }
  const firstMs = sorted[0].time.getTime();
  const lastMs = sorted[sorted.length - 1].time.getTime();
  const out: WeatherHour[] = [];
  for (let cursor = startMs; cursor <= endMs; cursor += 3_600_000) {
    if (cursor < firstMs || cursor > lastMs) {
      continue;
    }
    let lower = 0;
    while (lower + 1 < sorted.length && sorted[lower + 1].time.getTime() <= cursor) {
      lower += 1;
    }
    const before = sorted[lower];
    const after = sorted[Math.min(lower + 1, sorted.length - 1)];
    const beforeMs = before.time.getTime();
    const afterMs = after.time.getTime();
    if (cursor === beforeMs || afterMs === beforeMs) {
      out.push(before);
      continue;
    }
    if (cursor === afterMs) {
      out.push(after);
      continue;
    }
    const fraction = (cursor - beforeMs) / (afterMs - beforeMs);
    const blended = { time: new Date(cursor) } as Record<string, Date | number | null>;
    for (const key of LERP_KEYS) {
      const a = before[key];
      const b = after[key];
      blended[key] = a == null ? b : b == null ? a : a + (b - a) * fraction;
    }
    blended.weatherCode = fraction < 0.5 ? before.weatherCode : after.weatherCode;
    blended.isDay = fraction < 0.5 ? before.isDay : after.isDay;
    blended.windDirectionDeg = fraction < 0.5 ? before.windDirectionDeg : after.windDirectionDeg;
    out.push(blended as unknown as WeatherHour);
  }
  return out;
}

/** Ceiling/floor to whole UTC hours for grid bounds. */
const ceilHourMs = (timeMs: number): number => Math.ceil(timeMs / 3_600_000) * 3_600_000;

const floorHourMs = (timeMs: number): number => Math.floor(timeMs / 3_600_000) * 3_600_000;

const summaryCode = (node: unknown): string | null => {
  const code = (node as { summary?: { symbol_code?: unknown } } | null)?.summary?.symbol_code;
  return typeof code === 'string' ? code : null;
};

/**
 * Normalize a live MET Norway locationforecast/compact payload. Throws when
 * the shape is wrong or fewer than MIN_HOURLY_COVERAGE window hours result.
 */
export function normalizeMetNorway(
  payload: unknown,
  latitude: number,
  longitude: number,
  nowMs = Date.now(),
): WeatherHour[] {
  const series = (payload as { properties?: { timeseries?: unknown } } | null)?.properties
    ?.timeseries;
  if (!Array.isArray(series) || series.length === 0) {
    throw new Error('MET Norway payload has no properties.timeseries');
  }
  const native: WeatherHour[] = [];
  for (const entry of series) {
    const record = entry as {
      time?: unknown;
      data?: {
        instant?: { details?: Record<string, unknown> };
        next_1_hours?: { summary?: unknown; details?: Record<string, unknown> };
        next_6_hours?: { summary?: unknown; details?: Record<string, unknown> };
        next_12_hours?: { summary?: unknown; details?: Record<string, unknown> };
      };
    };
    const timeMs = typeof record.time === 'string' ? Date.parse(record.time) : Number.NaN;
    const details = record.data?.instant?.details;
    if (!Number.isFinite(timeMs) || details == null) {
      continue;
    }
    const rawSymbol =
      summaryCode(record.data?.next_1_hours) ??
      summaryCode(record.data?.next_6_hours) ??
      summaryCode(record.data?.next_12_hours);
    const symbolBase = rawSymbol?.replace(/_(day|night)$/, '');
    const windSpeedMs = toNum(details.wind_speed);
    // Precipitation prefers the exact next_1_hours amount; 6/12-hour blocks
    // (outside our window) degrade to an hourly rate; instant-only tail
    // entries without any next_* block yield null rather than zero.
    const precipitationMm =
      toNum(record.data?.next_1_hours?.details?.precipitation_amount) ??
      (() => {
        const sixHour = toNum(record.data?.next_6_hours?.details?.precipitation_amount);
        if (sixHour != null) {
          return sixHour / 6;
        }
        const twelveHour = toNum(record.data?.next_12_hours?.details?.precipitation_amount);
        return twelveHour == null ? null : twelveHour / 12;
      })();
    const temperatureC = toNum(details.air_temperature);
    const windSpeedKmh = windSpeedMs == null ? null : windSpeedMs * 3.6;
    const cloudCoverPct = toNum(details.cloud_area_fraction);
    if (temperatureC == null && windSpeedKmh == null && cloudCoverPct == null) {
      continue;
    }
    native.push({
      time: new Date(timeMs),
      temperatureC,
      apparentTemperatureC: null,
      precipitationMm,
      precipitationProbabilityPct: null,
      visibilityM: null,
      snowfallCm: null,
      weatherCode: symbolBase == null ? null : (MET_SYMBOL_TO_WMO[symbolBase] ?? null),
      humidityPct: toNum(details.relative_humidity),
      isDay: solarIsDay(timeMs, latitude, longitude) ? 1 : 0,
      windSpeedKmh,
      windDirectionDeg: toNum(details.wind_from_direction),
      windGustsKmh: null,
      cloudCoverPct,
      pressureHpa: toNum(details.air_pressure_at_sea_level),
    });
  }
  if (native.length === 0) {
    throw new Error('MET Norway returned no usable hours');
  }
  const { startMs, endMs } = hourlyWindow(nowMs);
  const firstMs = Math.min(...native.map((hour) => hour.time.getTime()));
  const lastMs = Math.max(...native.map((hour) => hour.time.getTime()));
  const hours = resampleToHourlyGrid(
    native,
    Math.max(startMs, ceilHourMs(firstMs)),
    Math.min(endMs, floorHourMs(lastMs)),
  );
  if (hours.length < MIN_HOURLY_COVERAGE) {
    throw new Error(`MET Norway covered only ${hours.length}h of the required window`);
  }
  return hours;
}

/** Fetch + normalize MET Norway for the chain. Throws on any failure. */
export async function fetchMetNorway(latitude: number, longitude: number): Promise<WeatherHour[]> {
  const payload = await fetchJsonWithTimeout(
    `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${latitude}&lon=${longitude}`,
    'MET Norway',
    PROVIDER_TIMEOUT_MS,
    { 'User-Agent': 'xr-experiments-weather-room/0.1.0 (contact: local dev)' },
  );
  return normalizeMetNorway(payload, latitude, longitude);
}

/**
 * Normalize a live wttr.in `?format=j1` payload. `utcOffsetMin` anchors the
 * location-local day/hour wall clock to UTC; without a hint the standard
 * zone is estimated from longitude (see module docs). Throws when the shape
 * is wrong or fewer than MIN_HOURLY_COVERAGE window hours result.
 */
export function normalizeWttr(
  payload: unknown,
  latitude: number,
  longitude: number,
  nowMs = Date.now(),
  utcOffsetMin?: number,
): WeatherHour[] {
  const days = (payload as { weather?: unknown } | null)?.weather;
  if (!Array.isArray(days) || days.length === 0) {
    throw new Error('wttr.in payload has no weather days');
  }
  const offsetMin = utcOffsetMin ?? Math.round(longitude / 15) * 60;
  const native: WeatherHour[] = [];
  for (const day of days) {
    const dayRecord = day as { date?: unknown; hourly?: unknown };
    if (typeof dayRecord.date !== 'string' || !Array.isArray(dayRecord.hourly)) {
      continue;
    }
    const parts = dayRecord.date.split('-').map(Number);
    if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
      continue;
    }
    const [year, month, dayOfMonth] = parts;
    for (const rawHour of dayRecord.hourly) {
      const hour = rawHour as Record<string, unknown>;
      // `time` is HHMM location-local ("0", "300", ..., "2100").
      const padded = String(hour.time ?? '').padStart(4, '0');
      const hourOfDay = Number(padded.slice(0, 2));
      const minute = Number(padded.slice(2, 4));
      if (!Number.isFinite(hourOfDay) || !Number.isFinite(minute)) {
        continue;
      }
      const timeMs = Date.UTC(year, month - 1, dayOfMonth, hourOfDay, minute) - offsetMin * 60_000;
      if (!Number.isFinite(timeMs)) {
        continue;
      }
      const blockPrecipMm = toNum(hour.precipMM);
      const visibilityKm = toNum(hour.visibility);
      const wwoCode = toFiniteHour(hour.weatherCode);
      const temperatureC = toNum(hour.tempC);
      const windSpeedKmh = toNum(hour.windspeedKmph);
      const cloudCoverPct = toNum(hour.cloudcover);
      if (temperatureC == null && windSpeedKmh == null && cloudCoverPct == null) {
        continue;
      }
      native.push({
        time: new Date(timeMs),
        temperatureC,
        apparentTemperatureC: toNum(hour.FeelsLikeC),
        precipitationMm: blockPrecipMm == null ? null : Math.round((blockPrecipMm / 3) * 100) / 100,
        precipitationProbabilityPct: toNum(hour.chanceofrain),
        visibilityM: visibilityKm == null ? null : visibilityKm * 1000,
        snowfallCm: null,
        weatherCode: wwoCode == null ? null : (WWO_CODE_TO_WMO[wwoCode] ?? null),
        humidityPct: toNum(hour.humidity),
        isDay: solarIsDay(timeMs, latitude, longitude) ? 1 : 0,
        windSpeedKmh,
        windDirectionDeg: toNum(hour.winddirDegree),
        windGustsKmh: toNum(hour.WindGustKmph),
        cloudCoverPct,
        pressureHpa: toNum(hour.pressure),
      });
    }
  }
  if (native.length === 0) {
    throw new Error('wttr.in returned no usable hours');
  }
  const { startMs, endMs } = hourlyWindow(nowMs);
  const firstMs = Math.min(...native.map((entry) => entry.time.getTime()));
  const lastMs = Math.max(...native.map((entry) => entry.time.getTime()));
  const hours = resampleToHourlyGrid(
    native,
    Math.max(startMs, ceilHourMs(firstMs)),
    Math.min(endMs, floorHourMs(lastMs)),
  );
  if (hours.length < MIN_HOURLY_COVERAGE) {
    throw new Error(`wttr.in covered only ${hours.length}h of the required window`);
  }
  return hours;
}

/** Fetch + normalize wttr.in for the chain. Throws on any failure. */
export async function fetchWttr(
  latitude: number,
  longitude: number,
  utcOffsetMin?: number,
): Promise<WeatherHour[]> {
  const payload = await fetchJsonWithTimeout(
    `https://wttr.in/${latitude},${longitude}?format=j1`,
    'wttr.in',
    PROVIDER_TIMEOUT_MS,
  );
  return normalizeWttr(payload, latitude, longitude, Date.now(), utcOffsetMin);
}

export interface IpLocation {
  readonly latitude: number;
  readonly longitude: number;
  /** Human place, e.g. "Amsterdam, NL", or "" when only coords are known. */
  readonly place: string;
  /** IANA-offset minutes east of UTC when the service reports it. */
  readonly utcOffsetMin?: number;
}

const isValidCoords = (latitude: number | null, longitude: number | null): boolean =>
  latitude != null &&
  longitude != null &&
  Number.isFinite(latitude) &&
  Number.isFinite(longitude) &&
  Math.abs(latitude) <= 90 &&
  Math.abs(longitude) <= 180;

const joinPlace = (city: unknown, country: unknown): string =>
  [city, country]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .map((part) => part.trim())
    .join(', ');

/** Parses "+HHMM"/"+HH:MM" style offsets into minutes east of UTC. */
function parseUtcOffset(text: unknown): number | undefined {
  if (typeof text !== 'string') {
    return undefined;
  }
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(text.trim());
  if (match == null) {
    return undefined;
  }
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

/**
 * Best-effort reverse-geocode of bare IP coords into "City, CC" via the
 * BigDataCloud reverse-geocode-client endpoint (with-coordinates form).
 * Never throws: naming is cosmetic, the coords stand on their own.
 */
async function reverseGeocodeName(latitude: number, longitude: number): Promise<string | null> {
  try {
    const payload = (await fetchJsonWithTimeout(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`,
      'Reverse-geocode',
      IP_LOOKUP_TIMEOUT_MS,
    )) as { city?: unknown; locality?: unknown; countryCode?: unknown };
    const place = joinPlace(payload.city ?? payload.locality, payload.countryCode);
    return place === '' ? null : place;
  } catch {
    return null;
  }
}

const withName = async (location: IpLocation): Promise<IpLocation> => {
  if (location.place !== '') {
    return location;
  }
  const named = await reverseGeocodeName(location.latitude, location.longitude);
  return named == null ? location : { ...location, place: named };
};

/**
 * IP-based location, tried in order: ipapi.co -> ipwho.is -> BigDataCloud
 * (no-coordinates form = IP geolocation, verified live via `lookupSource`).
 * Best-effort: throws a combined error when every service fails and the
 * caller falls back to manual/fixed coordinates without waiting. Never
 * presented as device location.
 */
export async function fetchIpLocation(): Promise<IpLocation> {
  const failures: string[] = [];
  try {
    const payload = (await fetchJsonWithTimeout(
      'https://ipapi.co/json/',
      'IP lookup (ipapi.co)',
      IP_LOOKUP_TIMEOUT_MS,
    )) as {
      latitude?: unknown;
      longitude?: unknown;
      city?: unknown;
      country_code?: unknown;
      utc_offset?: unknown;
    };
    const latitude = toNum(payload.latitude);
    const longitude = toNum(payload.longitude);
    if (!isValidCoords(latitude, longitude)) {
      throw new Error('IP lookup (ipapi.co) returned no coordinates');
    }
    return await withName({
      latitude: latitude as number,
      longitude: longitude as number,
      place: joinPlace(payload.city, payload.country_code),
      utcOffsetMin: parseUtcOffset(payload.utc_offset),
    });
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  try {
    const payload = (await fetchJsonWithTimeout(
      'https://ipwho.is/',
      'IP lookup (ipwho.is)',
      IP_LOOKUP_TIMEOUT_MS,
    )) as {
      success?: unknown;
      latitude?: unknown;
      longitude?: unknown;
      city?: unknown;
      country_code?: unknown;
      timezone?: { utc?: unknown };
    };
    if (payload.success === false) {
      throw new Error('IP lookup (ipwho.is) reported failure');
    }
    const latitude = toNum(payload.latitude);
    const longitude = toNum(payload.longitude);
    if (!isValidCoords(latitude, longitude)) {
      throw new Error('IP lookup (ipwho.is) returned no coordinates');
    }
    return await withName({
      latitude: latitude as number,
      longitude: longitude as number,
      place: joinPlace(payload.city, payload.country_code),
      utcOffsetMin: parseUtcOffset(payload.timezone?.utc),
    });
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  try {
    const payload = (await fetchJsonWithTimeout(
      'https://api.bigdatacloud.net/data/reverse-geocode-client?localityLanguage=en',
      'IP lookup (bigdatacloud)',
      IP_LOOKUP_TIMEOUT_MS,
    )) as { latitude?: unknown; longitude?: unknown; city?: unknown; countryCode?: unknown };
    const latitude = toNum(payload.latitude);
    const longitude = toNum(payload.longitude);
    if (!isValidCoords(latitude, longitude)) {
      throw new Error('IP lookup (bigdatacloud) returned no coordinates');
    }
    const place = joinPlace(payload.city, payload.countryCode);
    return { latitude: latitude as number, longitude: longitude as number, place };
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  throw new Error(`IP location failed (${failures.join('; ')})`);
}

const IP_CACHE_KEY = 'weather-room:ip-location';
const IP_CACHE_TTL_MS = 7 * 24 * 3_600_000;

interface CachedIpLocation extends IpLocation {
  readonly at: number;
}

/**
 * Last successful IP lookup, when fresh. Synchronous (localStorage) so the
 * location chain can consult it without waiting on the network.
 */
export function getCachedIpLocation(): CachedIpLocation | null {
  try {
    const raw = localStorage.getItem(IP_CACHE_KEY);
    if (raw == null) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<CachedIpLocation>;
    const latitude = toNum(parsed.latitude);
    const longitude = toNum(parsed.longitude);
    if (!isValidCoords(latitude, longitude)) {
      return null;
    }
    if (typeof parsed.at !== 'number' || Date.now() - parsed.at > IP_CACHE_TTL_MS) {
      return null;
    }
    return {
      latitude: latitude as number,
      longitude: longitude as number,
      place: typeof parsed.place === 'string' ? parsed.place : '',
      utcOffsetMin: typeof parsed.utcOffsetMin === 'number' ? parsed.utcOffsetMin : undefined,
      at: parsed.at,
    };
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget IP refresh for the NEXT load. Never rejects and never
 * blocks: the current weather fetch already proceeds with manual/fallback
 * coordinates while this runs in the background.
 */
export async function refreshIpLocationCache(): Promise<void> {
  try {
    const found = await fetchIpLocation();
    try {
      const cached: CachedIpLocation = { ...found, at: Date.now() };
      localStorage.setItem(IP_CACHE_KEY, JSON.stringify(cached));
    } catch {
      // Private mode / no storage: the lookup simply is not reused.
    }
  } catch {
    // Best-effort: all IP services unreachable from this network.
  }
}

/**
 * Dispatch helper for the ordered chain. Open-Meteo keeps its existing
 * fetch in weather-data.ts, injected here to keep this module dependency-free
 * at runtime (type-only import above is erased).
 */
export async function fetchProvider(
  provider: ProviderId,
  latitude: number,
  longitude: number,
  utcOffsetMin: number | undefined,
  fetchOpenMeteo: (latitude: number, longitude: number) => Promise<WeatherHour[]>,
): Promise<WeatherHour[]> {
  switch (provider) {
    case 'open-meteo':
      return fetchOpenMeteo(latitude, longitude);
    case 'met-no':
      return fetchMetNorway(latitude, longitude);
    case 'wttr':
      return fetchWttr(latitude, longitude, utcOffsetMin);
  }
}
