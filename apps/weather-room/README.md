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
  panel's compact utility row (`lang-button` — a real UIKit button,
  controller-ray clickable, one of four 80 px buttons). The switch
  persists in `localStorage` under `weather-room.lang` and re-renders both
  panels instantly. To reset to auto-detection (`navigator.language`,
  `ru*` → Russian), clear the `weather-room.lang` key.
- The browser AR capability hint (`xr-note`) also follows language changes
  using the cached support result, without repeating the capability probe.
  A live browser pass verified RU -> EN -> RU after the probe completed.
  The timeline label and both control-group accessible names follow the same
  switch; +6h and NOW remained functional during that browser pass.
- Manual location (headsets cannot use IP-geolocation): the DOM panel has a
  `Location` row — preset select (`LOCATION_PRESETS`) with a
  `Choose a city` placeholder, a `lat, lon` field (`parseLatLon`),
  `Set`/`My location` (clear) buttons. Setting a location calls
  `setManualLocation(...)` and reloads like `Reload`; the status line shows
  the honest provider (`Live from MET Norway` / `Open-Meteo` / `wttr.in`,
  localized) and the location line is marked `(manual location)`. The
  spatial panel opens an in-panel city chooser from its `Location` button
  (see *Showing the weather for your own place* below).


## Weather-to-scene mapping

| Variable | Source field | Scene behavior |
|---|---|---|
| Rain | `precipitation` mm/h → `drivers.rain` | Instanced, head-facing streaks tilt with wind; square-root display-density scaling keeps light rain legible. Streaks are 14 mm wide with a chromatic-fringe core and dissipate with distance (`clamp(1.2/(1+0.3d)·e^(-fog·6d), 0.3, 1.2)`), so the near/far apparent-thickness ratio measures 3.0 instead of 1.0. Splash hits are a six-ray comb lifted 3 cm along the surface normal. Puddles require mapped floor cells. |
| Snow | `snowfall` cm/h → `drivers.snow` | Head-facing flakes drift under wind and settle for 1.2 s on mapped surfaces before recycling. Providers without snowfall use their snow weather code plus precipitation for visual classification only; the missing numeric snowfall still displays `--`. |
| Wind | `wind_speed_10m`, `wind_direction_10m`, `wind_gusts_10m` | 120 advected ribbon streaks with riding seeds/leaves show mean flow; torn fibre bands replace the smooth tails, and gust excess intensifies flow and rain tilt. The shared vector maps meteorological “from” to world “to”; it is not north-aligned. |
| Clouds / visibility | `cloud_cover`, `weather_code`, `relative_humidity_2m`, `visibility` | FogExp2 combines cloud, humidity and low-visibility/fog codes. One thick cloud slab ray-marches the shared 128×128 noise atlas vertically; the sample count is adaptive off a seeded frame-time EMA (4 samples only below 0.85 × 13.9 ms, 2 above 1.05 × 13.9 ms, each switch logged with the measured frame time). The dead flash branch is live again: a `WeatherEvent.Thunder` listener and the storm-hour schedule drive one Gaussian pulse that lifts sun/fill, thickens the fog and tints it. Dust motes are gated by the light shaft instead of pressure. |
| Light shaft | `daylight`-derived sun + `cloud_cover` | One additive cone (1 draw call, 64 triangles) pins its apex to the sun and drives the shared beam uniforms every frame; rain brightness, wind fibres, snow gating, dust motes and the puddle specular all read the same beam, so the room has one light source instead of per-layer colours. |
| Puddles | `rain` history + mapped floor cells | An analytic sky mirror, not a render target: noise-built water normal, `reflect(-V, n)` graded from horizon to zenith tone, one narrow beam specular and a rim fresnel that lifts alpha. No SSR, no full-screen pass. |

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
placed once 1.05 m from the viewer, 0.4 m below the eyes (below the panel
and its Control Bar), tilted up 16°. The panel has −6h/+6h, NOW and Reload
buttons as mouse/touch fallbacks; physical-device clicks remain unverified.

### Moving spatial controls

The panel and the timeline rail follow the Horizon OS window pattern instead
of a permanent handle: a rest-invisible 22 mm Control Bar plaque (the platform
48 dp floor) sits centred below each surface — the panel and the rail each get
one plaque and nothing else — hovering anywhere on the surface reveals it
(hover white `#FFFFFF`, press/select `#001E78`, 0.3 s / 0.08 s / 0.1 s
smooth-step transitions, enter/exit hysteresis). The visible plaque never
raycasts; two invisible collision shells per element do — one for near input
(controller squeeze or hand pinch, `useHandPinchForGrab`) and one for the
controller-ray trigger. Targets are built to hold >=3 deg of subtense out to
3 m, which is why the bars can stay thin. Hover/hold glow, audio cues and
controller haptics acknowledge the gesture, and haptics fire only into the
holding hand.

Carry keeps the platform's kinematic rule — exact 1:1 tracking, no physics —
while the panel turns itself to face the viewer (yaw and pitch follow the
view vector, roll pinned at 0) and keeps its apparent size constant by scaling
the physical size with distance (eased, clamped 0.6x..2x). The rail faces the
viewer the same way but keeps its authored 16 deg up-tilt. The pointing laser
dims while a distance drag is active so it never obscures the carried surface.
Release parks the control exactly where it was left; hovering or moving a hand
afterwards never moves it, and moving the rail never scrubs time.

