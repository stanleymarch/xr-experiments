# XR Experiments — repository operating rules

This repository is migrating from the discontinued Google XR Blocks experiments to Meta Immersive Web SDK (IWSDK) while preserving active 8th Wall WebAR projects.

## Architecture

- `apps/` — new Meta IWSDK experiences for Quest 3 and supported Android WebXR.
- `8thwall/` — active iPhone/iPad WebAR code. It is supported code, not legacy.
- `docs/tasks/` — durable implementation briefs for autonomous coding-agent work.
- `.omp/` — project-local Oh My Pi routing, agents and skills.

Planned greenfield IWSDK experiences:

1. WEATHER//ROOM
2. REALITY//FIELD
3. CITY//ORBIT
4. SOUND//SPACE
5. ECHO//ROOM

## Hard migration rules

Google XR Blocks implementation is dead. During the migration task:

- delete `xrblocks/`;
- delete `XR-BLOCKS.md`;
- delete stale `.agents/skills/xb-*`;
- remove any remaining XR Blocks package, install hook, build step or documentation reference that exists only for the retired implementation;
- preserve the concepts in `MIGRATION.md`, but do not preserve or port XR Blocks implementation details.

Do **not** inspect Git history to recover old XR Blocks code unless the user explicitly asks for historical recovery. The new IWSDK apps are greenfield implementations.

Do **not** delete, rename, bulk-migrate or casually rewrite `8thwall/`. Existing experiences there must continue to build and work. In particular, the existing 8th Wall sea-battle/Battleship implementation stays intact; a future IWSDK counterpart is a separate task.

Do not create a shared package just for architectural neatness. Extract framework-neutral TypeScript only after at least two real consumers need the same code.

## Device routing

- Quest 3 MR: Meta IWSDK is the primary target.
- Supported Android WebXR AR: Meta IWSDK with capability-based degradation.
- iPhone/iPad WebAR: preserve/use the existing 8th Wall path where required.
- Desktop/IWER: development, automated verification and meaningful fallback; never claim it proves Quest-only sensing or performance.

Use feature/capability detection, not user-agent guesses.

## IWSDK source of truth

Do not guess IWSDK APIs from memory.

For every new app:

1. inspect the currently installed/current `@iwsdk/create` CLI rather than relying on stale flags;
2. scaffold with the current official Meta creator;
3. inspect the generated `AGENTS.md`, `.agents/skills/iwsdk-*`, configuration and examples;
4. use `@iwsdk/cli` local reference/runtime tools as the primary SDK reference;
5. run adapter/reference setup using commands that actually exist in the installed version;
6. verify behavior in the managed runtime/IWER, not only via TypeScript/build success.

If the Meta CLI has changed, adapt to the current CLI. Do not modify the task requirements merely to fit an old command.

## Git and repository safety

Before edits, inspect `git status` and the relevant build/deploy files.

- Never discard unrelated user changes.
- Never use destructive reset/checkout/clean operations to make the tree look tidy.
- Delete only files covered by the migration brief or files proven obsolete by inspection.
- Keep generated caches, `node_modules`, local runtime artifacts and secrets out of Git.
- Do not push unless the user explicitly asks.
- Prefer small coherent commits after verified milestones if commits are useful.
- If a requested migration collides with unrelated local changes, preserve those changes and work around/reconcile them.

## Build/deploy

The root build/deploy must continue to support active 8th Wall apps. New IWSDK apps build independently unless the existing Pages pipeline needs an explicit additive integration.

When integrating an IWSDK app into GitHub Pages:

- inspect the current workflow and root `scripts/build-all.js` first;
- add the IWSDK build output without breaking current 8th Wall output;
- do not rewrite the deployment architecture merely for consistency;
- verify the final static paths and asset base paths.

## OMP delegation

The main Pi/OMP agent owns planning and orchestration.

- routine implementation/debugging -> `iwsdk-builder`;
- independent technical architecture/API review -> `iwsdk-reviewer` / advisor role;
- spatial, visual, affordance and game-feel milestone review -> `designer`, pinned to OpenCode Go Kimi K3.

The designer is not a routine coding worker. Use it after a coherent playable milestone exists.

No PAYG provider should be introduced. Use only configured subscription-backed model roles/fallbacks.

Public source and app-only runtime screenshots may be sent to contributor models. Never send `.env`, tokens, API keys, SSH material, private URLs, personal files or full-desktop screenshots.
