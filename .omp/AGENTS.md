# OMP project context: XR experiments

The main Pi/OMP agent is the lead orchestrator. It owns repository inspection,
current-IWSDK discovery, scaffolding, implementation, runtime verification and
migration cleanup.

Durable repository policy lives in root AGENTS.md.
The WEATHER//ROOM implementation brief lives in docs/tasks/weather-room.md.
Read both before acting.

Do not let this bootstrap script make SDK-version-sensitive implementation
decisions on Pi's behalf. The agent must inspect the current Meta CLI and its
generated guidance at runtime.

Delegation:
- iwsdk-builder: routine implementation/debugging;
- iwsdk-reviewer / advisor: independent technical review;
- designer: Kimi K3 spatial/visual/game-feel review after a coherent milestone.

8thwall/ is active supported Apple WebAR code and must be preserved.
Google XR Blocks implementation is retired and is removed by the migration task,
not resurrected or consulted through Git history.
