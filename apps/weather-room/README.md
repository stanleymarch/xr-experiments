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
| Rain | `precipitation` mm/h → `drivers.rain` (saturates ~8 mm/h) | Points streaks, count ← density, fall 4+8·rain m/s, tilt ← wind; splash rings on detected surfaces |
| Wind | `wind_speed_10m` + `wind_direction_10m` → `drivers.wind` (saturates ~50 km/h) | 16 ribbon trails advect along the flow (met FROM → world TO; base heading world -Z, not true north); speed/amplitude ← wind; rain tilt shares the vector |
| Cloud | `cloud_cover` % → `drivers.cloud` | FogExp2 0.006→0.028, 3 translucent ceiling plates opacity ← cover (capped 0.3), directional light 1.0→0.35 |
| Temperature | `temperature_2m` → `drivers.warmth` (-15 °C→0, +35 °C→1) | 500 motes: continuously blended warm/cool tint, rising/falling according to temperature; warm PointLight |
| Pressure | `surface_pressure` hPa → `drivers.pressure` (985→0, 1040→1) | 400-point dust: high pressure low/dense/slow near floor; low pressure expanded with upward swirl |

## Timeline usage

The 0.9 m rail sits below the compact weather panel, with ticks every 6 h,
an emphasized NOW tick, and colored endpoints. Move close and squeeze/grab
the glowing knob with a controller or hand; rail X maps to -24…+24 h.
Release near center (±0.75 h) to snap back to NOW. The panel shows the
selected time and values, with NOW and Reload buttons.

## Capability degradation

| Target | Surfaces | Hit-test | Particles | Notes |
|---|---|---|---|---|
| Quest 3 (MR, primary) | planes + meshes | yes | full (2400 rain) | surface-coupled splashes, full wind/atmosphere/thermal |
| Android WebXR (secondary) | planes, usually no meshes | yes | reduced (1200 rain) | floor-y splash fallback; atmosphere/wind/thermal kept |
| IWER desktop (dev) | none | no | full | XR grab input requires IWER controller/hand emulation |

Detection is from the XR session's granted features (`enabledFeatures`),
never user-agent sniffing. No mesh detection → `particleBudget: 'reduced'`.
The timeline handle is proximity-grabbable; mouse/ray scrubbing is not implemented.

## Verified in IWER

- `npm run typecheck` and `npm run build` pass after the review fixes. Build
  emits only the Vite chunk-size warning. App-only flat and XR screenshots
  were captured during verification.
- Geolocation denial used the labeled `Moscow (fallback)` location; Open-Meteo
  returned live hourly weather in XR (UTC timestamps), with the timeline rail,
  NOW tick, end caps, and knob rendered.
- Grabbed the timeline knob with both controller squeeze and hand pinch
  (`Grabbed` query qualified in ECS each time); a lost grab released cleanly
  and snapped the playhead back to NOW. Earlier verification moved the knob
  to `+16h` and observed values change from the cached series; the
  scrub-to-values loop was not re-exercised after the review fixes because
  the managed browser bridge dropped repeatedly under XR that day.
- Data-layer fixes verified by a throwaway script: UTC parsing, per-field
  unavailability (`--`, neutral drivers, no fabricated values), wind
  shortest-arc interpolation across 350°→10°, `· beyond data` past the
  series edge, `stale` after the 15-minute TTL, and per-minute `current()`
  sample caching. The script was removed afterwards.
- Forced the synthetic demo dataset through a temporary verification hook
  (earlier session); at `4.1 mm/h`, rain streaks appeared, and at `0.0 mm/h`
  they disappeared. The hook and throwaway scripts were removed.
- Browser console had no errors after clean managed-runtime restarts; only
  the benign UIKitML `row` stylesheet warning appears.

Quest 3 scene sensing, real-surface splashes, passthrough comfort, hand tracking and standalone performance remain unverified on hardware. Android WebXR feature availability and hit-test degradation also require a physical Android browser/device test; IWER does not prove either.
