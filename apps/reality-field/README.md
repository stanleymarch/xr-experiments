# REALITY//FIELD

Your room becomes an elastic field. A pinch charges an impulse, the strike
lands on the *real* surface your headset measured, and a wave travels
through the room's geometry — denting the wall it hit, lighting up the
floor it crosses, gathering the dust in the air around it.

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
npm run typecheck
```

## The two faces

- **DREAM REALITY** (default) — the sensed room is the instrument. At rest it
  is untouched; a soft spark of light marks the spot the pointing ray has
  found, and grows as the pinch charges. The strike sends a thin luminous
  front across the real walls, floor and furniture, while motes drift in the
  air around it.
- **DEBUG REALITY** — the technical reconstruction: the sensed planes and
  mesh bounds as outlines, the pointing ray, the contact point, the surface
  normal there, and a live readout of what the room currently knows.

Switch with the panel's **Debug view** button (or `D` on the desktop
preview).

## Interaction

| Gesture | Effect |
| --- | --- |
| Pinch (or controller trigger) | Charges an impulse. Longer pinch = stronger strike. |
| Release | Fires the impulse where the pointing ray meets the room. |
| Open palm | Pushes the motes in the air away from the hand. |
| Fist | Pulls the motes in. |
| Two pinches | Stretch the field: the distance between the hands is the tension, and tension raises the speed and strength of every wave. |

The strike always pushes *into* the surface: the measured normal points
into the room, and the impulse travels against it.

On the desktop preview two shortcuts exist for development: `D` toggles the
debug view, `R` resets the field.

## How the room becomes a field

1. **Sensing.** Scene understanding reports detected planes and meshes as
   `XRPlane` / `XRMesh` entities. The sensing system rebuilds, on a
   debounce, one world-space *skin* mesh over everything that was found —
   plus the analytic rectangles and boxes used to find where a pointing ray
   actually meets the room.
2. **The wave.** Eight impulse slots (origin, direction, amplitude, speed,
   birth time) are uploaded as uniforms. The skin's vertex shader turns them
   into a travelling Gaussian front and dents the surface; the fragment
   shader computes the same front per pixel, so the light is a crisp
   travelling contour instead of a glow smeared across the mesh resolution.
   Nothing is simulated on the CPU.
3. **The air.** Motes drift on a cheap curl field. Hands push and pull
   them, and a fresh impact gathers them for a moment.

### Deliberate limits

- **No depth occlusion yet.** The skin and the motes are additive and draw
  over real furniture. Quest 3 can provide a depth image; wiring that in
  is the next step, not a claim of this build.
- **The membrane is a shader displacement, not a soft body.** The dent is
  a wave, not a physical simulation.
- **Meshes are picked by their bounds.** Detected planes are picked
  exactly (ray against the measured rectangle); a detected mesh is picked
  by its axis-aligned box, so the strike lands on the box, not on the
  detailed surface.
- **Large meshes are skipped.** A room mesh with hundreds of thousands of
  vertices is not copied into the world-space skin on a standalone
  headset; planes still carry the effect.

## Data and privacy

No network requests, no permissions, no accounts. The experience never
leaves the headset: the room geometry is measured locally and never
uploaded.

## Project layout

```text
src/index.ts              World.create() + system registration
src/field-component.ts    the Field component (authored values)
src/field/wave.ts         impulse ring, uniform payload, shared GLSL
src/field/surfaces.ts     world-space skin builder
src/field/picker.ts       analytic ray/plane and ray/box picking
src/field/hands.ts        hand and controller tracking
src/field/state.ts        shared runtime state
src/systems/room-field.ts sensing, skin rebuild, debug outline
src/systems/impulse.ts    gestures, charging, firing, impact rings
src/systems/motes.ts      the dust in the air
src/systems/panel.ts      panel wiring and readouts
public/ui/field-panel.uikitml
public/scenes/main.iwsdk.scene.json
```

## What is verified, and what is not

Verified in the IWSDK managed runtime / IWER (Meta Quest 3 emulation,
`immersive-ar`, emulated `sunlit_living_room`), on 2026-10-20:

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npm run build` | pass |
| Managed runtime starts, scene loads, panel renders | pass |
| Console after a fresh session | no application errors |
| Session enters `immersive-ar`, granted `plane-detection`, `mesh-detection`, `hand-tracking`, `hit-test` | pass |
| Room sensed: 15 planes + 14 meshes, 28 surfaces reported on the panel | pass |
| Controller trigger: press charges, release fires the impulse where the ray meets the measured surface (impact counter rises) | pass |
| Hand pinch (session `select` events): same strike path, hand skeleton and gesture tracked | pass |
| Aim spark: a soft point of light marks the aimed surface and grows with the charge (controller and hand) | pass |
| Wave front: a thin luminous contour crosses the floor, table, sofa and walls (frozen frames at 0.1, 0.35, 0.7 and 1.1 s with `ecs pause` + `ecs step`) | pass |
| Impact ring: thin, expands and fades on the struck surface | pass |
| Two-hand tension: holding both triggers raises TENSION to 0.99; the release produces a visibly stronger, faster wave | pass |
| Panel captures the trigger: pressing a panel button does not strike the room behind it | pass |
| DEBUG view: plane rectangles and mesh bounds drawn correctly, pointing ray and contact point shown | pass |
| Panel buttons: **Debug view** toggles the mode, **Reset field** clears the field (impact counter back to 0), **Exit to Browser** ends the session | pass |
| Skin and debug outline withdrawn when the session ends; panel returns to `browser preview` | pass |
| Desktop preview (no XR): panel, motes, 60 fps | pass |

Not verified, and still open:

- **Physical Quest 3.** No headset was connected over ADB during this work
  (`adb devices` was empty), so everything above is emulator evidence. Real
  hardware still has to confirm hand-tracking latency, the passthrough
  brightness of the additive skin, standalone frame rate with a full room
  mesh, and the actual quality of the scanned geometry.
- **Android WebXR AR.** Not tested on a device. The experience degrades to
  whatever the runtime grants: without mesh detection the skin is built from
  planes only, and without hit-test there is no second source of contact
  points.
- **Depth occlusion.** The skin and the motes draw over real furniture.
- **The mote push/pull.** The open-palm push and the fist pull are
  implemented and the gestures are recognised, but their visual effect on
  the dust was not measured.
- **Joint-pinch tension.** Tension was proven with two held triggers (the
  same code path, with the held select treated as a pinch); the joint
  distance path was not exercised, because IWER's `set-select-value` fires
  the select events without closing the emulated finger joints.

See [docs/tasks/reality-field.md](../../../docs/tasks/reality-field.md) in
the repository for the full brief.
