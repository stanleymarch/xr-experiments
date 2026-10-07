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

`npm run dev` restarts through the iwsdk CLI (`iwsdk dev restart --open
--foreground`); do not run bare `vite` for development.

## Weather-to-scene mapping

| Variable | Source field | Scene behavior |
|---|---|---|
| Rain | `precipitation` mm/h → `drivers.rain` | Instanced soft-edged streak quads tilt with wind; short-lived splash rings use the sampled real-surface height grid. Rain accumulates into 14 shader-driven floor puddles with ripple/sheens. |
| Snow | `snowfall` cm/h → `drivers.snow` | Capability-scaled instanced flakes drift under wind and recycle on detected upward-facing surfaces. |
| Wind | `wind_speed_10m`, `wind_direction_10m`, `wind_gusts_10m` | 16 advected ribbons show mean flow; gust excess intensifies flow and rain tilt. The shared vector maps meteorological “from” to world “to”; it is not north-aligned. |
| Clouds / visibility | `cloud_cover`, `weather_code`, `relative_humidity_2m`, `visibility` | FogExp2 combines cloud, humidity and low-visibility/fog codes; three animated four-octave cloud impostors drift near the mapped room ceiling. Passthrough remains visible. |
| Thermal / daylight | `temperature_2m`, `apparent_temperature`, `is_day` | 500 motes and a warm/cool point light use apparent temperature when available; a softened day/night palette dims the directional and ambient lights. |
| Pressure | `surface_pressure` hPa | 400 soft instanced dust sprites compress toward the floor at high pressure and expand with gentle upward swirl at low pressure. |
| Forecast context | `weather_code`, `precipitation_probability` | WMO condition label and precipitation probability are shown on the panel; thunder codes add capped, spaced lightning-like light pulses. |

The 0.9 m rail sits below the panel, with 6-hour ticks, an emphasized NOW
tick and colored endpoints. The glowing knob supports hand/controller
proximity grab and ray/distance grab. It maps rail X to −24…+24 h; release
within ±0.75 h snaps to NOW. The panel provides −6h/+6h, NOW and Reload
buttons for mouse/touch users who cannot grab the spatial control.

## Spatial-surface limits

Room sensing builds a 25 cm height grid from tracked XR planes/meshes. Rain
and snow particles can react to the highest upward-facing hit in a cell;
the grid is an approximation, not a rigid-body physics world or a complete
collider for every room surface. Puddles query near the lowest mapped room
height and appear only where an upward-facing floor cell was sampled.
Ceiling clouds use mapped bounds, not ceiling collision. If room geometry
is unavailable, the scene keeps its fallback volume; real-surface contact
is not claimed.

## Capability degradation

| Target | Surfaces | Hit-test | Particles | Notes |
|---|---|---|---|---|
| Quest 3 (MR, primary) | planes + meshes when granted | yes | full (2400 rain / 900 snow) | sampled surface reactions; hardware sensing/performance still needs Quest validation |
| Android WebXR (secondary) | planes, often no meshes | capability-dependent | reduced (1200 rain / 400 snow) | no Quest-style room mesh assumed; browser touch buttons remain available |
| IWER desktop (dev) | none | no real surfaces | full | mouse buttons work in non-immersive mode; XR ray requires emulated input |

Detection is from the XR session's granted features, never user-agent sniffing.
Without mesh detection, the scene uses a reduced particle budget.

## Verified in this workstation session

`npm run typecheck` and root `npm run build` passed. The build assembled
4 experiences into `_site/`; Vite warned about Zod annotations and bundle size.

- Managed IWSDK runtime entered IWER `immersive-ar`; `xr status` reported
  emulated hand tracking, hit-test, plane detection, and mesh detection.
- The timeline entity queried with `TimelineHandle` had `RayInteractable`,
  `OneHandGrabbable`, and `DistanceGrabbable`. An emulated controller trigger
  produced a live `Grabbed` component; the trigger was released.
- UIKitML asset registration and the `-6h` button layout were inspected.
  A controller-ray click did not change the playhead; the panel is
  `ScreenSpace`. The project now enables canvas-pointer forwarding during XR
  (`activeDuringXR: true`) so touch/mouse pointer events can reach screen-space
  controls. Physical Android touch remains unverified.
- `ui render-preview` produced an 800x600 panel preview. The managed runtime
  screenshot command timed out twice; no runtime screenshot is claimed.
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
