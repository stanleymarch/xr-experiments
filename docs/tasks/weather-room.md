# WEATHER//ROOM — autonomous IWSDK migration and implementation brief

## Mission

Build `WEATHER//ROOM` from scratch as a Meta Immersive Web SDK mixed-reality experience under `apps/weather-room/`.

The experience turns the user's physical room into a spatial manifestation of local weather. It is not a weather dashboard placed in 3D: weather data must visibly and physically change the room.

Primary target: Meta Quest 3 mixed reality.

Secondary target: supported Android browsers with real WebXR AR, with honest feature-based degradation.

Development/fallback target: desktop + IWSDK managed runtime/IWER.

This task also completes the repository cleanup from the retired Google XR Blocks implementation without breaking active 8th Wall WebAR projects.

---

## 0. Operating mode

Act as the lead engineer/orchestrator and continue to a working verified milestone without waiting for the user for routine implementation decisions.

At the beginning:

1. read root `AGENTS.md`;
2. inspect `git status`;
3. inspect the repository tree, root package scripts, GitHub Pages workflow and current `8thwall/` build assumptions;
4. inspect the actual current Meta creator with its own `--help` and version output;
5. do not assume flags or generated file locations from old IWSDK releases.

Use subagents so exploration and bulk implementation do not bloat the main context.

Do not push to GitHub.

---

## 1. Repository migration

### Remove retired XR Blocks implementation

After recording the conceptual migration notes in `MIGRATION.md`, remove from the working tree:

- `xrblocks/`;
- `XR-BLOCKS.md`;
- every `.agents/skills/xb-*` directory;
- any remaining XR Blocks-only installer/sync script;
- any XR Blocks-only dependency, postinstall hook, root build branch, manifest field or documentation reference that has no role after migration.

Do not search Git history for deleted implementation details.

If some of these have already been removed, verify that no stale references remain instead of recreating them.

### Preserve active 8th Wall

Do not delete, rename or migrate `8thwall/`.

Keep its existing build scripts working.

Treat `8thwall/sea-battle` as active iPhone/iPad WebAR. Do not move it into `apps/` during this task. A future Meta/Android Battleship may become a separate `apps/...` implementation and can later share framework-neutral game logic if there are genuinely two consumers.

### Target repository shape

The intended high-level shape after this task is approximately:

```text
xr-experiments/
  apps/
    weather-room/
  8thwall/
    ...
    sea-battle/
  docs/
    tasks/
      weather-room.md
  scripts/
    ...
  .omp/
    ...
  AGENTS.md
  MIGRATION.md
  README.md
  package.json
```

Do not create empty folders for future IWSDK experiments merely to make this tree look complete.

### Documentation

Update `MIGRATION.md` so it preserves only these concepts:

- WEATHER//ROOM — physical room manifests local weather; Open-Meteo; wind, precipitation, cloudiness, temperature, pressure; timeline -24h / NOW / +24h.
- REALITY//FIELD — physical room geometry acts as a force field for particles/fragments.
- CITY//ORBIT — OSM/POI spatial-orbital city visualization, tabletop/360, hand scaling.
- SOUND//SPACE — microphone/FFT spatial sound visualization and frozen sound sculptures.
- ECHO//ROOM — spatial memory / temporal debugger of recent interactions.

Update the README enough that a visitor understands the new split: IWSDK for Quest/Android, preserved 8th Wall for Apple WebAR, XR Blocks retired.

---

## 2. Scaffold and learn the current IWSDK

Pi owns scaffolding. The PowerShell bootstrap must not hardcode the creator flags for you.

Before creating `apps/weather-room`:

1. run the current official Meta creator help/version;
2. determine the correct current AR/MR starting point and applicable feature flags;
3. create a fresh TypeScript app using the current official `@iwsdk/create`;
4. do not initialize a nested Git repository;
5. inspect all generated guidance, especially generated `AGENTS.md`, `.agents/skills/iwsdk-*`, project configuration and scripts;
6. inspect the current local reference CLI and warm/sync its reference/adapter state using commands supported by the installed version;
7. if root OMP cannot naturally discover nested Meta skills, sync only canonical generated `iwsdk-*` skills into root `.omp/skills/`.

Never copy old XR Blocks source into the new app.

Prefer IWSDK's native scene/config/ECS systems over manually rebuilding framework features.

---

## 3. Product concept

### Core fantasy

The user enters MR and their real room becomes a living weather instrument.

The room should answer a simple question without reading a dashboard: **what does the weather feel like now, and how is it changing?**

