# WEATHER//ROOM

Your real room physically manifests local weather from Open-Meteo: rain,
wind, cloud, temperature, and pressure fill the space around you, with a
-24h / NOW / +24h spatial timeline you scrub with your hands.

An immersive WebXR experience (an XR session you enter from the browser),
built on the Meta Immersive Web SDK (IWSDK): an entity-component system
(ECS — small data tags on entities, systems with queries that run each
frame) plus IWER, IWSDK's browser-based XR emulator for desktop testing.
Primary target: Quest 3 mixed reality. Secondary: Android WebXR AR with
graceful degradation. IWER desktop covers development previews.

## Run it

```sh
npm install
npm run dev      # CLI-managed runtime (IWER emulator) + editor
npm run build    # production bundle
```

## Data behavior

- Hourly series is fetched as UTC unix timestamps, so location/browser
  timezone mismatches never shift the selected hour. One request covers
  at least NOW−24h..NOW+24h (`past_days=2, forecast_days=3`).
- Missing fields render as `-- unit` on the panel and fall back to neutral
  scene drivers — never fabricated measurements. Playheads past the data
  edge show `· beyond data` instead of clamped endpoint values.
- A bounded background refresh performs at most one request per 15-minute
  window; older cached data is labeled `· cached` until refreshed.
  Timeline scrubbing never fetches.

## Provider chain + equivalence

Weather loads through an ordered no-key fallback chain:
**Open-Meteo → MET Norway → wttr.in → synthetic demo.**
Open-Meteo leads as the reference source (fullest field coverage); any
failure degrades to the next provider automatically, and the panel location
line names the provider that actually answered
(e.g. `Open-Meteo · 55.75°, 37.62°`, `MET Norway · … (manual location)`).
Measured from the Quest headset network, api.open-meteo.com can be
unreachable (10 s timeout) while api.met.no answers in ~111 ms — on such
networks the chain falls through to MET Norway without user action, and the
demo scenario appears only when every provider fails.

### Provider equivalence (live responses, 55.7558, 37.6173)

Native payload shapes, per `WeatherHour` field. “Native” = what the service
sends; “normalized” = what the chain stores (missing → `null`, never `0`).
`null` renders as `-- unit` on both panels and yields neutral scene drivers
(rain/snow/wind/gust 0, cloud 0.3, warmth/pressure/humidity/daylight 0.5,
code 0 with thunder/fog derived from it — see `driversFromFrame`).

| `WeatherHour` field | Open-Meteo (reference) | MET Norway `compact` | wttr.in `?format=j1` | Normalizer behavior |
|---|---|---|---|---|
| `temperatureC` (°C, instant) | `temperature_2m`, hourly, 120/120 present | `instant.details.air_temperature` (°C), 88/88 present | `tempC`, 24/24 present (numeric string) | direct; resampled to whole UTC hours |
| `apparentTemperatureC` (°C, instant) | `apparent_temperature`, 120/120 | — absent | `FeelsLikeC`, 24/24 present | MET Norway → `null`; wttr.in direct |
| `precipitationMm` (mm/h rate) | `precipitation`, mm **per hour**, 120/120 | `next_1_hours.details.precipitation_amount`, mm **per 1 h**; else `next_6_hours`/`next_12_hours` amount ÷ 6/12; else (instant-only tail) → `null` | `precipMM`, mm **per 3 h block**, 24/24 present | MET: exact hourly, or block rate; wttr: block ÷ 3 (e.g. `0.1` → `0.03` mm/h) |
| `precipitationProbabilityPct` (%, instant) | `precipitation_probability`, 120/120 | — absent | `chanceofrain`, 24/24 present | MET Norway → `null` |
| `snowfallCm` (cm/h rate) | `snowfall`, 120/120 | — absent (only snow symbols) | — absent (only day `totalSnow_cm`) | MET Norway + wttr.in → `null` (day totals are never distributed) |
| `weatherCode` (WMO-ish) | `weather_code`, native WMO (e.g. 61 = rain) | `symbol_code` string (`lightrain`, `heavyrain`, … + `_day`/`_night` stripped) → mapped table (e.g. `lightrain`→61) | `weatherCode`, WorldWeatherOnline code (e.g. 176, 113) → mapped table (e.g. 176→61; 149 haze→4, 152 smog→4) | three different dictionaries, one WMO-ish output; unknown → `null` |
| `humidityPct` (%, instant) | `relative_humidity_2m`, 120/120 | `relative_humidity`, 88/88 present | `humidity`, 24/24 present | direct |
| `isDay` (1/0) | `is_day` flag, 120/120 | — absent | — absent | computed by `solarIsDay` (solar elevation > −0.833°) at the hour + coords |
| `windSpeedKmh` (km/h, instant) | `wind_speed_10m` (km/h, requested unit), 120/120 | `wind_speed` (**m/s**) → ×3.6 | `windspeedKmph`, 24/24 present | MET Norway converts units; others direct |
| `windDirectionDeg` (° from) | `wind_direction_10m`, 120/120 | `wind_from_direction`, 88/88 present | `winddirDegree`, 24/24 present | direct; resampling takes nearest (circular), never interpolates across 0° |
| `windGustsKmh` (km/h, instant) | `wind_gusts_10m`, 120/120 | — absent (no gust field observed live) | `WindGustKmph`, 24/24 present | MET Norway → `null` |
| `cloudCoverPct` (%, instant) | `cloud_cover`, 120/120 | `cloud_area_fraction`, 88/88 present | `cloudcover`, 24/24 present | direct |
| `pressureHpa` (hPa, instant) | `surface_pressure`, 120/120 | `air_pressure_at_sea_level`, 88/88 present | `pressure` (mbar = hPa), 24/24 present | direct; note the different physical quantities (surface vs sea-level) |
| `visibilityM` (m, instant) | `visibility`, 120/120 | — absent | `visibility` (**km**) → ×1000 | MET Norway → `null`; wttr.in converts units |
| `time` (UTC instant) | `time` unixtime seconds, hourly past_days=2 + forecast_days=3 (120 h, 50 in-window) | ISO `time`, forecast-only, 1-hourly ×~60 then 6-hourly (88 entries, 26 in-window) | `date` + `time` HHMM **location-local wall clock** (3 d × 8 = 24 entries, 35 resampled grid hours), UTC = local − offset hint (IP service) or round(lon/15) | all resampled to whole UTC hours; no extrapolation — forecast-only providers leave past hours uncovered (`· beyond data`) |

