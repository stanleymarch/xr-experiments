// WEATHER//ROOM — погодный контекст: чистая логика без THREE, DOM и сети.
//
// Здесь живёт всё, что определяет «что именно показывать»: расшифровка
// WMO-кодов, положение солнца и луны (низкоточная астрономия), сезон по
// широте и месяцу, разбор ответа Open-Meteo, синтез явно помеченного
// превью и перевод данных в параметры сцены (облачность, дождь, снег,
// туман, влажность земли, ветер). Модуль детерминирован: те же входы —
// тот же результат, никаких обращений к сети или устройствам.

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** Сводка считается устаревшей через 15 минут после получения. */
export const STALE_MS = 15 * 60 * 1000;
/** Старше этого возраста сохранённая сводка не восстанавливается вовсе. */
export const MAX_RESTORE_MS = 6 * 60 * 60 * 1000;
/** Широта/долгота превью: явно упоминается в интерфейсе как предположение. */
export const PREVIEW_LAT = 55.75;
export const PREVIEW_LON = 37.62;
/** Позицию для повторного запроса переиспользуем 10 минут, чтобы не дёргать разрешение. */
export const POSITION_TTL_MS = 10 * 60 * 1000;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const norm360 = (d) => ((d % 360) + 360) % 360;
const rad = (d) => d * RAD;
const deg = (r) => r * DEG;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ---------- 1. Коды WMO ----------

// ru — полное название (пространственная карточка), short — сжатое (строка HUD).
const WMO_TABLE = [
  [[0], { kind: 'clear', ru: 'Ясно', short: 'ясно', level: 0 }],
  [[1], { kind: 'clear', ru: 'Преимущественно ясно', short: 'почти ясно', level: 0 }],
  [[2], { kind: 'partly', ru: 'Переменная облачность', short: 'перем. облачн.', level: 0 }],
  [[3], { kind: 'overcast', ru: 'Пасмурно', short: 'пасмурно', level: 0 }],
  [[45, 48], { kind: 'fog', ru: 'Туман', short: 'туман', level: 0 }],
  [[51], { kind: 'drizzle', ru: 'Слабая морось', short: 'морось', level: 0 }],
  [[53], { kind: 'drizzle', ru: 'Морось', short: 'морось', level: 1 }],
  [[55], { kind: 'drizzle', ru: 'Плотная морось', short: 'морось', level: 2 }],
  [[56, 57], { kind: 'drizzle', ru: 'Ледяная морось', short: 'лед. морось', level: 1, freezing: true }],
  [[61], { kind: 'rain', ru: 'Слабый дождь', short: 'слаб. дождь', level: 0 }],
  [[63], { kind: 'rain', ru: 'Дождь', short: 'дождь', level: 1 }],
  [[65], { kind: 'rain', ru: 'Сильный дождь', short: 'сильн. дождь', level: 2 }],
  [[66, 67], { kind: 'rain', ru: 'Ледяной дождь', short: 'лед. дождь', level: 2, freezing: true }],
  [[71], { kind: 'snow', ru: 'Слабый снег', short: 'слаб. снег', level: 0 }],
  [[73], { kind: 'snow', ru: 'Снег', short: 'снег', level: 1 }],
  [[75], { kind: 'snow', ru: 'Сильный снег', short: 'сильн. снег', level: 2 }],
  [[77], { kind: 'snow', ru: 'Снежные зёрна', short: 'снеж. зёрна', level: 0 }],
  [[80], { kind: 'rain', ru: 'Слабый ливень', short: 'слаб. ливень', level: 0 }],
  [[81], { kind: 'rain', ru: 'Ливень', short: 'ливень', level: 1 }],
  [[82], { kind: 'rain', ru: 'Сильный ливень', short: 'сильн. ливень', level: 2 }],
  [[85], { kind: 'snow', ru: 'Снежный заряд', short: 'снеж. заряд', level: 1 }],
  [[86], { kind: 'snow', ru: 'Сильный снежный заряд', short: 'сильн. заряд', level: 2 }],
  [[95], { kind: 'thunder', ru: 'Гроза', short: 'гроза', level: 1 }],
  [[96, 99], { kind: 'thunder', ru: 'Гроза с градом', short: 'гроза с градом', level: 2 }],
];

const WMO_BY_CODE = new Map();
for (const [codes, info] of WMO_TABLE) for (const c of codes) WMO_BY_CODE.set(c, info);