Squeezing anywhere on a surface to move it is an app-specific extension, not a
platform-parity claim: Meta documents moving a panel by grabbing an edge or the
Control Bar. The app implements the shortcut by routing the squeeze into the ray
pointer's distance-grab handle, which uses `MultiPointer` members outside the
documented public surface (`getPointer('ray')`, `setIntersection`, `commit`,
`routeDown`, `routeUp`; the documented surface is `toggleSubPointer`,
`getSubPointerState`, `getActiveKind`, `getRayBusy`). Those reads are
version-bound to IWSDK 1.0.1 and every call is guarded, so a missing member
degrades to the standard paths — the Control Bar plaque and the ray trigger —
instead of failing silently. Promotion is refused while that hand already owns a
grab, so a trigger-held scrub is never hijacked, and the routing latch is
cleared on source loss or session exit.

Released positions persist for the current XR session, including focus
transitions. A new XR session places the panel 1.4 m forward / 0.18 m above
the viewer (scene scale 0.18) and the rail at its placement described
above; positions are not saved across sessions. Near and ray grab components
use separate entities: the SDK installs only one grab handle per entity.

The spatial `Место` / `Location` button swaps the panel to an equal-height
city chooser: six preset cities in a 2-column grid, `Моё место` (auto:
device/IP) and `Назад` (back). Tapping a city sets the manual location,
closes the chooser, and reloads; the provenance line shows the result
(e.g. `Tokyo (вручную)` then `Эфир: Open-Meteo`). The browser HUD keeps the
full row — preset select with a `Choose a city` placeholder, `lat, lon`
entry, `Set`/`My location`. The location line always names the provenance:
`55.86°, -4.25° (вручную)` for manual coordinates, `По IP (Berlin)` for
IP-based lookup, and `устройство` when the device geolocation answers. Auto
lookups depend on the network: on the test headset network the IP lookup
resolves to Berlin, which the label shows honestly rather than pretending
it is the viewer's city.

Short viewports: the browser HUD switches to a compact layout below 700 px
height (the Quest Browser window is ~587 px tall): the card is a flex
column whose body scrolls while Reload / Enter AR / Exit live in a fixed
footer outside the scroll area, so actions stay reachable and scrolled
content can never sit under them. Compact tiers tighten rhythm below
700 px and 560 px of height while keeping 44 px touch targets. The spatial
panel keeps all utility controls
(Reload / Location / RU / Exit) in one compact 4-button row of 80 px
kit-floor buttons, centered on the 340 px panel.

## Typography

Brand typography matches staniverse.xyz: Unbounded (headings) and Geologica
(body) are vendored as OFL-1.1 files in `public/fonts/`, with license texts in
`public/licenses/`. The DOM panel loads Latin and Cyrillic WOFF2 subsets by
`unicode-range`. The spatial panel uses TTF faces with explicit Cyrillic-aware
MSDF loaders in `src/weather/spatial-fonts.ts`; the SDK's default TTF loader
otherwise generates an ASCII-only atlas, even from a Cyrillic-capable TTF.
Russian copy was visually checked on both surfaces, not only in font files.
The 3D timeline signposts are authored stroke-glyph
geometry, not font rendering, so the manifest asset stays deterministic across
editor and application realms.

## Spatial-surface limits

Room sensing rasterizes triangle interiors into a 25 cm height grid, including
the interiors of sparse four-vertex XR planes. Triangle setup and cell tests
share a 4096-work-unit frame budget; large triangles resume across frames.
Rain splashes and briefly settled snow use the highest upward-facing height
in each cell. This is an approximation, not a rigid-body collision world.
Puddles require mapped floor cells; ceiling clouds use bounds, not collisions.
A floor-only scan still leaves precipitation-source height above the viewer.

Without tracked planes/meshes, five persistent, capability-gated hit-test
probes sample nearby floor/table cells every 0.5 s. The first hit does not
disable sampling. Only measured cells supply real-surface contact; unsampled
space retains the explicit fallback. No public world-space depth API was
found in this installed SDK, so this path uses environment hit-test, not
invented camera/LiDAR geometry.

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

Touch scrubbing was exercised with trusted Chromium touch events at 390×844
and 844×390: tap into future time, drag to −24 h, and return to NOW. The range
owns horizontal pointer gestures (`touch-action: none`, pointer capture);
keyboard End still reaches +24 h. These are emulated-phone checks, not
physical Android/iOS evidence.

### Current weather-render fixes: local evidence, hardware limit

An isolated run of the real RainSystem/SnowSystem/AtmosphereSystem verified
0.3 mm/h rain produced 464 streaks, nonzero compositable pixels in four view
directions, 48 splashes at a sparse table fixture's 0.7 m surface, and 31
temporarily settled snowflakes. Rendered cloud alpha rose from 0 at 0% cover
to 4,277,571 summed byte-alpha at 100% cover; wind moved the cloud deck.
Those render-target totals describe that fixture, not headset performance.
The first measured hit remained available after the probe sampler updated.

Cloud fragment work was reduced from seven layers of nine simplex-noise
evaluations per pixel to three layers sharing one RG texture sample. The
room-grid rebuild is bounded too.

### Physical Quest 3 check (2026-10-08, serial 2G0YC5ZG5203DD)

