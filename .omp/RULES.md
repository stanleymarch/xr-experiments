# XR Experiments — non-negotiable project rules

- New Meta/Android XR work uses Meta Immersive Web SDK (IWSDK) under 'apps/'.
- Google XR Blocks is dead. Never restore, inspect through Git history, copy, or use its implementation unless the user explicitly asks to recover history.
- Preserve XR Blocks concepts only through 'MIGRATION.md'. Every IWSDK implementation is greenfield.
- '8thwall/' is NOT legacy. It is active supported iPhone/iPad WebAR code. Never delete, mass-migrate, or rewrite it merely because IWSDK is preferred elsewhere.
- Quest 3 / supported Android WebXR => IWSDK. iPhone/iPad WebAR => existing 8th Wall implementation when needed.
- A concept may have separate IWSDK and 8th Wall frontends. Share framework-neutral TypeScript logic only when there are two real consumers.
- Existing 8th Wall experiences such as Battleship stay working. An IWSDK counterpart is a separate deliberate task, never an automatic migration.
- Use official scoped packages '@iwsdk/create' and '@iwsdk/cli'.
- CLI-first: use 'npx @iwsdk/cli ...' for reference lookup, managed runtime/IWER, screenshots, logs, scene/ECS inspection, and verification.
- Never invent IWSDK APIs from memory. Query the local IWSDK reference corpus first.
- Before declaring an IWSDK feature complete: build, run managed runtime, enter IWER XR, exercise the interaction, inspect logs/runtime state, and capture app-only screenshots.
- Quest 3 MR is primary. Android WebXR AR is secondary and degrades by capability detection.
- No PAYG coding-agent routing. Use configured subscription roles/fallbacks only.
- Contributor models may inspect public project source and app-only screenshots, never secrets, tokens, SSH material, private URLs, personal files, or full-desktop screenshots.
- 'designer' is for milestone spatial/game/visual critique. 'iwsdk-reviewer' is for technical correctness. 'iwsdk-builder' is the normal implementation worker.