/** Код WMO → читаемое условие и группа. */
export function wmoInfo(code) {
  const c = Number(code);
  return WMO_BY_CODE.get(c) ?? { kind: 'unknown', ru: `Код ${Number.isFinite(c) ? c : '—'}`, short: 'неизв. код', level: 0 };
}

/** Тип осадков для отрисовки: 'none' | 'rain' | 'snow' | 'fog'. */
export function precipitationKind(info) {
  if (info.kind === 'snow') return 'snow';
  if (info.kind === 'rain' || info.kind === 'drizzle' || info.kind === 'thunder') return 'rain';
  if (info.kind === 'fog') return 'fog';
  return 'none';
}

// ---------- 2. Солнце и луна ----------

/** Юлианская дата из эпохи Unix. */
export function julianDay(ms) {
  return ms / 86400000 + 2440587.5;
}

/**
 * Эклиптические координаты (λ, β) → высота и азимут наблюдателя.
 * Азимут отсчитывается от севера по часовой стрелке (восток = 90°).
 * Система сцены: −Z = юг, +X = восток, +Y = вверх — сад развёрнут на юг,
 * поэтому полуденное солнце северного полушария светит ему в лицо.
 */
function eclipticToAltAz(lambdaDeg, betaDeg, jd, latDeg, lonDeg) {
  const d = jd - 2451545.0;
  const eps = rad(23.4393 - 3.563e-7 * d);
  const l = rad(lambdaDeg);
  const b = rad(betaDeg);
  const sinDec = Math.sin(b) * Math.cos(eps) + Math.cos(b) * Math.sin(eps) * Math.sin(l);
  const dec = Math.asin(clamp(sinDec, -1, 1));
  const ra = Math.atan2(Math.sin(l) * Math.cos(eps) - Math.tan(b) * Math.sin(eps), Math.cos(l));
  const gmst = norm360(280.46061837 + 360.98564736629 * d);
  const lst = rad(norm360(gmst + lonDeg));
  let ha = lst - ra;
  ha = Math.atan2(Math.sin(ha), Math.cos(ha));
  const phi = rad(latDeg);
  const sinAlt = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha);
  const altitudeDeg = deg(Math.asin(clamp(sinAlt, -1, 1)));
  const azimuthDeg = norm360(deg(Math.atan2(-Math.sin(ha) * Math.cos(dec),
    Math.cos(phi) * Math.sin(dec) - Math.sin(phi) * Math.cos(dec) * Math.cos(ha))));
  return { altitudeDeg, azimuthDeg, raRad: ra, decRad: dec };
}

function sunEclipticLon(jd) {
  const d = jd - 2451545.0;
  const L = 280.460 + 0.9856474 * d;
  const M = rad(357.528 + 0.9856003 * d);
  return L + 1.915 * Math.sin(M) + 0.020 * Math.sin(2 * M);
}

/** Высота и азимут солнца (точность ~0.02°, этого достаточно для сцены). */
export function solarPosition(ms, latDeg = PREVIEW_LAT, lonDeg = PREVIEW_LON) {
  const jd = julianDay(ms);
  return eclipticToAltAz(sunEclipticLon(jd), 0, jd, latDeg, lonDeg);
}

/**
 * Высота, азимут и фаза луны по усечённым рядам (точность ~1°).
 * @returns {{altitudeDeg:number, azimuthDeg:number, phase:number, phaseRu:string, waxing:boolean, elongationDeg:number}}
 */
export function moonPosition(ms, latDeg = PREVIEW_LAT, lonDeg = PREVIEW_LON) {
  const jd = julianDay(ms);
  const d = jd - 2451545.0;
  const Ls = 280.460 + 0.9856474 * d;
  const Ms = 357.528 + 0.9856003 * d;
  const Lm = 218.316 + 13.176396 * d;
  const Mm = 134.963 + 13.064993 * d;
  const F = 93.272 + 13.229350 * d;
  const D = Lm - Ls;
  const r = rad;
  const lambda = Lm
    + 6.289 * Math.sin(r(Mm))
    + 1.274 * Math.sin(r(2 * D - Mm))
    + 0.658 * Math.sin(r(2 * D))
    + 0.214 * Math.sin(r(2 * Mm))
    - 0.186 * Math.sin(r(Ms))
    - 0.114 * Math.sin(r(2 * F));
  const beta = 5.128 * Math.sin(r(F))
    + 0.281 * Math.sin(r(Mm + F))
    + 0.278 * Math.sin(r(Mm - F))
    + 0.173 * Math.sin(r(2 * D - F));
  const pos = eclipticToAltAz(lambda, beta, jd, latDeg, lonDeg);
  const elong = norm360(lambda - sunEclipticLon(jd));
  const phase = clamp((1 - Math.cos(rad(elong))) / 2, 0, 1);
  return {
    altitudeDeg: pos.altitudeDeg,
    azimuthDeg: pos.azimuthDeg,
    phase,
    phaseRu: moonPhaseName(elong, phase),
    waxing: elong < 180,
    elongationDeg: elong,
  };
}