Rain visibility was verified on the real headset in `immersive-ar` (Rome,
`NOW`, thunderstorm, 2.9 mm/h live Open-Meteo). Three Meta Cam captures
(`artifacts/xr-rome-rain-1..3.png`, JPEG payloads) were captured ~2 s apart
and measured: 141-145 tall thin blue-bright vertical runs per frame (rain
streaks), and 1.77% / 0.81% of pixels changing between frames with the same
hot regions - animated falling streaks while the static room contributes
almost nothing. Mean luma ~76 (normal passthrough view). Device logcat
showed no render errors during the run. The earlier "no rain" report was a
data state: the stored manual location showed 0.0 mm/h at that hour, so there
was nothing to render.

Local capture notes: Android `screencap` writes empty files on this device
(VR compositor), so captures use Meta Cam through `metavr capture screenshot`
and are written as JPEG with a `.png` extension. The headset sleeps on
standby and ends the XR session; automation keeps it awake with
`svc power stayon` plus proximity broadcasts. A wedged XR daemon (session
ended by sleep) rejects session requests with "session configuration is not
supported" until the browser process is restarted.

Still unverified on hardware: disappearance of the reported cloud freezes,
frame pacing/comfort during storm conditions, and splash contact against the
user's own furniture (splashes use the sampled room grid; the capture room
was not scanned in this run).

A second device run on the published `9e39226` build re-checked the same
scenario with a 3.9 mm/h thunderstorm: 161-172 vertical streak runs per frame
and 1.29-1.42% inter-frame pixel change (denser than the 2.9 mm/h run, as the
density ramp predicts). Device captures: `artifacts/device-rain-final-1..3.png`;
the pre-fix layouts: `artifacts/device-panel-2d-new.png`,
`artifacts/device-xr-new-ui-1..2.png`.

### Real-world depth occlusion (2026-10-09, IWER only)

`iwsdk.config.json` requests `depthSensing` (`usage: gpu-optimized`,
`format: float32`) as an **optional** feature: a denied Spatial permission or a
runtime without depth then degrades to "no occlusion plus one console warning"
instead of failing the AR session. `src/index.ts` registers the framework
`DepthSensingSystem` (`enableOcclusion`, `enableDepthTexture`, `blurRadius: 20`)
and `DepthOcclusionSystem`, which owns the app's depth texture for the custom
weather shaders.

Scope, explicitly: **this app has no virtual room geometry.** The walls, floor,
couch and tables are real passthrough — the only virtual 3D content is the
weather volume and the two UI surfaces. What gets occluded is therefore the
weather layers (rain streaks, snow flakes, wind streaks and sparks, cloud
plates, dust), which is exactly the owner's complaint of weather passing through
furniture. What is deliberately **not** occluded is the UI: the weather panel and
the timeline rail. Horizon OS never hides its own windows and controls behind
real geometry, because a control that can be occluded stops being reachable, so
both surfaces follow the system rule. Nothing in the app carries
`DepthOccludable`; the framework `DepthSensingSystem` is registered for its
depth feature diagnostics only — `enableDepthTexture` and `enableOcclusion` are
false, so it uploads no texture of its own, and the one depth texture that is
actually sampled belongs to `DepthOcclusionSystem`.

The app carries its own depth path because the framework's `DepthOccludable`
injection is written against three's built-in material shaders and derives the
virtual depth from `modelViewMatrix * vec4(position, 1.0)` — the mesh origin for
every instance of an `InstancedMesh`, and a silent no-op on a raw
`ShaderMaterial`. `src/weather/depth-occlusion.ts` injects an equivalent but
instance-correct test through `onBeforeCompile` (interpolated `gl_Position.xyw`,
sampled per stereo view). Rain splashes and puddles stay unoccluded on purpose:
they are decals anchored to the sampled real surface, where a depth test against
that same surface would flicker them away.

Measured in IWER (`metaQuest3`, `living_room`), head at (0, 1.6, 0) aimed at the
couch and table, ECS paused so both frames contain identical particles:

| Check | Result |
|---|---|
| feature granted | `enabledFeatures` includes `depth-sensing`; no `depth-sensing feature not enabled` warning |
| pipeline | `[weather-room] real-world depth occlusion active (usage=gpu-optimized format=float32 191x121 rawValueToMeters=1 depthNear=0.1 eyes=2)` |
| framework path | `DepthSensingSystem` live with `blurRadius: 20`; no entity carries `DepthOccludable` (UI exclusion above) |
| occlusion on vs off | frozen frames differ by 1687 px (0.46% of the frame), every changed pixel on a rain streak or a cloud-plate silhouette cut; the on-frame keeps only the few streaks in front of real geometry while the off-frame shows the full field (`artifacts/xr-depth-frozen-on.png`, `artifacts/xr-depth-frozen-off.png`, amplified difference `artifacts/xr-depth-diff.png`) |

The A/B frames were captured while the timeline rail still carried
`DepthOccludable` (since removed for the UI rule above). They stay valid for this
measurement: the staged view looks at the couch and table with the rail out of
frame, and the difference image contains only streak-shaped marks and cloud
silhouette cuts — no rail-shaped region.

Not measured here: `SoftOcclusion` vs `MinMaxSoftOcclusion` cost (the MinMax
preprocessing pass needs a source flip plus a full reload, which the shared
runtime window did not have), and frame cost generally. Still needs a physical
headset: the Spatial permission prompt and its denial path, real Quest depth
quality/blur, and the depth-image transform actually shipped by the device (the
shader applies the runtime's `normDepthBufferFromNormView` and only falls back to
the plain convention when the runtime hands over an identity stub), the
right-eye depth layer on a non-multiview stereo renderer, and occlusion
behaviour while grabbing.

