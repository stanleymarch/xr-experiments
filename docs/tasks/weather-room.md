# WEATHER//ROOM — autonomous implementation brief

Run this task in OMP orchestration mode. The lead agent owns repository migration, current IWSDK CLI discovery, implementation, testing, review delegation, fixes and the final commit-ready state. Do not ask the user to manually run setup commands that the agent can inspect and execute itself.

## Phase 0 — inspect before changing

Read first:

- root `AGENTS.md`
- `MIGRATION.md`
- `.omp/RULES.md` and `.omp/AGENTS.md` if present
- root `package.json`, `scripts/`, `.gitignore`
- active `8thwall/` structure and its root build dependencies

Run `git status` before edits. Preserve unrelated user changes.

Discover the current tool surface instead of assuming stale syntax:

```text
node --version
npm --version
npx --yes @iwsdk/create@latest --help
```

After scaffolding, inspect the installed `@iwsdk/cli --help`, reference commands, runtime/IWER commands, generated project guidance and generated skills.

## Phase 1 — manage and migrate the repository

Desired architecture:

```text
apps/
  weather-room/       fresh Meta IWSDK app
8thwall/              active iPhone/iPad WebAR; preserve
.omp/                 project-local OMP config, agents, skills and prompts
docs/tasks/            durable autonomous implementation briefs
MIGRATION.md           concept-only XR Blocks migration record
AGENTS.md              repository-wide operating rules
```

Retire Google XR Blocks from the active working tree. Remove when present:

- `xrblocks/`
- `XR-BLOCKS.md`
- stale `.agents/skills/xb-*`
- `scripts/install-xrblocks-skills.mjs`
- root package hooks/scripts/dependencies used only to install, sync or build XR Blocks
- XR Blocks-only branches in `scripts/build-all.js` or equivalent root build logic

Before editing shared root files, inspect them and preserve every path still required by `8thwall/`. The root build must continue to build/assemble active 8th Wall projects.

Do not delete, rename, mass-refactor or silently migrate `8thwall/`.

The existing 8th Wall Sea Battle/Battleship must remain working. An IWSDK version for Quest/Android is a separate deliberate project, not part of Weather Room.

Do not inspect old XR Blocks source or Git history for implementation ideas. Preserve only the concepts documented in `MIGRATION.md`.

Do not create shared packages merely for neatness. Extract framework-neutral TypeScript only after at least two real consumers exist.

## Phase 2 — create WEATHER//ROOM from scratch

Create `apps/weather-room` with the current official Meta creator.

The agent must determine the valid invocation itself from the current `@iwsdk/create@latest --help`; do not hardcode assumptions from old IWSDK versions. Use TypeScript and an AR/MR starting point.

Enable current official IWSDK capabilities when they meaningfully support this experience:

- scene understanding / room surfaces
- environment raycasts / real-world placement
- grabbing / interaction
- physics

After scaffolding:

1. inspect generated `AGENTS.md`, `.agents/skills`, adapter files and `iwsdk.config.json`;
2. run/update coding-tool adapter sync when supported;
3. warm and inspect the local IWSDK reference corpus;
4. sync generated Meta `iwsdk-*` skills into root `.omp/skills/` using `scripts/sync-iwsdk-skills.ps1`; repair that helper if Meta changed generated paths;
5. use installed/local Meta references before writing IWSDK-specific APIs.

Never invent IWSDK symbols from memory when the installed reference can answer the question.

## Product specification

### Targets

Primary: Meta Quest 3 mixed reality.

Secondary: supported Android Chrome/WebXR AR with capability-based degradation.

Desktop/IWER: development environment and useful non-hardware fallback. It is not evidence that Quest-only sensing, hand tracking, room meshes, occlusion or standalone performance work on hardware.

### Core idea

The user's real room becomes a physical visualization of local/current weather. Weather should feel as if it occupies and reacts to the room, rather than appearing as a conventional floating weather dashboard.

The experience should be understandable within seconds: entering the experience should produce a visible “the room has become today's weather” moment.

### Weather data

Use Open-Meteo.

- Ask for geolocation through a browser-compatible permission flow.
- If permission/location is unavailable, provide a sensible demo/fallback location and clearly identify fallback/demo data.
- Fetch enough hourly data in one request for approximately 24 hours before NOW through 24 hours after NOW.
- Normalize/cache the result. Never refetch every frame or on every timeline movement.
- Handle loading, geolocation denial, network/offline failure, stale data and malformed/missing values visibly but unobtrusively.

These dimensions must materially affect the scene:

- precipitation / rain
- wind speed and, when available, direction
- cloud cover
- temperature
- atmospheric pressure

### Timeline

Provide a comfortable spatial control spanning approximately:

```text
-24h  ←────────  NOW  ────────→  +24h
```

Intermediate selection/scrubbing is preferred if practical.

Changing time must update all weather manifestations coherently from the cached hourly dataset. Provide an obvious way to return to NOW.

Show concise time and key values, but do not let the experience collapse into a 2D weather application floating in XR.

### Spatial mapping