/** Название фазы луны по элонгации. */
export function moonPhaseName(elongDeg, phase) {
  const e = norm360(elongDeg);
  if (phase < 0.03) return 'новолуние';
  if (phase > 0.97) return 'полнолуние';
  if (e < 90) return 'растущий серп';
  if (e < 100) return 'первая четверть';
  if (e < 180) return 'растущая луна';
  if (e < 260) return 'убывающая луна';
  if (e < 280) return 'последняя четверть';
  return 'старый серп';
}

/** Единичный вектор направления (сцена: −Z юг, +X восток, +Y верх). */
export function dirFromAltAz(altitudeDeg, azimuthDeg) {
  const a = rad(azimuthDeg);
  const h = rad(altitudeDeg);
  const c = Math.cos(h);
  return { x: Math.sin(a) * c, y: Math.sin(h), z: Math.cos(a) * c };
}

// ---------- 3. Сезон ----------

const SEASON_RU = { winter: 'зима', spring: 'весна', summer: 'лето', autumn: 'осень' };
// Метеорологические сезоны: месяц задаёт сезон, полушарие его переворачивает.
const MONTH_SEASON = ['winter', 'winter', 'spring', 'spring', 'spring', 'summer',
  'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'];

const _fmt = new Map();
function formatter(tz) {
  const key = tz || 'local';
  let f = _fmt.get(key);
  if (!f) {
    const opts = {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    };
    // Неизвестный пояс (или среда без IANA-базы) — считаем по локальным часам.
    try { f = new Intl.DateTimeFormat('ru-RU', { ...opts, timeZone: tz || undefined }); }
    catch { f = new Intl.DateTimeFormat('ru-RU', opts); }
    _fmt.set(key, f);
  }
  return f;
}

/** Локальный (в часовом поясе tz) номер месяца 0..11 и час 0..23. */
export function localParts(ms, tz) {
  const f = formatter(tz);
  const out = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') out[p.type] = p.value;
  return {
    month: (Number(out.month) || 1) - 1,
    day: Number(out.day) || 1,
    hour: Number(out.hour) || 0,
    minute: Number(out.minute) || 0,
  };
}

/**
 * Сезон на широте lat в момент ms. Для живой сводки месяц берётся в часовом
 * поясе точки, для превью — по локальным часам устройства.
 */
export function seasonOf(ms, latDeg = PREVIEW_LAT, tz = null) {
  const month = localParts(ms, tz).month;
  const north = latDeg >= 0;
  let key = MONTH_SEASON[month];
  if (!north) key = { winter: 'summer', spring: 'autumn', summer: 'winter', autumn: 'spring' }[key];
  return { key, ru: SEASON_RU[key], north, hemisphere: north ? 'северное' : 'южное' };
}

// ---------- 4. Ветер и форматирование ----------

const COMPASS = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];

/** Румб, откуда дует ветер (метеорологическая конвенция). */
export function compassRu(fromDeg) {
  if (!Number.isFinite(fromDeg)) return '—';
  return COMPASS[Math.round(norm360(fromDeg) / 45) % 8];
}

/**
 * Ветер: направление, КУДА он дует (ветер приходит с fromDeg), плюс единичный
 * вектор в системе сцены (−Z юг, +X восток).
 */
export function windVectorToward(fromDeg) {
  const from = Number.isFinite(fromDeg) ? norm360(fromDeg) : 0;
  const to = norm360(from + 180);
  return { fromDeg: from, towardDeg: to, x: Math.sin(rad(to)), z: Math.cos(rad(to)) };
}