Precipitation arithmetic, proven on one live rain event (2026-10-09T15:00Z):
Open-Meteo `precipitation` is already mm/h (0.1 at 15:00Z, rising 0.3 → 0.9
through 14:00–17:00Z, code 61). MET Norway `next_1_hours.precipitation_amount`
is the exact mm for the hour starting at the entry (0.2 at 15:00Z, then 0.7 /
1.3 / 0.7), while the same entry's `next_6_hours.precipitation_amount` (5.1)
covers the 6 h window — hence ÷6 outside our window, and instant-only tail
entries (e.g. 2026-10-17T12:00Z, no `next_*` block, no symbol) yield `null`.
wttr.in `precipMM` is per 3 h block: the matching block (1800 local = 15:00Z)
reports `0.1`, stored as `0.1 / 3 ≈ 0.03` mm/h per hour.

What is lost on fallback: Open-Meteo → MET Norway loses apparent temperature,
precipitation probability, snowfall, visibility, and wind gusts (all `null` →
`--`), weather codes become symbol-table approximations, pressure switches
from surface to sea-level, `is_day` becomes computed, and past-24h hours are
uncovered. MET Norway → wttr.in regains feels-like, probability, gusts, and
visibility (with converted units) but loses 1-hour native resolution (3-hour
blocks resampled) and weather codes become WWO-table approximations.


## Languages

Every user-facing surface is bilingual (English + Russian) with a manual
switch, presentation layer only:

- Dictionaries live in `src/weather/i18n.ts` (`en` + `ru` maps, `t(key)`
  lookup, `weatherCodeName`, missing-value/`beyond data`/`cached` wording).
  The data layer (`weather-data.ts`) stays English; known loader/demo phrases
  are mapped to display strings at the presentation boundary, unknown strings
  pass through untouched.
- Detection reads `navigator.language` (`ru*` → Russian, else English); an
  explicit override persists in `localStorage` under `weather-room.lang`.
- How to switch: click the `RU`/`EN` chip in the browser DOM panel header
  (`data-testid="lang-toggle"`), or the `RU`/`EN` button in the spatial
  panel's XR row (`lang-button` — a real UIKit button, controller-ray
  clickable, same 70 px control size, no layout or style changes). The switch
  persists in `localStorage` under `weather-room.lang` and re-renders both
  panels instantly. To reset to auto-detection (`navigator.language`,
  `ru*` → Russian), clear the `weather-room.lang` key.