#### Device format reality: why the first headset run showed no occlusion (2026-10-09)

The first physical run logged `active` and still drew rain over the beds. The
device session reported `usage=gpu-optimized format=unsigned-short 320x320
rawValueToMeters=1 depthNear=0.1`, and that is where the two environments part:
the WebXR Depth Sensing Module's format table gives `unsigned-short` the WebGL
format **R16UI** — an *integer* texture, "inspect Red channel and use the
value" — while `float32` is R32F and `luminance-alpha` is LUMINANCE_ALPHA with
the least significant byte in luminance. The shader sampled every format through
a float `sampler2DArray`, so on the device the sampler and the texture class did
not match, every read came back 0, and the module's own "0 means invalid depth"
rule turned the mismatch into "no occlusion at all" — silently, with the
pipeline reporting healthy.

What changed for it:
- The injected shader now declares the sampler the format needs (`usampler2DArray`
  for `unsigned-short`, `sampler2DArray` otherwise, with the 16-bit reassembly
  reading `.rg` — the CPU path's texture is packed RG/UnsignedByte, and the
  high byte lives in green while alpha is padding that reads 1), and
  `setDepthTextureKind` recompiles the effect materials
  when the session's format becomes known, because a sampler type is fixed at
  compile time. The kind is dropped back to `float` together with the depth
  texture at session exit, so a null texture can never leave an integer
  sampler asking three to bind its RGBA placeholder per draw.
- Decoding follows the spec (`raw × rawValueToMeters`, 0 = invalid) with the
  near-plane-relative variants kept as explicit, named alternatives, every
  division guarded. Which one is live is not guessed: `DepthOcclusionSystem`
  reads a spread of raw texels back from the live image (framebuffer readback on
  the GPU path, the WebXR buffer on the CPU path), scores each candidate by
  whether it yields room-sized distances, applies the winner and logs it.
- `normDepthBufferFromNormView` is now the source of truth for depth-image
  coordinates, applied to the spec's normalized view coordinates (origin
  top-left, y downward). The plain convention remains the fallback for runtimes
  that hand over an identity stub — the emulator does, and applying a no-op
  matrix to already-correct UVs would flip the image.
- Every probe logs a control value that can be read on the device without eyes:
  `[weather-room] depth probe: format=... kind=... decode=... matrix=on|off
  raw[center]=<raw> -> <m>m raw[min..max]=... plausible=<%>`.