Rain:
- occupies meaningful room volume;
- intensity follows precipitation;
- where room surfaces/colliders are genuinely available, precipitation or secondary splash/ripple effects should visibly react to real geometry instead of falling through everything.

Wind:
- affects rain/particles/cloud/fog movement;
- communicates direction and intensity spatially;
- should be understandable without reading a numerical value.

Cloud cover:
- influences atmosphere, sky-like volume, lighting/fog density or similar room-scale ambience;
- must not obscure passthrough so heavily that the room becomes uncomfortable or unsafe.

Temperature:
- has a restrained but immediately legible spatial/material/ambient mapping;
- do not communicate it only via tiny text;
- avoid a simplistic full-screen red/blue tint as the sole representation.

Pressure:
- has a meaningful secondary spatial mapping, for example field density, vertical compression/expansion, particle buoyancy or another coherent physical metaphor;
- do not merely paste pressure as a number into UI.

Document the mapping from all five weather variables to scene behavior in the app README or nearby project documentation.

### Quest 3 interaction goals

Use these only where the current browser/IWSDK actually supports them:

- passthrough MR
- scene understanding / detected room surfaces
- environment raycasts
- depth/occlusion
- collision or interaction with real surfaces
- hands and controllers
- spatial UI readable against real backgrounds

Capability-gate all hardware-specific behavior. Never fake support in code or documentation.

### Android behavior

- Enter camera AR only where `immersive-ar` is actually supported.
- Use hit-test, anchors or depth only after capability detection.
- Never assume Android exposes Quest-style scene understanding or room meshes.
- Gracefully degrade to real-world placement + atmospheric visualization, or another explicit supported fallback.
- If a browser/device cannot provide a requested capability, preserve the core weather visualization instead of failing the entire experience.

### Interaction, comfort and performance

- First meaningful visual result should appear quickly.
- Basic use must not require locomotion.
- Controls should remain at comfortable view/reach distances.
- Effects must not make passthrough unusable.
- Keep particle counts and physics appropriate for standalone hardware.
- Add clear reset/recenter/reload-weather actions where useful.
- Hands/controllers should have clear interaction affordances and feedback where supported.

### Art and game-feel direction

Treat Weather Room as a spatial installation/art experience, not a generic SaaS weather dashboard.

- restrained, readable typography;
- one strong spatial idea per weather variable instead of five unrelated gimmicks;
- weather changes should produce a perceptible “room changed” moment;
- the physical room should remain visible and relevant;
- avoid generic neon/cyberpunk/AI-generated aesthetics without a concrete design reason;
- prioritize atmosphere, spatial legibility and interaction feedback over decorative complexity.

## Phase 3 — autonomous implementation loop

The lead orchestrator owns the loop and does not stop at scaffold success:

1. research current IWSDK references/skills;
2. plan the smallest coherent vertical slice;
3. delegate bounded implementation work to `iwsdk-builder`;
4. integrate and inspect changes;
5. build/typecheck;
6. start/use IWSDK managed runtime/IWER;
7. enter XR in IWER where applicable;
8. exercise weather loading, timeline and primary interactions;
9. inspect console plus scene/ECS/runtime state, not just whether Vite starts;
10. capture app-only screenshots when supported;
11. fix failures and repeat.

At the first coherent playable milestone, invoke `designer` once. The designer role is Kimi K3 primary. Give it app-only screenshots/runtime context and ask specifically for prioritized spatial composition, visual hierarchy, affordance, interaction/game-feel and atmosphere changes. Implement high-value findings.

Before completion, invoke `iwsdk-reviewer` / `@advisor` for an independent technical review of architecture, IWSDK API correctness, capability handling, runtime behavior and maintainability. Fix material findings and rerun verification.

The lead remains responsible for integration. Reviewers do not own the task.

## Phase 4 — acceptance criteria

Do not declare completion until all locally verifiable items are satisfied:

- active repository build/setup no longer depends on XR Blocks;
- `8thwall/` still exists and its root build path has not been intentionally broken;
- `apps/weather-room` is a fresh IWSDK project;
- Weather Room build/typecheck succeeds;
- Open-Meteo loading, permission, error and fallback paths exist;
- the roughly `-24h / NOW / +24h` timeline changes the scene from cached hourly data;
- precipitation, wind, cloud cover, temperature and pressure each have an intentional visible/spatial mapping;
- capability detection/degradation is explicit;
- no deprecated or guessed IWSDK API remains when local references disagree;
- IWER/managed runtime has been exercised;
- obvious console/runtime errors have been fixed;
- designer findings were considered and high-value fixes applied;
- technical reviewer findings were addressed;
- app README explains how to run/test the project;
- app README clearly distinguishes what was verified in IWER from what still requires physical Quest 3 and Android testing.

If a real hardware-only or external blocker remains, report it precisely instead of pretending it was verified.

## Final report

Return a concise factual report containing:

- repository changes made;
- Weather Room functionality implemented;
- commands/tests that actually passed;
- what was verified in IWER;
- what remains for physical Quest 3 validation;
- Android capability caveats;
- intentionally deferred work.