- Manual location (headsets cannot use IP-geolocation): the DOM panel has a
  `Location` row — preset select (`LOCATION_PRESETS`), a `lat, lon` field
  (`parseLatLon`), `Set`/`Auto` (clear) buttons. Setting a location calls
  `setManualLocation(...)` and reloads like `Reload`; the status line shows
  the honest provider (`Live from MET Norway` / `Open-Meteo` / `wttr.in`,
  localized) and the location line is marked `(manual location)`. The
  spatial panel has a compact `Location` cycler (`location-button`) that
  steps through presets and reloads.


## Weather-to-scene mapping

| Variable | Source field | Scene behavior |
|---|---|---|
| Rain | `precipitation` mm/h → `drivers.rain` | Instanced soft-edged streak quads tilt with wind; short-lived splash rings use the sampled real-surface height grid. Rain accumulates into 14 shader-driven floor puddles with ripple/sheens. |
| Snow | `snowfall` cm/h → `drivers.snow` | Capability-scaled instanced flakes drift under wind and recycle on detected upward-facing surfaces. |
| Wind | `wind_speed_10m`, `wind_direction_10m`, `wind_gusts_10m` | 120 advected ribbon streaks with riding motes show mean flow; gust excess intensifies flow and rain tilt. The shared vector maps meteorological “from” to world “to”; it is not north-aligned. |
| Clouds / visibility | `cloud_cover`, `weather_code`, `relative_humidity_2m`, `visibility` | FogExp2 combines cloud, humidity and low-visibility/fog codes; a seven-layer sculpted cloud deck (400-pressure dust beneath it) drifts near the mapped room ceiling. Passthrough remains visible. |

This intentionally requests the main hourly scene variables, not every
Open-Meteo variable. UV/radiation, snow depth, daily sunrise/sunset, soil
conditions, and vertical pressure-level fields are not currently fetched or
visualized.

The timeline is a tactile exhibition instrument (`timeline-control` manifest
asset, deterministic parentless Object3D): a chamfered satin blue-steel
housing with a ceramic bezel and inset dark-glass channel, a cyan light guide
whose NOW→playhead segment follows the knob, hairline 6-hour ticks with
−24 / NOW / +24 stroke-glyph signposts, and a lathed knob (metal collar,
dished ceramic crown, emissive glow ring). The knob travels ±0.45 m ⇔
−24…+24 h and supports hand/controller proximity grab and ray/distance grab;
release within ±0.75 h snaps to NOW. Hover/grab states answer through the
cloned glow-ring/crown emissive and guide-fill opacity. On XR entry it is
placed once 0.8 m from the viewer, 0.4 m below the eyes, tilted up 16°, then
stays room-fixed (no floor re-anchoring). The panel has −6h/+6h, NOW and
Reload buttons as mouse/touch fallbacks; physical-device clicks remain
unverified.

## Typography

Brand typography matches staniverse.xyz: Unbounded (headings) and Geologica
(body) are vendored as OFL-1.1 files in `public/fonts/` (woff2 for the browser
DOM panel, ttf for the UIKitML spatial panel) with license texts in
`public/licenses/`. The 3D timeline signposts are authored stroke-glyph
geometry, not font rendering, so the manifest asset stays deterministic across
editor and application realms.

## Spatial-surface limits

Room sensing builds a 25 cm height grid from tracked XR planes/meshes. Rain
and snow particles can react to the highest upward-facing hit in a cell;
the grid is an approximation, not a rigid-body physics world or a complete
collider for every room surface. Puddles query near the lowest mapped room
height and appear only where an upward-facing floor cell was sampled.
Ceiling clouds use mapped bounds, not ceiling collision. If room geometry
is unavailable, the scene keeps its fallback volume; real-surface contact
is not claimed.

## Capability matrix + degradation policy

| Target | Enter flow | Surfaces | Hit-test | Particles | Still works without AR |
|---|---|---|---|---|---|
| Quest 3 (MR, primary) | Enter AR when `immersive-ar` is supported | planes + meshes when granted | yes when granted | full (2400 rain / 900 snow, 120 wind streaks + 150 sparks) | n/a (primary path is immersive) |
| Android Chrome WebXR AR (secondary) | Enter AR only when `navigator.xr.isSessionSupported('immersive-ar')` resolves true; otherwise the HUD keeps the Enter button disabled and says AR is unavailable | planes when granted, meshes only when granted (often absent) | only when granted | reduced (1200 rain / 400 snow, 60 wind streaks + 72 sparks) when mesh detection is not granted | flat 3D + full HTML HUD: timeline step/live/scrub, reload, location, language |
| Phones/tablets without WebXR | Enter AR disabled with an honest unavailable note | none | none | full desktop-class budget for the flat preview | flat 3D + full HTML HUD (same as above) |
| Desktop browser | Enter AR disabled unless an XR runtime reports support | none | none | full (2400 rain / 900 snow) | flat 3D + full HTML HUD; IWER covers dev previews |


