/**
 * Bilingual (EN + RU) presentation strings for WEATHER//ROOM.
 *
 * Presentation layer only: every user-facing string rendered by the spatial
 * UIKitML panel (panel.ts), the browser DOM panel (browser-panel.ts), and
 * the UIKitML markup defaults lives here. The data layer
 * (weather-data.ts / providers.ts) stays English-only; known data-layer
 * phrases (loader labels, demo reasons, fallback location fragments) are
 * mapped to display strings at the presentation boundary via the
 * `localize*` helpers below, with unknown strings passing through
 * untouched so honesty is never replaced by a failed lookup.
 *
 * Language detection: `navigator.language` starting with `ru` selects
 * Russian, everything else selects English. An explicit override persists
 * in `localStorage` under LANG_STORAGE_KEY and wins over detection.
 * Panels subscribe via onLanguageChange and re-render instantly.
 */

export type Language = 'en' | 'ru';

export const LANG_STORAGE_KEY = 'weather-room.lang';

const en = {
  badgeLive: 'LIVE',
  badgeDemo: 'DEMO',
  playheadNow: 'NOW',
  // Status lines (spatial panel + browser panel).
  statusLoading: 'Loading weather…',
  statusLocating: 'Locating…',
  statusReady: 'Ready',
  statusWaiting: 'Waiting for device location / forecast...',
  statusRequestingLocation: 'Requesting device location...',
  statusStarting: 'Starting…',
  statusLive: 'Live from Open-Meteo',
  statusDemoRetained: 'Demo data — retained while reloading',
  statusDemoSynthetic: 'DEMO synthetic data',
  loadingPrefix: 'Loading: ',
  demoPrefix: 'DEMO: ',
  demoDataPrefix: 'Demo data: ',
  // Suffixes appended to status / playhead lines.
  staleSuffixPipe: ' | cached',
  staleSuffixParen: ' (cached)',
  beyondSuffixPipe: ' | beyond data',
  beyondSuffixDash: ' — beyond data',
  missingValue: '--',
  // Compact values row (spatial panel).
  feels: 'feels',
  rain: 'rain',
  wind: 'wind',
  cloud: 'cloud',
  humidity: 'RH',
  daylight: 'daylight',
  night: 'night',
  lightUnknown: 'light --',
  // Timeline hint + buttons (both surfaces).
  timelineHint: '-24H < GRAB KNOB / TAP BUTTONS > +24H',
  stepBack: '-6h',
  stepForward: '+6h',
  goLive: 'NOW',
  reload: 'Reload',
  reloading: 'Loading…',
  enterAr: 'Enter AR',
  exit: 'Exit',
  langName: 'RU',
  // Honest provider source rendered from dataset.source via PROVIDER_DISPLAY.
  sourceLiveFrom: 'Live from',
  sourceManualSuffix: '(manual location)',
  sourceIpPrefix: 'IP-based location',
  locationLabelPrefix: 'Location',
  locationDevice: 'device',
  locationUnsupported: 'manual entry only',
  locationPlaceholder: 'lat, lon',
  locationApply: 'Set',
  locationClear: 'My location',
  locationHint: 'Pick a city, enter "lat, lon", or tap My location (device/IP).',
  locationInvalid: 'Enter as lat, lon',
  timelineLabel: 'Timeline',
  xrChecking: 'Checking XR support…',
  xrDisabled: 'XR is not enabled in this build. Timeline and reload work in the browser.',
  xrEnterHint: 'Enter AR: use controller rays, hand pinch, or tap the spatial buttons on a phone.',
  xrUnavailable:
    'AR is not available in this browser. Timeline and reload work here; use a WebXR browser or headset for immersion.',
  ariaPanel: 'Weather room browser controls',
  ariaTimelineGroup: 'Timeline controls',
  ariaXrGroup: 'Immersive session controls',
  ariaStepBack: 'Back 6 hours',
  ariaGoLive: 'Return to live time',
  ariaStepForward: 'Forward 6 hours',
  ariaReload: 'Reload weather data',
  ariaScrub: 'Timeline offset in hours from now',
  ariaLiveNow: 'live, now',
  ariaSwitchLanguage: 'Switch language',
  locatingShort: 'Locating…',
} as const;

export type StringKey = keyof typeof en;

