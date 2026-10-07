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

## Capability degradation

| Target | Surfaces | Hit-test | Particles | Notes |
|---|---|---|---|---|
| Quest 3 (MR, primary) | planes + meshes when granted | yes | full (2400 rain / 900 snow) | sampled surface reactions; hardware sensing/performance still needs Quest validation |
| Android WebXR (secondary) | planes, often no meshes | capability-dependent | reduced (1200 rain / 400 snow) | no Quest-style room mesh assumed; touch forwarding is configured, but device behavior is unverified |
| IWER desktop (dev) | none | no real surfaces | full | distance grab was exercised; mouse-button interaction was not verified in this session |

Detection is from the XR session's granted features, never user-agent sniffing.
Without mesh detection, the scene uses a reduced particle budget.

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