| Environment | Depth format | What is proven |
|---|---|---|
| IWER (this workstation) | `float32` (R32F, unitless inverse depth, identity transform) | feature granted, pipeline live, occlusion A/B, and that the fallback path still works after the rewrite |
| Quest 3 (owner's session) | `unsigned-short` (R16UI, `rawValueToMeters=1`, `depthNear=0.1`, 320x320) | format + geometry facts only; the fix itself is **unverified until the next headset run** |

Unverifiable in IWER, to check on the headset with the probe line: that an R16UI
texture is accepted by the injected `usampler2DArray` in the XR context, the
texture type (TEXTURE_2D vs TEXTURE_2D_ARRAY with an `imageIndex`), which decode
the probe selects (the raw samples in the line decide it), the real
`normDepthBufferFromNormView`, the readback's colour-renderability, and whether
the per-eye layer/transform split holds on a non-multiview stereo renderer.

#### Deviations from the depth-occlusion skill, and why

The skill (`iwsdk-depth-occlusion`) documents the framework path: request
`"depthSensing": { "required": true, "usage": "gpu-optimized", "format":
"float32" }`, register `DepthSensingSystem` with `enableDepthTexture: true,
enableOcclusion: true, useFloat32: true, blurRadius: 20`, and put
`DepthOccludable` on the intended scene nodes. This app deviates in four places,
each for a recorded reason:

- `required: false` instead of `required: true`: IWSDK's `launchXR` has no retry
  on a rejected `requestSession`, so a denied Spatial permission would fail the
  whole AR entry instead of degrading. The ticket for this work asked for
  graceful degradation.
- `enableDepthTexture: false, enableOcclusion: false` on the framework system:
  the app owns the depth texture that is actually sampled, so the framework's
  copy would be an unused per-frame upload. It stays registered for its feature
  diagnostics (and its "depth-sensing feature not enabled" warning).
- No `DepthOccludable` anywhere: per the UI-availability rule above, the app's
  only non-UI 3D object is the timeline rail, which must not be hidden.
- A hand-written injection instead of `DepthOccludable` for the weather layers:
  the skill's own note ("The depth occlusion feature may not be compatible with
  custom shaders") plus the instancing flaw above make the framework path a
  silent no-op there.

The skill also says not to inspect framework source when the build, registered
systems, entity components and console warnings already establish the failing
layer. Those signals said the pipeline was healthy while the headset showed no
occlusion, so the failing layer had to be established from the format contract
instead; the framework's own shader was read to confirm it shares the
float-sampler assumption, which is why the framework path fails on the device
too and why this module owns its own decode.

## Verified in this workstation session

`npm run typecheck` and root `npm run build` passed. The build assembled
4 experiences into `_site/`; Vite warned about Zod annotations and bundle size.

- Managed IWSDK runtime entered IWER `immersive-ar`; `xr status` reported
  emulated hand tracking, hit-test, plane detection, and mesh detection.
- The time knob's near controller squeeze, hand pinch, and separate
  `Weather Timeline Ray Handle` trigger paths all produced `Grabbed`.
  Near and ray controller drags each set `+12h`; hand and ray drags back
  snapped to NOW. The visible knob remained on the rail after release.
  `screen-input-smoke.html` additionally verifies exact X→hour mapping,
  snap-to-live and re-seat through the real TimelineSystem.
- Both whole-control bars were moved and released through controller
  proximity grab, hand pinch, and ray grab. For example, a controller move
  `(0.20, 0.10, 0.05)` moved the panel from `(0, 1.90, -1.50)` to
  `(0.20, 2.00, -1.45)` without moving the rail; a rail move
  `(-0.18, 0.07, -0.05)` left the panel and NOW playhead unchanged.
  Later hand/ray moves also retained released positions. A real IWER
  exit/re-entry restored both initial placements.
- 2026-10-08 repair pass (all in IWER `immersive-ar`): `RainSystem` had been
  imported but never registered — registration restored (28 live systems);
  with providers blocked the demo scenario (4 mm/h) rendered visible falling
  streaks across the room (`artifacts/xr-rain-now.png`). The panel move bar
  no longer self-rotates: a static held controller leaves the panel yaw at
  exactly 0°, a deliberate wrist yaw of +50° turns it exactly +50° (pitch
  and roll 0), a ray drag across 0.4 m / 0.3 m translates 1:1 with yaw
  locked at 0°, and hover alone never moves anything. (Superseded on
  2026-10-09: the wrist-yaw coupling was replaced by the viewer-facing
  carry described under "Moving spatial controls".) Ray-dragging the time
  knob set +16 h and −5.5 h; releasing within ±0.75 h snapped to NOW. The
  spatial location chooser opened, closed (Back), and selected Tokyo through
  real ray clicks, with the live provider answering afterwards. The spatial
  language button switched EN↔RU and the browser HUD followed. Browser HUD
  rows are equal-width grids (3-column timeline and location rows); the
  utility row is a flex row with equal columns for 2 or 3 visible buttons.
- Russian glyphs rendered on the browser and spatial panels. App-only
  captures: `artifacts/browser-ru-fixed.png`,
  `artifacts/spatial-controls-ru-fixed.png`; compact two-surface evidence:
  `artifacts/ui-runtime-review.jpg`. The managed console reported no font
  or missing-glyph errors during the checks.
- 2026-10-09 card polish pass (IWER): nine measured layout defects fixed on
  both surfaces and both languages - the RU preset button no longer clips
  (short label `Петербург` on the spatial picker, 140 px buttons), secondary
  XR text is 12 px+ with >=4.5:1 contrast (`#a6bcd9` 5.6:1 on the panel),
  the picker content is vertically centered (no dead bottom), the DOM
  utility row lost its orphan button, empty error paragraphs collapsed, and
  section rhythm is 8/16/24. The picker was opened and closed through real
  MCP controller rays in EN and RU after the changes
  (`artifacts/ui-fix-picker-live-{en,ru}.png`); hover over the move grip
  still never moves the panel; `screen-input-smoke.html` passes; no new
  font/glyph/parse errors in the managed console.
- 2026-10-09 carry/rotate pass (IWER, scripted controller through the CLI):
  near squeeze on the blue plank grabs at touch range (0.045 m engages,
  0.18 m does not - near means near), then the panel follows the hand 1:1 on
  all three axes: +0.4 m X translated +0.400 m, and a walk-away carry of
  dX=-1.18/dY=+0.034/dZ=+2.015 moved the panel by exactly the same vector
  (parked at (-0.78, 1.81, 0.62), ~2 m from its start). Wrist yaw couples
  relative to the grab pose, 1:1 and reversible (wrist 0->40 deg rolled the
  panel -40->0 deg in 10 deg steps); pitch/roll do not follow. The far ray
  grip hovers then trigger-grabs at 0.55 m and ray-drags translate-only,
  1:1 (+0.35 m drag -> +0.350 m), wrist yaw while ray-held leaves the panel
  untouched. The timeline rail grip carries 1:1 as well (-0.45 m -> -0.450).
  Release parks the surfaces in place; moving the hand afterwards never
  disturbs them (`artifacts/grab-near-carried.png`, `grab-far-ray.png`,
  `timeline-carried.png`, `grab-final-state.png`, `grab-reset-state.png`).
  (Superseded on 2026-10-09 by the move-affordance rework: the surfaces no
  longer carry a permanent plank, and wrist yaw no longer turns them - the
  panel and rail face the viewer automatically. The measurements above still
  document the kinematic 1:1 carry rule, which the rework preserves.)
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

## Move affordance (Control Bar) and draw order

The panel and the rail each expose one hover-revealed Control Bar plaque below
their surface (no permanent bar, no edge handles, no move hint): rest draws
nothing, hover draws it white, a grab turns it #001E78, and a grab also turns
the control toward the viewer (yaw + pitch, roll 0), keeps its angular size
across depth translation, and pushes/pulls it along the view ray from the
holding hand's thumbstick (0.4 m to 3 m). A `Handle.inputState`-verified IWER
run covers the bar grab, the carry and the pull; haptics and audio were not
felt (the emulator has no actuators).

Depth order between the panel, the rail and the plaque is only verified in
IWER: the panel's UIKit surface, the plaque and the opaque rail parts now write
depth, while the additive light guide, the endpoint glows and the knob glow
ring stay transparent with `depthWrite: false`. Whether this removes the
reported frame-to-frame flip of the rail strip over the panel's lower rows
needs a real headset pass — the sequence of device captures that showed the
defect (seq-8/seq-9/seq-10) cannot be reproduced in the emulator.

## Tracked-hand occluder

Real-world depth occlusion tests the weather against the room's depth image,
which never contains the user's hand, so rain fell straight through a tracked
hand. `hand-occluder.ts` closes that gap with geometry instead of shaders: one
`InstancedMesh` of 8x6 spheres per hand, anchored to the framework's own hand
model by joint name (17 anchors: wrist plus the four metacarpals for the palm,
four tips, four distal phalanges and three thumb joints), rendered with
`colorWrite: false`, `depthWrite: true` and `transparent: false`. It draws in
the opaque pass, so the transparent weather layers behind it fail their depth
test and are cut.

Measured: 2720 triangles and +2 draw calls with two hands, 160 triangles and
+2 draw calls in controller mode (one larger sphere on `player.gripSpaces`),
0 with neither. Proxies are created and dropped as input sources come and go —
an IWER run switching `hand` to `controller` moved the entities from
`hand-occluder-<side>-hand` to `hand-occluder-<side>-controller` without
leaking. `raycast` is disabled so the proxy never intercepts poke/ray/grab, and
it is not frustum culled because its bounds do not describe the instances.

Consequence worth knowing: because the proxy is opaque geometry, it also cuts
the panel where a hand is closer to the camera than the panel. That is the
physically correct reading in passthrough (a UI panel should not draw over your
real hand) but it is a behavioural change for the UI, and the occlusion of the
panel by a hand has not been seen on hardware yet.

## Hand interactions

Five surfaces, all sharing one input-layer read of the hand rig (systems 2.7-2.9,
before the weather visuals at 30.5-36.5):

- **Occlusion** (`hand-occluder.ts`): depth-only proxy spheres, so rain and snow
  are cut by a tracked hand (details above).
- **Push field** (`hand-field.ts` + `hand-field-system.ts`): up to four capsule
  SDFs (palm radius 0.06 m, forearm 0.05 m, controller grip 0.07 m) folded into
  the layer's own vertex shader, so a hand shoves rain streaks and dust motes
  aside instead of passing through them. Rolled out per layer through
  `HAND_FIELD_LAYERS`: rain and dust on, wind and snow implemented but off until
  the first two are seen on hardware. With no hands the uniforms stay empty and
  the shader cost is exactly zero.
- **Clap = thunder** (`gesture-sandbox.ts`): palm anchors (middle-finger
  metacarpal, wrist fallback, controller grip fallback) with a distance and a
  closing-speed threshold plus a cooldown; a clap emits the existing
  `WeatherEvent.Thunder`, which the audio rumble and the cloud flash already
  listen to. It fires only in **sandbox mode**; outside it, thunder still comes
  from the weather code (WMO >= 95). Every fire is confirmed by audio (hands
  have no haptics - Meta's hands guidance), and controller sessions also get a
  haptic pulse.
- **Poke** (`panel.ts`): `PokeInteractable` on the panel entity, so a fingertip
  touch drives the same `Hovered`/`Pressed` path as a ray, with a mode-pill tint
  on hover and a flash plus click cue on press.
- **Pinch scrub** (`timeline.ts`): an invisible 0.90 x 0.02 x 0.02 m strip over
  the rail with `OneHandGrabbable`; a pinch anywhere on the scale scrubs with the
  existing ±0.45 m ⇔ ±24 h mapping and the ±0.75 h snap-to-live. The strip rests
  at rail-local 0, so its measured X is the hand's displacement since the grab
  started; the mapping adds the playhead's rail-local X captured at grab start,
  which makes the scrub relative and keeps the playhead where it was instead of
  snapping it to NOW. It fires a detent impulse on every hour crossed, and the
  strip is pinned back to rest each held frame so a grab can never drag it out
  of place. The ray and knob paths are unchanged and stay absolute.

Sandbox mode is a store flag with a `SandboxToggle` event; its switch is the
panel's existing hint row (runtime name `weather-toggle-sandbox`), which flips
its text and colour instead of adding a new UIKitML control. Gaze tracking is
deliberately not enabled: it is an optional descriptor, and gaze+pinch would be
an add-on to the strip rather than a required path.

### Hands wave verification (2026-10-10, managed IWER, by query)

- Registration: `ecs_list_systems` reports `HandOccluderSystem` 2.7,
  `HandFieldSystem` 2.8 and `GestureSandboxSystem` 2.9 among 33 systems, none
  paused, all running from boot through ~17.5k frames with no hands connected
  and across hand/controller switches, with no app errors and no InputSystem
  BVH warnings.
- Poke: `PokeInteractable` is on exactly one entity, `Weather Panel`. With the
  index tip ~10 cm away the panel carries `Hovered`; at ~1 cm from the surface
  (inside the 2 cm touch down-radius) it carries `Hovered` and `Pressed`, and
  the press-edge impulse entity moved to the mode-pill anchor.
- Sandbox + clap: a controller ray select on the hint row flipped its text from
  `-24H < KNOB / BUTTONS > +24H` to `CLAP = THUNDER · TAP TO TURN OFF`, copy
  that is only written while `sandbox` is true. With the ECS frozen, palms
  0.156 m apart did not fire (the false-positive guard held) and palms 0.089 m
  apart did: the clap impulse appeared at the exact midpoint of the two measured
  palm anchors. `fire()` emits `WeatherEvent.Thunder` in the same statement that
  triggers the impulse, and its synchronous listeners are the audio rumble and
  the cloud flash.
- Pinch scrub: the strip (entity `Weather Timeline Pinch Scrub`) grabs on
  squeeze and a drag to rail x = 0.4 moved the playhead from `NOW` to
  `16:41 / +16h`, which is exactly the ±0.45 m ⇔ ±24 h mapping; the strip's own
  transform stayed bit-identical to rest while held, and the knob followed to
  rail x = 0.30. Hand pinch is not drivable through the emulator API
  (`xr_set_gamepad_state` rejects hand devices), so this used the controller
  squeeze on the same grab path.
- Coexistence: after all gesture activity both `hand-occluder-*-hand` proxies
  were still alive, so the occluder and the push field share the rig without
  either tearing the other down.

Not yet seen on hardware: the real feel of the clap threshold, the poke
down-radius with a real fingertip, whether the pinch scrub detent is felt as a
detent, and how dense the occluder proxy spheres look around an actual palm.

## Atmosphere pass: measured evidence and hardware limits

Managed IWER, same location/hour and the same entry pose before and after the
pass: draw calls 102 → 100, triangles 48 092 → 48 964, points 1000 → 0,
programs 24 → 25, textures 13 → 14, shadow casters 0 → 0. Frame time on this
uncalibrated host (ANGLE over Intel UHD 620) is p50 36.1 ms, so the cloud
ray-march runs its documented 2-sample fallback and logs
`cloud ray-march 2 samples (measured frame 16.8 ms)`; four samples are only
adopted below 0.85 × 13.9 ms and were not reached here. Rain apparent thickness
(near/far median, fixed 764x485 frame) moved from a ratio of 1.0 — every streak
aliasing to a single pixel, which is what read as a screen-space overlay — to
3.0, with a 7.5 mm streak widened to 14 mm because a 1.9 mm core is sub-pixel
beyond 0.6 m.

Still emulator-only evidence: that the XR context accepts the integer-sampler
variant against the device's R16UI depth texture, which decode the probe picks
there, the device's real `normDepthBufferFromNormView`, the perceived thickness
of the new streaks on a headset, and whether the hand occluder covers a palm
without gaps wide enough to let a rain streak through. A headset run answers
the first three from the console probe line (`depth probe: format=… kind=… decode=… raw[center]=… plausible=…%`) without looking through the lenses.

### UI slice re-verification (2026-10-10, managed IWER)

The root pipeline was re-run end to end on the final tree
(`npm run build` → `npm ci` + `vite build` for the app, then assembly) and
printed `Assembled 4 experience(s) into _site/`: `8thwall/knockdown`,
`8thwall/portal`, `8thwall/sea-battle` and `iwsdk/weather-room`, all four listed
in `_site/manifest.json`. The 8th Wall experiences are still built and served by
the root build, so the migration did not disturb them. (The first attempts
failed on `EPERM` while `npm ci` tried to replace `sharp`'s native DLLs, which a
long-lived IWSDK reference MCP server had loaded; stopping that process let the
pipeline finish.)


One bounded pass on the frozen tree, driven by real XR input rather than by
looking at pictures:

- `ui assets --raw` lists `weather-panel` as the only UIKitML asset; the
  isolated preview rendered without parser or resource errors.
- The affordance graph in the live runtime contains exactly three objects per
  surface — `… Move Affordance`, `… Near`, `… Far` — i.e. the four edge bars are
  gone from the scene, not merely hidden.
- A controller ray aimed at the plaque (world position measured with
  `scene_get_object_transform`: the panel is 0.864 m tall at scale 0.18 and the
  plaque sits 0.0515 m below its bottom edge) put `Hovered` on
  `Weather Panel Move Affordance Far`; select was pressed and released with the
  state queried on both sides.
- Hand mode created `hand-occluder-left/right-hand`, and switching back to
  controllers replaced them with `hand-occluder-left/right-controller` on the
  same entities — the proxy lifecycle has no leak and no duplicate.
- The console carried the depth probe line
  (`format=float32 kind=float decode=spec-raw matrix=off raw[center]=0.9994 -> 1.00m plausible=100%`)
  and no shader compile errors in either sampler variant. The repeating
  `readPixels: buffer is not large enough for dimensions` warning from the probe
  was fixed afterwards (nine single-texel reads sized from the live depth image,
  and the read format/type now queried from the driver instead of guessed).

### Independent review round (2026-10-10)

A read-only reviewer pass over both waves found four defects; all four are
fixed and the tree rebuilt green:

- session exit now resets the depth sampler kind together with the texture
  (an integer sampler left compiled with a null texture would have three bind
  its RGBA placeholder per draw — hardware-only trigger, exercised here by an
  enter/exit/re-enter cycle with a clean console);
- the 16-bit decode reads `.rg` from the CPU path's RG-packed texture instead
  of `.ra`, where alpha is padding that reads 1 (silently dead occlusion on
  cpu-optimized 16-bit runtimes — the secondary Android path; not reachable in
  IWER or on gpu-optimized Quest);
- a second simultaneous timeline grab survives the release of the first (the
  disqualify handler re-elects instead of nulling);
- pausing `HandFieldSystem` clears the capsule uniforms, so a paused system
  cannot keep parting rain around a frozen hand pose.

### AR-defect round (2026-10-10, managed IWER + source audit)

The owner's headset report ("in AR nothing is visible except a cloud lying on
the floor") was traced to two independent, source-verified causes:

- the depth shader declared an integer sampler while the runtime hands over a
  normalized depth texture, so every occluded draw was dropped
  (`GL_INVALID_OPERATION ... GL_UNSIGNED_INT_SAMPLER_2D_ARRAY`). The float
  sampler plus the calibrated decode fixed it; IWER now logs
  `depth occlusion active (... decode=inverse-unit)` and
  `depth probe: ... raw[center]=0.959 -> 2.44m ... resolved=yes`, which matches
  the SDK's own GPU-depth formula `rawValueToMeters * depthNear / (1 - tex)`.
- the temperature haze was the only weather layer without
  `enableDepthOcclusion`, so it was the one layer that survived the broken
  depth pass and the only one that drew through real geometry. It now carries
  the same injection as every other layer, and its three strata are spread
  through a capped band (`min.y + 0.3 .. min.y + 1.25`) inside the walls
  instead of stacking in the bottom 0.3 m as one floor-level sheet.

Measured in IWER after the change: the cloud deck sits at y = 2.38 m with the
viewer head at y = 1.60 m, i.e. the deck is 0.78 m above the eyes; the source
guarantees `plateTop >= min.y + 0.9` and, with the head-anchored volume,
`>= head.y + 0.88` (`RoomModel.containAnchor` grows the volume to
`head.y + 1`). A floor-level "cloud" can therefore not come from the deck.

Also verified in the same session: grip anywhere on the panel surface moves the
window 1:1 with the controller (`Grabbed` on `Weather Panel Move Affordance
Far`, panel `(0, 1.78, -1.4) -> (0.25, 1.88, -1.4)`), the flat page shows only
the DOM panel, the dot cue above the rail is gone, and the four utility labels
measure identical centred boxes (`48x20`, relative centre `[0, 0]`).

Still hardware-only, listed so the next headset run can close it:

- `unsigned-short` GPU depth decode on Quest 3 (the probe line must read
  `resolved=yes` with plausible meters; the float32 path is the only one IWER
  can exercise);
- visible rain/haze occlusion and the haze band height against a real room;
- the cloud deck height in a room whose scan has no ceiling.

### Independent review round on the AR-defect commit (2026-10-10)

Two read-only reviewer passes over `ee3431b` produced sixteen findings; the
material ones are fixed in the follow-up commit.

Depth (device-critical, in `depth-occlusion.ts` and
`systems/depth-occlusion.ts`):

- the session's fallback decode is now published before occlusion is enabled
  instead of leaving the shader on its initial value, and a calibrated
  `SpecRaw` is no longer mistaken for "uncalibrated";
- window depth is converted to NDC before linearizing
  (`near*far/(far - d*(far-near))`) in both the shader and the calibration
  math, so a 2 m surface no longer decodes as ~4 m;
- the GPU probe reads through a color staging target: the previous
  depth-attachment read was invalid in GLES3 and left an incomplete
  framebuffer, so the calibration could never sample the Quest
  normalized-depth texture;
- a spec-encoded float32 GPU image no longer requires the Meta-only
  `depthNear`; each view publishes its own `normDepthBufferFromNormView`; CPU
  sessions stay on `SpecRaw` with the reported `rawValueToMeters` and the probe
  is diagnostic-only there; the eye index falls back to a per-draw uniform when
  multiview is unavailable; the inverse-depth denominator guard no longer
  saturates every distance beyond ~1 m; and `stop()` clears the sampler so a
  paused system cannot keep a session-owned texture bound.

Interaction and UI:

- squeeze promotion is refused while that hand already owns a grab, so a
  trigger-held scrub is no longer hijacked; the routing latch is cleared on
  source loss and session exit;
- the angular-size ratio is no longer inverted: measured in IWER, the panel
  carried from 1.4 m to 1.8 m grew from 0.18 to 0.2224, where the old ratio
  would have shrunk it toward 0.108;
- the pinch-strip scrub keeps the playhead instead of snapping it to NOW, and
  the rail is hidden on a fresh 2D load instead of only after an XR exit
  (measured: `Visibility.isVisible = false` for both the rail and the panel
  right after a reload with no session);
- the rail's bare housing is reachable by the ray through a dedicated
  invisible hit box that is a *sibling* of the knob, ray-proxy and strip
  shells. Putting `RayInteractable` on the rail root instead made the housing
  win the ray hit for its own descendants — measured: aiming at the knob
  column put `Hovered` on the housing and never on the knob. With the hit box,
  the knob column hovers the ray proxy and the bare housing hovers the box.

Verified in the same IWER session after the fixes: aiming at the bare housing
and squeezing grabs the rail's move shell (`Grabbed` + `Handle`) and moves the
rail 1:1 (`(0, 1.2, -1.05) -> (0.2, 1.32, -1.05)`); with the trigger held on
the ray proxy, a squeeze leaves the move shell ungrabbed while the proxy keeps
`Grabbed`; the panel's surface squeeze still carries it 1:1
(`(0, 1.78, -1.4) -> (0, 1.88, -1.8)`); and the depth lines return
`decode=inverse-unit` with `raw[center]=0.9436 -> 1.77m` through the new
readback.

Not verified in this session: the near-grab path (`OneHandGrabbable` on the
knob, the strip and both move shells) did not engage for any controller pose
the emulator API can set — it exposes one pose per controller, while the SDK's
grab sphere follows the grip space, so the strip's relative-scrub mapping is
covered by review and typecheck only and needs a headset or an emulator that
exposes the grip pose.