export function formatTemp(c) {
  if (!Number.isFinite(c)) return '—°';
  const v = Math.round(c);
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}°`;
}

export function formatWind(mps) {
  if (!Number.isFinite(mps)) return '—';
  return mps < 10 ? `${mps.toFixed(1)} м/с` : `${Math.round(mps)} м/с`;
}

/** Время в часовом поясе точки (или локально, если пояс неизвестен). */
export function formatClock(ms, tz = null) {
  if (!Number.isFinite(ms)) return '—:—';
  const p = localParts(ms, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** Дата «23.09» в часовом поясе точки. */
export function formatDate(ms, tz = null) {
  if (!Number.isFinite(ms)) return '—.—';
  const p = localParts(ms, tz);
  return `${String(p.day).padStart(2, '0')}.${String(p.month + 1).padStart(2, '0')}`;
}

/** «42 мин» / «2 ч 05 мин» — возраст сводки. */
export function formatAge(ageMs) {
  const min = Math.max(0, Math.round(ageMs / 60000));
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  return `${h} ч ${String(min % 60).padStart(2, '0')} мин`;
}

/** Компактная метка устаревания для строки статуса: «−42м», «−2ч». */
export function formatAgeShort(ageMs) {
  const min = Math.max(0, Math.round(ageMs / 60000));
  return min < 60 ? `−${min}м` : `−${Math.floor(min / 60)}ч`;
}

// ---------- 5. Сеть: URL и разбор ответа ----------

/** URL Open-Meteo: текущие условия + восход/закат; без ключей и секретов. */
export function buildOpenMeteoUrl(lat, lon) {
  const q = new URLSearchParams({
    latitude: Number(lat).toFixed(4),
    longitude: Number(lon).toFixed(4),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,surface_pressure',
    daily: 'sunrise,sunset',
    timezone: 'auto',
    forecast_days: '1',
    wind_speed_unit: 'ms',
  });
  return `https://api.open-meteo.com/v1/forecast?${q}`;
}

function parseLocalIso(iso, utcOffsetSec) {
  const ms = Date.parse(`${iso}:00Z`);
  return Number.isFinite(ms) ? ms - utcOffsetSec * 1000 : null;
}

/**
 * Ответ Open-Meteo → нормализованная сводка. Бросает Error, если структура
 * не та: «живой» сводкой никогда не считается то, что не удалось разобрать.
 */
export function parseOpenMeteo(json, { lat, lon, fetchedAt = Date.now() } = {}) {
  const cur = json?.current;
  if (!cur || num(cur.weather_code) == null) throw new Error('в ответе нет current.weather_code');
  const off = num(json.utc_offset_seconds) ?? 0;
  const at = cur.time ? parseLocalIso(cur.time, off) : fetchedAt;
  if (at == null) throw new Error('не разобран current.time');
  const daily = json.daily ?? {};
  const reading = {
    source: 'live',
    at,
    fetchedAt,
    lat: num(json.latitude) ?? num(lat) ?? PREVIEW_LAT,
    lon: num(json.longitude) ?? num(lon) ?? PREVIEW_LON,
    tz: typeof json.timezone === 'string' ? json.timezone : null,
    tzLabel: typeof json.timezone_abbreviation === 'string' ? json.timezone_abbreviation : null,
    code: cur.weather_code,
    info: wmoInfo(cur.weather_code),
    tempC: num(cur.temperature_2m),
    feelsC: num(cur.apparent_temperature),
    humidity: num(cur.relative_humidity_2m),
    pressureHpa: num(cur.surface_pressure),
    precipMm: num(cur.precipitation) ?? 0,
    rainMm: num(cur.rain) ?? 0,
    snowCm: num(cur.snowfall) ?? 0,
    cloudPct: num(cur.cloud_cover),
    windMps: num(cur.wind_speed_10m),
    gustMps: num(cur.wind_gusts_10m),
    windFromDeg: num(cur.wind_direction_10m),
    isDayApi: num(cur.is_day) === 1,
    sunriseMs: daily.sunrise?.[0] ? parseLocalIso(daily.sunrise[0], off) : null,
    sunsetMs: daily.sunset?.[0] ? parseLocalIso(daily.sunset[0], off) : null,
    note: null,
  };
  return reading;
}

// ---------- 6. Превью (честное демо) ----------