const ru: Record<StringKey, string> = {
  badgeLive: 'ЛАЙВ',
  badgeDemo: 'ДЕМО',
  playheadNow: 'СЕЙЧАС',
  statusLoading: 'Загрузка погоды…',
  statusLocating: 'Поиск местоположения…',
  statusReady: 'Готово',
  statusWaiting: 'Ожидание геопозиции / прогноза...',
  statusRequestingLocation: 'Запрос геопозиции…',
  statusStarting: 'Запуск…',
  statusLive: 'Open-Meteo · эфир',
  statusDemoRetained: 'Демо-данные · идёт обновление',
  statusDemoSynthetic: 'ДЕМО · синтетические данные',
  loadingPrefix: 'Загрузка: ',
  demoPrefix: 'ДЕМО: ',
  demoDataPrefix: 'Демо-данные: ',
  staleSuffixPipe: ' | кэш',
  staleSuffixParen: ' (кэш)',
  beyondSuffixPipe: ' | вне данных',
  beyondSuffixDash: ' — вне данных',
  missingValue: '--',
  feels: 'ощущ.',
  rain: 'дождь',
  wind: 'ветер',
  cloud: 'обл.',
  humidity: 'влаж.',
  daylight: 'день',
  night: 'ночь',
  lightUnknown: 'свет --',
  timelineHint: '-24Ч < РУЧКА / КНОПКИ > +24Ч',
  stepBack: '-6 ч',
  stepForward: '+6 ч',
  goLive: 'СЕЙЧАС',
  reload: 'Обновить',
  reloading: 'Загрузка…',
  enterAr: 'Войти в AR',
  exit: 'Выйти',
  langName: 'EN',
  sourceLiveFrom: 'Эфир:',
  sourceManualSuffix: '(вручную)',
  sourceIpPrefix: 'По IP',
  locationLabelPrefix: 'Место',
  locationDevice: 'устройство',
  locationUnsupported: 'только вручную',
  locationPlaceholder: 'шир., долг.',
  locationApply: 'ОК',
  locationClear: 'Моё место',
  locationHint: 'Выберите город, введите «шир., долг.» или нажмите «Моё место» (устройство/IP).',
  locationInvalid: 'Формат: шир., долг.',
  timelineLabel: 'Шкала времени',
  xrChecking: 'Проверка XR…',
  xrDisabled: 'XR выключен в этой сборке. Шкала и обновление работают в браузере.',
  xrEnterHint: 'Войти в AR: лучи контроллеров, щипок или кнопки панели на телефоне.',
  xrUnavailable:
    'AR недоступен в этом браузере. Шкала и обновление работают здесь; для погружения нужен WebXR-браузер или гарнитура.',
  ariaPanel: 'Панель управления погодой',
  ariaTimelineGroup: 'Управление шкалой',
  ariaXrGroup: 'Иммерсивный режим',
  ariaStepBack: 'Назад на 6 часов',
  ariaGoLive: 'Вернуться к текущему времени',
  ariaStepForward: 'Вперёд на 6 часов',
  ariaReload: 'Обновить данные погоды',
  ariaScrub: 'Смещение шкалы в часах от текущего времени',
  ariaLiveNow: 'эфир, сейчас',
  ariaSwitchLanguage: 'Переключить язык',
  locatingShort: 'Поиск…',
};

const STRINGS: Record<Language, Record<StringKey, string>> = {
  en: { ...en },
  ru,
};

/** All dictionary keys, for acceptance reporting and completeness checks. */
export const STRING_KEYS: readonly StringKey[] = Object.keys(en) as StringKey[];

function detectLanguage(): Language {
  try {
    const stored = globalThis.localStorage?.getItem(LANG_STORAGE_KEY);
    if (stored === 'en' || stored === 'ru') return stored;
  } catch {
    // Private-mode storage can throw; fall through to navigator detection.
  }
  try {
    const nav = globalThis.navigator?.language ?? '';
    if (nav.toLowerCase().startsWith('ru')) return 'ru';
  } catch {
    // Non-browser runtimes (smoke pages without navigator) stay English.
  }
  return 'en';
}

let current: Language = detectLanguage();

type LanguageListener = (lang: Language) => void;
const listeners = new Set<LanguageListener>();

export function getLanguage(): Language {
  return current;
}

/** Dictionary lookup in the active language. */
export function t(key: StringKey): string {
  return STRINGS[current][key];
}

/** Dictionary lookup in an explicit language (previews, tests). */
export function tIn(lang: Language, key: StringKey): string {
  return STRINGS[lang][key];
}

/** Persist the override and re-render every subscriber instantly. */
export function setLanguage(lang: Language): void {
  if (lang !== 'en' && lang !== 'ru') return;
  try {
    globalThis.localStorage?.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    // Storage may be unavailable; the in-memory language still switches.
  }
  if (current === lang) return;
  current = lang;
  for (const listener of listeners) listener(lang);
}

export function toggleLanguage(): Language {
  const next: Language = current === 'en' ? 'ru' : 'en';
  setLanguage(next);
  return next;
}