### Phone-viewport verification (2026-10-08, emulator only, no physical device)

Measured in headless Chromium at exact CSS viewports against the managed runtime (`https://localhost:8081/`):

| Viewport | Panel bounds (x, y, w×h) | Touch targets (w×h) | Result |
|---|---|---|---|
| 390×844 portrait | (12, 163), 366×668.6 | lang 49.9×44, step-back 55.6×44, go-live 68.8×44, step-fwd 59.7×44, reload 96.4×44, slider 332×44, preset select 162×45, lat/lon input 207×45.2 | all ≥44px height; panel inside viewport (12+366=378 ≤ 390, 163+668.6=831.6 ≤ 844); no clipping/overlap; evidence `artifacts/mobile-portrait.png` |
| 844×390 landscape | (12, 12), 340×366 (short-height media query) | lang 49.9×44, step-back 54×44, go-live 66.4×44, step-fwd 57.9×44, reload 92×44, slider 314×44, preset select 162×45, lat/lon input 207×45.2 | all ≥44px; panel scrolls internally (`overflow-y: auto`, `max-height: 100dvh - safe areas`); evidence `artifacts/mobile-landscape.png` |
| 1280×900 desktop | (12, 271), 400×616.6 | same family, all heights 44–45.2 | panel clear of the 3D scene; evidence `artifacts/desktop-1280.png` |

ARIA: panel `aria-label` localized, info group `aria-live="polite"`, timeline/step/reload/language buttons labelled, range `-24..24` with localized label; location Set/Auto now labelled (`Set manual location` / `Clear manual location`). Enter-AR probe in this Chromium reports `immersive-ar` support available with hint text; on phones/browsers without WebXR the same probe disables Enter and shows the honest `xrUnavailable` note — that disabled state is code-verified, not screenshot-verified here.

## Verified in this workstation session

`npm run typecheck` and root `npm run build` passed. The build assembled
4 experiences into `_site/`; Vite warned about Zod annotations and bundle size.

- Managed IWSDK runtime entered IWER `immersive-ar`; `xr status` reported
  emulated hand tracking, hit-test, plane detection, and mesh detection.
- Distance grab on `Weather Timeline Handle`: an aimed emulated controller
  trigger produced `Hovered`/`Pressed`/`Grabbed`; dragging the held knob
  moved the panel playhead to `+24h` (read live from the spatial panel);
  releasing re-seated the knob on the rail at the scrubbed hour. A release
  outside the ±0.75 h snap zone stayed at `+3h`. Snap-to-live, exact X→hour
  mapping, and re-seat are additionally proven deterministically by
  `screen-input-smoke.html` through the real TimelineSystem.
- The spatial panel is a world-space UIKitML surface; the browser DOM panel
  is separate native HTML. `screen-input-smoke.html` proves a synthetic
  unhanded XR screen ray clicks the real UIKit `+6h` button (playhead 6),
  tracked-pointer selects are not double-handled, controls stay room-fixed
  through focus transitions, recenter on a new session, and the DOM controls
  return immediately after `sessionend`. Desktop DOM controls were exercised
  headlessly (step/live/scrub to 24h). Physical Android touch remains
  unverified.
- `asset render-preview` for `timeline-control` (material + clay): 15 meshes,
  2930 triangles, all 17 named parts present; two standing warnings are
  accepted (40 degenerate triangles in the lathe dish pole; additive layers
  intentionally DoubleSide).
- The bezel occlusion finding from technical review was fixed (four-rail
  open frame) and proven by a front-facing raycast at rail heights 5–20 mm:
  first hit along the channel corridor is `SlotFloor`, never an opaque part;
  the knob reads first only at its own position. Signpost/tick hairline
  contrast was raised after design review. Design and technical reviews are
  complete; their optional art-direction experiments (panel chrome reduction,
  dominant wind gesture) are deferred.
- A direct Open-Meteo request verified the request window spans more than
  24 hours before and after NOW. The implemented hourly query requests
  temperature/apparent temperature, precipitation/probability, snowfall,
  WMO code, humidity/daylight, wind/direction/gusts, clouds, pressure and
  visibility.
- Surface reactions use a 25 cm sampled height grid, not rigid-body room
  colliders. This IWER run did not have real room geometry; real floor
  puddle placement and Quest/Android surface sensing remain hardware checks.

Physical Quest 3 passthrough, Android browser behavior/permissions, surface
coverage, comfort, and standalone performance remain unverified. IWER does not
prove those device-specific behaviors.
