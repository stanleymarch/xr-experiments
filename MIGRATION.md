# Migration: Google XR Blocks -> Meta IWSDK

Google XR Blocks implementation is retired. New versions are greenfield Meta Immersive Web SDK experiences under `apps/`.

This file preserves concepts only. Do not use it as an instruction to recover or port deleted XR Blocks implementation code from Git history.

## Concepts to preserve

### WEATHER//ROOM

The user's physical room manifests local weather.

Core data:
- wind speed and direction;
- precipitation;
- cloud cover;
- temperature;
- surface pressure.

Core interaction:
- spatial timeline with `-24h`, `NOW`, and `+24h`.

Primary new target: Quest 3 mixed reality via Meta IWSDK, with room-aware behavior where current capabilities permit.

### REALITY//FIELD

Physical room geometry behaves as a force field for spatial particles/fragments.

### CITY//ORBIT

OSM/POI-based spatial city visualization with orbital/360 and tabletop modes, including hand-driven scaling.

### SOUND//SPACE

Microphone/FFT-driven spatial sound visualization with the ability to freeze sound into persistent sculptures.

### ECHO//ROOM

A spatial memory / temporal debugger for recent interactions and traces in the room.

## What is not being migrated here

`8thwall/` remains active code for iPhone/iPad WebAR and is not part of the XR Blocks retirement.

In particular, the existing 8th Wall sea-battle/Battleship stays in place. A future Meta/Android version is a separate implementation task; shared framework-neutral game logic should be extracted only when there are two real consumers.