/**
 * Превью-условия: явно выдуманный набор, чтобы опыт можно было осмотреть
 * без доступа к геопозиции. Температура, ветер и облачность в каждой
 * записи — условные, интерфейс всегда называет источник «ПРЕВЬЮ».
 */
export const PREVIEW_CONDITIONS = [
  { id: 'clear', code: 0, ru: 'Ясно', tempC: 19, windMps: 2.0, windFromDeg: 240, cloudPct: 4, precipMm: 0, snowCm: 0 },
  { id: 'partly', code: 2, ru: 'Переменная облачность', tempC: 15, windMps: 3.1, windFromDeg: 225, cloudPct: 55, precipMm: 0, snowCm: 0 },
  { id: 'overcast', code: 3, ru: 'Пасмурно', tempC: 11, windMps: 4.2, windFromDeg: 200, cloudPct: 94, precipMm: 0, snowCm: 0 },
  { id: 'rain', code: 61, ru: 'Дождь', tempC: 9, windMps: 5.0, windFromDeg: 210, cloudPct: 92, precipMm: 1.4, snowCm: 0 },
  { id: 'storm', code: 95, ru: 'Гроза с ливнем', tempC: 17, windMps: 8.4, windFromDeg: 250, cloudPct: 100, precipMm: 3.6, snowCm: 0 },
  { id: 'snow', code: 71, ru: 'Снегопад', tempC: -4, windMps: 3.0, windFromDeg: 300, cloudPct: 96, precipMm: 0.4, snowCm: 1.6 },
  { id: 'fog', code: 45, ru: 'Туман', tempC: 6, windMps: 0.9, windFromDeg: 160, cloudPct: 70, precipMm: 0, snowCm: 0 },
];

/** Превью-часы: null — реальные локальные часы, иначе фиксированный час. */
export const PREVIEW_HOURS = [null, 6, 9, 13, 18, 22];

