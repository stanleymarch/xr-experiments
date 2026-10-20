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

- **DREAM REALITY** (default) — a thin luminous skin stretched over the
  sensed room, motes suspended in the air, and the wave readable as light
  travelling across a real wall.
- **DEBUG REALITY** — the technical reconstruction: the sensed planes and
  mesh bounds as outlines, the pointing ray, the contact point, the surface
  normal there, and a live readout of what the room currently knows.

Switch with the panel's **Toggle debug view** button.

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
   birth time) are uploaded as uniforms. The skin's vertex shader turns
   them into a travelling Gaussian front; the fragment shader lights the
   same front up. Nothing is simulated on the CPU.
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
`immersive-ar`, emulated `sunlit_living_room`), on 2026-10-19:

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npm run build` | pass |
| Managed runtime starts, scene loads, panel renders | pass |
| Console after a fresh session | no errors |
| Session enters `immersive-ar`, granted `plane-detection`, `mesh-detection`, `hand-tracking`, `hit-test` | pass |
| Room sensed: 15 planes + 14 meshes, 28 surfaces reported on the panel | pass |
| Controller trigger: press charges, release fires the impulse where the ray meets the measured surface (impact counter rises) | pass |
| Hand pinch (session `select` events): same strike path, hand skeleton and gesture (`open`) tracked | pass |
| Wave front: the skin lights up along the travelling front across floor and furniture (frozen frame with `ecs pause` + `ecs step`) | pass |
| Impact ring: expands and fades on the struck surface | pass |
| DEBUG view: plane rectangles and mesh bounds drawn correctly, pointing ray and contact point shown | pass |
| Panel buttons: **Debug view** toggles the mode, **Reset field** clears the field (impact counter back to 0) | pass |
| Skin and debug outline withdrawn when the session ends | pass |
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
- **Two-hand tension.** The tension value is computed and displayed, but
  stretching the field with two real hands was not exercised in the
  emulator, which reports one pointer at a time.
- **The mote push/pull.** The open-palm push and the fist pull are
  implemented and the gestures are recognised, but their visual effect on
  the dust was not measured.

See [docs/tasks/reality-field.md](../../../docs/tasks/reality-field.md) in
the repository for the full brief.
