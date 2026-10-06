# XR Blocks → Meta IWSDK migration

Google XR Blocks is retired from active development in this repository. New Meta/Android XR versions are greenfield IWSDK projects under `apps/`; the old XR Blocks implementation is intentionally not an implementation reference.

Retained concepts:

- **WEATHER//ROOM** — the physical room manifests local weather from Open-Meteo: rain, wind, cloudiness, temperature and pressure, with a `-24h / NOW / +24h` timeline.
- **REALITY//FIELD** — detected physical room geometry behaves as a force field for particles/fragments.
- **CITY//ORBIT** — OSM/POI spatial city visualization in tabletop/360 modes with hand scaling.
- **SOUND//SPACE** — microphone/FFT-driven spatial sound visualization with frozen sound sculptures.
- **ECHO//ROOM** — spatial memory / temporal debugger of recent interactions.

Migration rules:

- preserve ideas, not XR Blocks source;
- do not inspect Git history to recover old XR Blocks implementation unless explicitly requested;
- remove XR Blocks implementation/support from the active working tree;
- `8thwall/` remains active for iPhone/iPad WebAR and is outside this retirement;
- the existing 8th Wall Battleship/Sea Battle stays working; any IWSDK counterpart is a separate deliberate task.