/** Момент времени для превью: локальные часы устройства, опционально с подменой часа. */
export function previewMoment(baseMs, hour = null) {
  if (hour == null) return baseMs;
  const d = new Date(baseMs);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

/**
 * Синтетическая сводка для превью. Время — настоящее (локальные часы
 * устройства), погода — условная. Широта берётся из предполагаемой, поэтому
 * источник «ПРЕВЬЮ» и помечается в интерфейсе вместе с этой оговоркой.
 */
export function previewReading({ index = 0, baseMs = Date.now(), hour = null, lat = PREVIEW_LAT, lon = PREVIEW_LON } = {}) {
  const cond = PREVIEW_CONDITIONS[clamp(Math.trunc(index) || 0, 0, PREVIEW_CONDITIONS.length - 1)];
  return {
    source: 'preview',
    at: previewMoment(baseMs, hour),
    fetchedAt: baseMs,
    lat, lon,
    tz: null,
    tzLabel: null,
    code: cond.code,
    info: wmoInfo(cond.code),
    tempC: cond.tempC,
    feelsC: null,
    humidity: null,
    pressureHpa: null,
    precipMm: cond.precipMm,
    rainMm: cond.precipMm,
    snowCm: cond.snowCm,
    cloudPct: cond.cloudPct,
    windMps: cond.windMps,
    gustMps: +(cond.windMps * 1.5).toFixed(1),
    windFromDeg: cond.windFromDeg,
    isDayApi: null,
    sunriseMs: null,
    sunsetMs: null,
    note: `превью-условие, не факт; широта ${Math.abs(lat).toFixed(1)}° предположена`,
  };
}

// ---------- 7. Производный контекст и параметры сцены ----------

/**
 * Всё, что зависит от времени: высоты солнца и луны, фаза, сезон, стадия суток.
 * @returns {{sun:object, moon:object, season:object, phase:string, rising:boolean, dayK:number, sunUp:boolean, dayLenMin:number|null, stale:boolean, ageMs:number}}
 */
export function contextOf(reading, nowMs = Date.now()) {
  const lat = Number.isFinite(reading.lat) ? reading.lat : PREVIEW_LAT;
  const lon = Number.isFinite(reading.lon) ? reading.lon : PREVIEW_LON;
  const at = Number.isFinite(reading.at) ? reading.at : nowMs;
  const sun = solarPosition(at, lat, lon);
  const moon = moonPosition(at, lat, lon);
  const season = seasonOf(at, lat, reading.source === 'live' ? reading.tz : null);
  const prev = solarPosition(at - 10 * 60000, lat, lon);
  const rising = sun.altitudeDeg > prev.altitudeDeg;
  const sinAlt = Math.sin(rad(sun.altitudeDeg));
  const dayK = clamp((sinAlt + 0.10) / 0.35, 0, 1);
  const phase = sun.altitudeDeg >= 6 ? 'день'
    : sun.altitudeDeg >= -0.8 ? (rising ? 'рассвет' : 'закат')
      : sun.altitudeDeg >= -8 ? (rising ? 'сумерки' : 'сумерки') : 'ночь';
  const ageMs = Math.max(0, nowMs - (reading.fetchedAt ?? nowMs));
  return {
    sun, moon, season, rising,
    phase,
    dayK,
    sunUp: sun.altitudeDeg > -0.8,
    dayLenMin: reading.sunriseMs && reading.sunsetMs
      ? Math.round((reading.sunsetMs - reading.sunriseMs) / 60000) : null,
    stale: reading.source === 'live' ? ageMs > STALE_MS : false,
    ageMs,
  };
}

const DEFAULT_CLOUD = { clear: 5, partly: 45, overcast: 95, fog: 75, drizzle: 85, rain: 92, snow: 92, thunder: 100, unknown: 50 };

/**
 * Сводка + контекст → числовые параметры сцены. Все величины — в единицах
 * сцены (0..1), палитры и материалы к ним применяет main.js.
 */
export function sceneParams(reading, ctx) {
  const info = reading.info ?? wmoInfo(reading.code);
  const cloudPct = Number.isFinite(reading.cloudPct) ? reading.cloudPct : (DEFAULT_CLOUD[info.kind] ?? 50);
  const cloud = clamp(cloudPct / 100, 0, 1);
  const lvl = clamp(info.level ?? 0, 0, 2);
  const precip = Number.isFinite(reading.precipMm) ? reading.precipMm : 0;
  const snowCm = Number.isFinite(reading.snowCm) ? reading.snowCm : 0;
  const temp = Number.isFinite(reading.tempC) ? reading.tempC : null;
  const pk = precipitationKind(info);

  let rain = 0, snow = 0, fog = 0;
  if (pk === 'rain') rain = clamp(Math.max(0.28 + lvl * 0.24, precip / 4), 0.22, 1);
  if (pk === 'snow') snow = clamp(Math.max(0.32 + lvl * 0.22, snowCm / 4), 0.25, 1);
  if (pk === 'fog') fog = clamp(0.7 + lvl * 0.12, 0, 1);
  else if (pk === 'rain') fog = clamp(0.08 + precip * 0.1, 0, 0.32);

  const wet = rain > 0 ? clamp(0.35 + rain * 0.65, 0, 1)
    : (Number.isFinite(reading.humidity) && reading.humidity > 90 && (temp ?? 0) > 1 ? 0.28 : 0);

  let snowCover = 0;
  if (snow > 0) snowCover = clamp(0.5 + snowCm * 0.3, 0, 1);
  else if (temp != null && temp <= 0.6) snowCover = 0.4;
  else if (ctx?.season?.key === 'winter' && temp != null && temp <= 2.5) snowCover = 0.22;

  const wind = windVectorToward(reading.windFromDeg);
  return {
    kind: info.kind,
    info,
    cloud,
    rain,
    snow,
    fog,
    wet,
    snowCover,
    windX: wind.x,
    windZ: wind.z,
    windFromDeg: wind.fromDeg,
    windTowardDeg: wind.towardDeg,
    windMps: Number.isFinite(reading.windMps) ? reading.windMps : 0,
    gustMps: Number.isFinite(reading.gustMps) ? reading.gustMps : 0,
    gustK: clamp((Number.isFinite(reading.gustMps) ? reading.gustMps : 0) / 16, 0, 1),
    precipMm: precip,
    snowCm,
    lightning: info.kind === 'thunder',
    tempC: temp,
  };
}

/** Величина дождя/снега в сцене: сколько частиц рисовать из предела. */
export function particleCount(limit, intensity) {
  if (!(intensity > 0.02)) return 0;
  return Math.max(12, Math.round(limit * clamp(intensity, 0, 1)));
}

/**
 * Текстовые поля состояния для интерфейса. Одна точка правды о том, что
 * за источник показывается, — интерфейс не должен додумывать сам.
 */
export function describe(reading, ctx, { error = null, fetching = false } = {}) {
  const info = reading?.info ?? { ru: '—', short: '—', kind: 'unknown', level: 0 };
  const tz = reading?.source === 'live' ? reading.tz : null;
  const tag = errorTag(error);
  let source;
  if (fetching) source = 'ЗАПРОС…';
  else if (reading?.source === 'live') source = `${ctx.stale ? `ЖИВАЯ${formatAgeShort(ctx.ageMs)}` : 'ЖИВАЯ'}${tag ? `/${tag}` : ''}`;
  else if (tag) source = `ПРЕВЬЮ/${tag}`;
  else source = 'ПРЕВЬЮ';
  const clock = reading ? formatClock(reading.at, tz) : '—:—';
  const wind = Number.isFinite(reading?.windMps)
    ? `${formatWind(reading.windMps)} ${compassRu(reading.windFromDeg)}` : '—';
  return {
    source,
    clock,
    date: reading ? formatDate(reading.at, tz) : '—.—',
    condition: info.ru,
    conditionShort: info.short,
    temp: formatTemp(reading?.tempC),
    wind,
    windShort: Number.isFinite(reading?.windMps)
      ? `${Math.round(reading.windMps)} м/с ${compassRu(reading.windFromDeg)}` : '—',
    gust: Number.isFinite(reading?.gustMps) ? formatWind(reading.gustMps) : '—',
    phase: ctx?.phase ?? '—',
    season: ctx ? `${ctx.season.ru} (${ctx.season.hemisphere[0].toUpperCase()}. полушарие)` : '—',
    sunAlt: ctx ? Math.round(ctx.sun.altitudeDeg) : 0,
    moonPhase: ctx ? `${ctx.moon.phaseRu} ${Math.round(ctx.moon.phase * 100)}%` : '—',
    moonAlt: ctx ? Math.round(ctx.moon.altitudeDeg) : 0,
    sunrise: reading?.sunriseMs ? formatClock(reading.sunriseMs, tz) : null,
    sunset: reading?.sunsetMs ? formatClock(reading.sunsetMs, tz) : null,
    tz: reading?.source === 'live' ? (reading.tzLabel ?? reading.tz ?? null) : null,
    place: reading?.source === 'live' && Number.isFinite(reading?.lat) && Number.isFinite(reading?.lon)
      ? `${reading.lat.toFixed(2)}, ${reading.lon.toFixed(2)}` : null,
    note: reading?.note ?? null,
    ageText: reading?.source === 'live' && ctx.ageMs > 60000 ? formatAge(ctx.ageMs) : null,
    error,
    errorTag: tag,
  };
}

/** Строка HUD: время, источник, условие, температура, ветер (влезает на телефон). */
export function hudLine(d) {
  return `${d.clock} · ${d.source} · ${d.conditionShort} · ${d.temp} · ${d.windShort}`;
}

/** Причина отказа геолокации/сети — коротко и по-русски. */
export function geolocationErrorText(err) {
  const code = err && typeof err === 'object' ? err.code : null;
  if (code === 1) return 'геопозиция запрещена — разрешение отклонено';
  if (code === 2) return 'геопозиция недоступна — определитель не отвечает';
  if (code === 3) return 'геопозиция: истек таймаут запроса';
  return 'геопозиция недоступна в этом браузере/контексте';
}

/** Короткая метка ошибки для строки статуса (влезает на узкий экран). */
export function errorTag(text) {
  if (!text) return null;
  if (text.includes('запрещена')) return 'ОТКАЗ ГЕО';
  if (text.includes('недоступна в этом')) return 'ГЕО НЕТ';
  if (text.includes('не отвечает')) return 'ГЕО МОЛЧИТ';
  if (text.includes('таймаут запроса')) return 'ТАЙМАУТ';
  if (text.includes('таймаут')) return 'ГЕО ТАЙМАУТ';
  if (text.startsWith('HTTP')) return text.slice(0, 12);
  if (text.includes('сеть') || text.includes('network') || text.includes('fetch')) return 'НЕТ СЕТИ';
  if (text.includes('данных') || text.includes('нет current')) return 'ОТВЕТ НЕ РАЗОБРАН';
  return 'ОШИБКА';
}