A successful build has at least one immediate spatial "wow" moment in passthrough.

Examples of the intended relationship between data and space:

- rain falls into the room and visually reacts to detected surfaces where supported;
- wind direction and speed drive directional flow/ribbons/particles through the space;
- cloud cover changes the density/height/opacity of a volumetric cloud layer rather than only a number;
- temperature changes a clearly perceivable environmental quality such as particle energy/material response/thermal aura; do not rely on color alone;
- pressure changes a distinct spatial quality such as air-density/compression/buoyancy behavior, not merely telemetry.

These are art-direction goals, not commands to invent unsupported SDK APIs. Choose technically robust implementations after checking current IWSDK capabilities.

The result should feel atmospheric and spatial, not like generic particle effects surrounding a floating web panel.

---

## 4. Weather data

Use Open-Meteo. No API secret should be required.

### Location

Preferred path:

- request browser geolocation intentionally and explain why it is needed;
- use the coordinates only for obtaining weather unless the user explicitly opts into something else;
- do not add a third-party geocoding dependency merely to display a city name.

Fallbacks:

- permission denied/unavailable -> allow a deterministic demo mode and/or a simple manually configurable location;
- desktop/IWER tests must be possible without granting real location permission.

### Time window

Fetch enough hourly data in one request/data refresh to resolve:

- approximately 24 hours before now;
- NOW/current;
- approximately 24 hours after now.

Do not refetch when the user switches the timeline state.

Use timestamps and the returned timezone correctly; choose the closest valid hourly sample when exact timestamps do not align.

### Data fields

At minimum the experience must derive visible behavior from:

- temperature;
- precipitation/rain (and snow if present in the selected Open-Meteo response);
- cloud cover;
- surface pressure;
- wind speed;
- wind direction.

Choose current Open-Meteo field names from current docs/API behavior rather than blindly copying this brief.

### Fetch behavior

- one deliberate fetch on start/location acquisition;
- refresh only on a sensible interval or explicit action, not per frame;
- abort stale requests if location changes;
- handle network/API failure visibly but unobtrusively;
- cache enough state to survive timeline interaction;
- no secrets in source.

Add a deterministic `?demo=1` or equivalent development path with fixed synthetic samples that exercise calm, windy and rainy states. It must not depend on network or location permission.

---

## 5. Timeline interaction

Provide a spatial timeline with three primary snap states:

- `-24h`
- `NOW`
- `+24h`

The user must be able to change the selected state naturally with hands/controllers on Quest. A ray/pointer interaction is acceptable where direct manipulation is not appropriate.

Requirements:

- current selection is visually obvious;
- switching states changes the whole weather simulation coherently;
- values interpolate/transition rather than popping harshly when practical;
- the timeline stays compact and readable in passthrough;
- do not turn the experience into a large floating dashboard.

Optional continuous scrubbing is allowed only if it does not compromise the three clear snap states or increase complexity significantly.

---

## 6. Quest 3 MR behavior

Use current IWSDK/browser capabilities where actually supported.

Investigate and use, when suitable:

- mixed-reality/passthrough session;
- scene understanding / detected room surfaces;
- environment raycasts / placement;
- depth occlusion;
- detected floors, walls, tables or other real surfaces;
- physics/collision where it meaningfully improves rain/particles/objects;
- hand input;
- controller input;
- spatial UI.

### Surface-aware weather

The preferred Quest experience should react to the physical room.

Examples:

- precipitation terminates/splashes/collects visually at detected horizontal surfaces;
- wind flow bends around or is visually contextualized by room geometry where feasible;
- cloud/fog layers respect scale and depth so they feel embedded in the room;
- virtual elements can be occluded by real geometry when depth support is available.

Do not fake scene understanding while labelling it as real sensing.

If a feature is unavailable in the current runtime, implement a clear fallback and record it in the final report.

---

## 7. Android WebXR AR degradation

The Android version is not expected to have Quest-equivalent room understanding.

When immersive AR is available:

- use real camera passthrough;
- provide a stable placement/anchor workflow using only capabilities actually exposed;
- use hit-test/depth/anchors only when feature detection confirms support;
- render a bounded weather volume around the chosen placement when whole-room geometry is unavailable.

When immersive AR is unavailable:

- provide a meaningful desktop/3D fallback or a clear compatibility message;
- never pretend a flat camera page has Quest scene understanding.

Avoid UA-based assumptions.

---

## 8. Visual and interaction direction

Aim for a restrained experimental artwork rather than a commercial weather app.

Guidelines:

- passthrough should remain legible; do not cover the room with opaque effects;
- use spatial depth and motion more than flat text;
- keep telemetry secondary;
- avoid tiny text and low-contrast floating labels;
- avoid generic neon-tech HUD styling unless the scene concept specifically justifies it;
- avoid excessive transparent particle overdraw on standalone Quest;
- color must not be the only signal for important weather differences;
- keep the first understandable interaction discoverable without a tutorial wall of text.

A small status panel may show the selected time, temperature, wind, precipitation, cloud cover and pressure, but its purpose is explanation/debugging, not the core experience.

---

## 9. Performance

Design for standalone Quest constraints.

- target stable headset frame pacing rather than maximum particle count;
- use bounded particle pools;
- avoid per-frame allocations in hot systems where practical;
- cap expensive transparent effects;
- reduce simulation complexity dynamically if needed;
- do not claim a 72/80/90 Hz hardware result from IWER.

The technical reviewer should explicitly flag likely standalone-Quest bottlenecks.

---

## 10. Required states and failure handling

The experience must have intentional behavior for:

- initial loading;
- awaiting geolocation;
- geolocation denied;
- network/Open-Meteo failure;
- WebXR unavailable;
- immersive AR available but advanced room/depth features unavailable;
- demo mode;
- valid live weather;
- switching timeline states.

No uncaught exception should strand the user on a blank scene.

---

## 11. Development and review loop

Use this loop until the milestone is coherent:

1. inspect current Meta references/skills;
2. delegate implementation chunks to `iwsdk-builder`;
3. build/typecheck;
4. run the current IWSDK managed runtime/IWER;
5. enter simulated XR when supported;
6. exercise timeline and weather transitions;
7. inspect console/runtime/ECS state;
8. capture **app-only** screenshots;
9. fix failures;
10. repeat.

After a coherent playable milestone exists:

- invoke `designer` (Kimi K3) once for spatial composition, affordances, atmosphere and game-feel critique;
- implement the high-value findings;
- invoke `iwsdk-reviewer` / advisor (Codex Sol) for independent technical review;
- fix blocking and high-confidence findings;
- rerun build/runtime tests.

Use extra designer passes only if a substantial redesign creates a genuinely new visual milestone.

---

## 12. Verification requirements

Before completion, verify at least:

- fresh install/build succeeds;
- no stale XR Blocks dependency/import/reference remains except historical migration text;
- existing 8th Wall root build still succeeds;
- weather-room production build succeeds;
- managed runtime starts;
- IWER can load the experience;
- demo mode works without network/geolocation;
- timeline changes all mapped weather systems coherently;
- no obvious console errors in the tested paths;
- app-only screenshots show a readable coherent spatial composition;
- Git diff contains no accidental deletion of 8th Wall or unrelated user work.

If current Meta tooling provides runtime/ECS/scene inspection, use it.

Do not mark as physically verified:

- Quest room sensing;
- real Quest depth occlusion;
- Quest hand/controller comfort;
- standalone Quest frame rate;
- Android device-specific ARCore behavior

unless those tests actually occurred on physical devices.

---

## 13. Pages/build integration

Inspect the existing GitHub Pages/root build before changing it.

If the repository's public gallery is expected to expose the new app, add weather-room to the existing output **additively**:

- preserve all active 8th Wall build outputs;
- build weather-room using its own official build script;
- copy/publish its production output under a stable path such as `apps/weather-room/` only if that matches the current deployment model;
- verify base URLs/assets under the deployed subpath.

Do not redesign the whole deployment system during this task.

---

## 14. Definition of done

The task is complete when:

1. the repo has been safely cleaned of the retired XR Blocks implementation;
2. active 8th Wall projects still build;
3. `apps/weather-room` is a fresh current-IWSDK implementation;
4. live Open-Meteo data and deterministic demo data both drive the spatial weather systems;
5. -24h / NOW / +24h works;
6. Quest-oriented room-aware features are implemented behind real capability checks;
7. Android has an honest degraded AR path;
8. IWER/runtime verification has been performed;
9. Kimi design review and Sol technical review have been acted on;
10. README/MIGRATION documentation matches the actual repository state.

Finish by reporting:

- what changed in the repository;
- what was deleted and why;
- what WEATHER//ROOM currently does;
- exact tests/builds/runtime checks that passed;
- designer findings and changes applied;
- technical-review findings and changes applied;
- what still requires a physical Quest 3 test;
- what still requires a physical Android test;
- any deployment caveats;
- `git status` / commit summary.

Do not claim completion merely because the code compiles.
