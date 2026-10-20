# REALITY//FIELD — implementation brief

Autonomous brief for the greenfield Meta IWSDK implementation of the
REALITY//FIELD concept. Repository policy lives in the root `AGENTS.md`;
the concept inventory lives in `MIGRATION.md`.

## Concept

The room is not a container for the experience — it is the instrument. A
touch on a real surface produces an impulse that travels through the room's
geometry as a wave, and the room answers.

Two faces of the same experience:

- **DREAM REALITY** — the poetic reconstruction. A thin luminous skin over
  the sensed room, motes suspended in the air, waves readable as light
  travelling across a real wall.
- **DEBUG REALITY** — the technical view. The sensed planes and mesh
  bounds, the pointing ray, the contact point and its surface normal, plus
  a readout of what the room currently knows.

## Targets

- Primary: Meta Quest 3 mixed reality (AR passthrough).
- Secondary: supported Android Chrome/WebXR AR with capability-based
  degradation (plane detection is granted on most Android runtimes, mesh
  detection usually is not).
- Desktop / IWER: development, verification and a meaningful non-hardware
  fallback. IWER does not prove Quest-only hand tracking or performance.

## Contract

1. **Sensing.** Scene understanding planes and meshes are tracked through
   `XRPlane` / `XRMesh`. The sensed room becomes one world-space skin mesh
   (rebuilt on a debounce, bounded in size) plus an analytic picker.
2. **Impulse.** A pinch (or a controller trigger) charges; releasing fires
   an impulse at the point where the pointing ray meets the room. The strike
   pushes into the surface, and the wave front travels outward from it.
3. **Field.** The skin deforms and lights up along the wave front. Motes in
   the air are pushed by an open palm, pulled by a fist, and gathered around
   a fresh impact.
4. **Tension.** Two pinching hands stretch the field: the distance between
   them raises both the speed and the strength of the wave.
5. **Modes.** DREAM and DEBUG are switchable from the panel; the debug
   overlay only exists in DEBUG.
6. **Panel.** Mode switch, reset action, and a compact readout (mode, room
   status, surface count, impact count, gesture, tension, FPS).

## Explicit non-goals for the first milestone

- Depth-sensing occlusion of the skin and motes against real furniture
  (the skin is additive and draws over real geometry).
- Physics: the membrane is a shader displacement, not a soft body.
- Mesh-precision picking: sensed meshes are picked by their bounds, planes
  by their exact rectangle.
- Audio.

## Acceptance

- `npm run typecheck` and `npm run build` succeed.
- The managed runtime starts, the scene loads and the panel is interactive.
- Entering XR in IWER produces sensed surfaces and a skin.
- A simulated impulse produces a wave: the impact counter rises and the
  wave is visible in the runtime state.
- The mode switch changes both the panel readout and the debug overlay.
- The reset action clears the field.
- The app README states exactly what was verified in IWER and what still
  requires a physical Quest 3.

## Verification notes

Use `@iwsdk/cli` domains: `dev status`, `xr status`, `ecs find`,
`browser screenshot`, `browser console`. The editor render does not run
application systems, so screenshots of the runtime are the only way to
prove that the field reacts.

`ecs pause` + `ecs step` is the way to catch a moving effect: the
simulation can be frozen, advanced a frame at a time and photographed.

## Implementation decisions (from the first milestone)

- **The strike is driven by the session's `select` events.** A controller
  trigger and a hand pinch both arrive as `selectstart` / `selectend`, and
  every WebXR runtime reports them. The gamepad button state and the joint
  distance are kept as fallbacks. Note that the gamepad's `getButtonDown` /
  `getButtonUp` are *edges*; `getButtonPressed` is the held state.
- **The wave runs on accumulated frame deltas, not on wall-clock time.**
  A stalled tab, a slow frame or a paused simulation must not let the
  front leave the room between two frames.
- **Contact is analytic.** The pointing ray is tested against the measured
  plane rectangles and mesh bounds, not against the rendered skin: the
  skin can hold tens of thousands of triangles, and two ray casts per
  frame on a standalone headset is not affordable.
- **The skin is rebuilt on a debounce** (0.4 s) and bounded: a mesh with
  more than 24 000 vertices is skipped, and the whole skin is capped.
- **The panel uses plain UIKitML elements.** The Horizon kit's `Panel` has
  a fixed-size background and its `Button` is sized for Quest system
  panels, so neither fits an instrument of this size.
- **The wave needs a slow clock to be seen.** 1.7 m/s with a long decay
  tail: the room should still be ringing a second and a half after the
  strike.

## Art pass (second verification, 2026-10-20)

Re-checking the experience visually in IWER (four frozen wave frames, a
charge sequence, DEBUG, hands, both panel modes) exposed problems that the
functional checks had missed:

- **The wave read as a flat blue sheet.** The front was computed only per
  vertex on a ~0.2 m skin grid, a wide Gaussian (0.34 m) smeared it across
  whole surfaces, and a hard alpha clamp saturated the band into one colour.
  The front is now computed **per pixel** in the fragment shader (the vertex
  shader keeps the displacement), the crest is narrow (0.09 m), the spatial
  falloff is `1/(1 + 0.55 d²)` and the alpha is a soft exponential. The
  result is a thin luminous contour that follows the real geometry.
- **The resting skin was a milky veil.** Additive layers (a plane and a mesh
  can cover the same pixel, and `DoubleSide` doubles every surface) made even
  a 3% rim visible over the real room. The resting alpha is now exactly
  zero: the room is only lit by its own wave.
- **The impact ring was a giant white donut.** It is now a thin band that
  fades in 1.2 s — the wave is the sentence, the ring is the punctuation.
- **DREAM had no aiming feedback.** The strike landed wherever the ray
  pointed, invisibly. A soft point of light (a one-vertex `Points` sprite)
  now marks the contact and grows with the charge; it is hidden while the
  pointer hovers the panel.
- **Panel clicks struck the room behind the panel.** The trigger is now
  captured while any `Hovered` UI element is under the pointer, so a button
  press is only a button press.
- **The panel covered the wall art.** Moved from 1.28 m to 1.08 m; its
  background is 92% opaque for readability against bright passthrough.
- **Tension was unreachable in the emulator.** A held select now counts as a
  pinch for the tension check, so two triggers stretch the field; the joint
  distance remains the primary signal on hand tracking. Verified: TENSION
  0.99 with both triggers, and the release produces a visibly stronger wave.
- **Motes were nearly invisible.** 2000 motes, larger and brighter points.

Two traps worth remembering for this project:

- Vite can keep serving an old module after a series of HMR edits, with the
  browser executing a class that no longer matches the file (the stack line
  numbers in the error no longer match the source). `browser reload` is not
  always enough; restarting the managed runtime (`dev down` / `dev up`)
  clears it.
- A single-vertex `Points` marker buried itself in the surface when offset
  along the picker's normal (the normal can point into the mesh). Offset the
  marker toward the viewer instead.