/** Panels subscribe so a toggle re-renders both surfaces in one frame. */
export function onLanguageChange(listener: LanguageListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Presentation helpers shared by both panels.
// ---------------------------------------------------------------------------

/** `-- unit` placeholder for measurements the dataset does not provide. */
export function formatMissing(unit: string): string {
  return `${STRINGS[current].missingValue} ${unit}`;
}

export function formatMissingIn(lang: Language, unit: string): string {
  return `${STRINGS[lang].missingValue} ${unit}`;
}

/** Localized WMO weather-code names (short enough for the 340 px panel). */
export function weatherCodeName(code: number, lang: Language = current): string {
  if (lang === 'ru') {
    if (code === 0) return 'Ясно';
    if (code <= 3) return 'Облака';
    if (code === 45 || code === 48) return 'Туман';
    if (code >= 51 && code <= 57) return 'Морось';
    if (code >= 61 && code <= 67) return 'Дождь';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'Снег';
    if (code >= 80 && code <= 82) return 'Ливень';
    if (code >= 95) return 'Гроза';
    return 'Погода';
  }
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
/** Russian hour plural in aria text: 1 час, 3 часа, 5 часов. */
export function formatHoursFromNow(hours: number, lang: Language = current): string {
  const signed = `${hours > 0 ? '+' : ''}${hours}`;
  if (lang === 'ru') {
    const abs = Math.abs(Math.round(hours));
    const mod10 = abs % 10;
    const mod100 = abs % 100;
    const noun =
      mod10 === 1 && mod100 !== 11
        ? 'час'
        : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
          ? 'часа'
          : 'часов';
    return `${signed} ${noun} от сейчас`;
  }
  return `${signed} hours from now`;
}

// ---------------------------------------------------------------------------
// Data-layer phrase mapping (presentation boundary only).
// The data layer stays English; known phrases are displayed localized.
// Unknown strings pass through so new loader reasons stay honest.
// ---------------------------------------------------------------------------

/** Loader `label` values produced by weather-loader.ts / weather-data.ts. */
const LOADER_LABELS: Record<string, Record<Language, string>> = {
  'Loading weather': { en: 'Loading weather', ru: 'Загрузка погоды' },
  'Reloading weather': { en: 'Reloading weather', ru: 'Обновление погоды' },
};

/** Demo `reason` / fallback fragments produced by weather-data.ts. */
const DATA_PHRASE_BY_EN: Record<string, string> = {
  'DEMO synthetic scenario': 'ДЕМО · синтетический сценарий',
  'Moscow (fallback)': 'Москва (запасная)',
  'browser location unavailable': 'геопозиция недоступна в браузере',
  'location unavailable on this browser': 'геопозиция недоступна в этом браузере',
  'permission denied': 'доступ запрещён',
  'device location unavailable': 'геопозиция недоступна',
  'location request timed out': 'таймаут геопозиции',
  'weather service timed out': 'сервис погоды недоступен',
};


function mapPhrases(text: string, lang: Language): string {
  if (lang === 'en') return text;
  let out = text;
  for (const source of Object.keys(DATA_PHRASE_BY_EN)) out = out.split(source).join(DATA_PHRASE_BY_EN[source]);
  return out;
}

/** Display form of a loader status label (`Loading: …`). */
export function localizeLoadingLabel(label: string, lang: Language = current): string {
  const known = LOADER_LABELS[label];
  if (known != null) return known[lang];
  return mapPhrases(label, lang);
}

/** Display form of demo reasons and dataset labels (coordinates pass through). */
export function localizeDataPhrase(text: string, lang: Language = current): string {
  return mapPhrases(text, lang);
}
// ---------------------------------------------------------------------------
// Honest provider source + manual location display.
// `dataset.source` is `<provider>[-manual|-ip|-fallback-location]` or
// `demo`; the label already carries `PROVIDER_DISPLAY · place`, so status
// renders `${Live from} ${provider}` while the location line shows the
// place with a localized manual/IP qualifier.
// ---------------------------------------------------------------------------

/** Provider id prefix of a dataset source (`met-no-manual-location` → `met-no`). */
export function providerOf(source: string): string {
  if (source.startsWith('met-no')) return 'met-no';
  if (source.startsWith('open-meteo')) return 'open-meteo';
  if (source.startsWith('wttr')) return 'wttr';
  return source;
}

/** Localized `Live from <Provider>` status fragment for a dataset source. */
export function sourceStatus(display: string, stale: string, lang: Language = current): string {
  return `${STRINGS[lang].sourceLiveFrom} ${display}${stale}`;
}

/** Localized location line: manual/IP qualifiers translated, coords pass through. */
export function localizePlaceLabel(place: string, lang: Language = current): string {
  if (lang === 'en') return place;
  return place
    .split('(manual location)')
    .join(STRINGS.ru.sourceManualSuffix)
    .split('IP-based location')
    .join(STRINGS.ru.sourceIpPrefix);
}

/** Localized preset names for the manual-location picker. */
export function localizePresetLabel(label: string, lang: Language = current): string {
  if (lang === 'en') return label;
  const table: Record<string, string> = {
    Moscow: 'Москва',
    'Saint Petersburg': 'Санкт-Петербург',
    London: 'Лондон',
    Berlin: 'Берлин',
    'New York': 'Нью-Йорк',
    Tokyo: 'Токио',
  };
  return table[label] ?? label;
}
