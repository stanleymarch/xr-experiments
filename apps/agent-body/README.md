# Agent Body

One IWSDK application and one shared state for desktop, mixed reality, and a
virtual room. Built from the official Mixed Reality scaffold; there is no second
browser app. `iwsdk.config.json` selects the scene, assets, components and features.

Migrated (2026-11) from the standalone `stanleymarch/agent-body` repository
into the xr-experiments catalog:
https://stanleymarch.github.io/xr-experiments/iwsdk/agent-body/

```sh
npm ci
npm run --if-present typecheck
npm run dev
```

The CLI manages Vite and its browser. Use the Runtime/Editor toggle in that window.
Do not start a separate Vite process. Production builds use `npm run build`.

## Workspace: one Meta Horizon surface

Desktop and immersive modes share one Horizon-kit UIKitML panel
(`public/ui/agent.uikitml`). In the browser it is attached with a `ScreenSpace`
component; entering XR returns it to its authored world transform. The old
hand-styled DOM sidebar, settings card and chat overlay are gone. The only DOM
left is a hidden native text/password input that doubles as the Quest
system-keyboard bridge while editing a field.

Tabs: **Dialogue** (message, microphone, explicit Look/camera), **Character**
(bundled preset, custom VRM URL, prompt, scale, idle, gaze), **Connections**
(independent LLM/STT/TTS + encrypted QR transfer), **Memory** (notes, facts,
search, confirmed clear). Enter MR / Enter VR / Return to browser are the same
panel.

`window.__agentBody` exists only in development builds.

## Brand type: Unbounded, Geologica, JetBrains Mono

| Role | Family | File |
| --- | --- | --- |
| Headings (panel title) | Unbounded 700 | `public/fonts/Unbounded-Bold.ttf` |
| Body text, feedback | Geologica 300 | `public/fonts/Geologica-Light.ttf` |
| Buttons, labels, status, fields | JetBrains Mono 400 | `public/fonts/JetBrainsMono-Regular.ttf` |

All three are SIL OFL 1.1 (`public/fonts/OFL-*.txt`) and carry Cyrillic, so the
Russian and the English interface both render.

UIKit builds a single-channel MSDF atlas per font and, by default, only for a
fixed ASCII charset **without `_`**. Everything else was drawn as a missing
glyph, which is why Cyrillic and underscores used to appear as boxes.
`src/fonts.ts` widens that charset to the intersection of the three brand fonts
(Latin, Latin-1, Cyrillic, typographic punctuation — 309 characters) and
serialises atlas generation, because concurrent MSDF workers produce incomplete
atlases. `tools/font-charset.mjs` regenerates `src/fonts-charset.ts`; run it
after changing the font files.

Two more UIKit quirks are handled in `src/workspace.ts`: a `Container` renders
its text through a child `_Text` with its own style, so `white-space` and
`text-align` are pushed onto that child, and the panel body uses `pre-line` so
multi-line chat records keep their line breaks.

## Three presets: full local, free, paid

**Connections / LLM** has three buttons. They fill the draft only — Save
applies them, and no preset ever copies, clears or bundles a key.

| Preset | Model | Speech in | Speech out | Key |
| --- | --- | --- | --- | --- |
| **Full local** | WebGPU model, picked per device | on-device Whisper | local OS voice (female first) | none |
| **Free APIs** | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | browser/OS | browser/OS | OpenRouter key only |
| **Paid APIs** | `google/gemma-4-31b-it`, OpenRouter sorts providers by price | browser/OS | browser/OS | OpenRouter key |

The paid preset asks OpenRouter for `provider: { sort: 'price' }`, so the
cheapest healthy provider wins with the rest kept as fallbacks (CoreWeave was
cheapest during verification: $0.10/M in, $0.34/M out). Free shared-pool models
rate-limit at any time; 429s are reported, never answered by invention.

### Full local: what actually runs

- **LLM** — `@mlc-ai/web-llm` in a module worker. The model id in the panel is
  `auto`, and `src/agent/local-model.ts` resolves it **at load time**, not when
  the preset is applied, so the same settings still fit the device that opens
  them (the settings travel to a headset over the encrypted QR transfer):

  | Model | VRAM | Download | When it is chosen |
  | --- | --- | --- | --- |
  | Gemma 3 1B (`gemma3-1b-it-q4f16_1-MLC`) | 711 MB | 537 MB | flat browser, ≥ 4 GB reported memory — best Russian of the small class |
  | SmolLM2 360M (`SmolLM2-360M-Instruct-q4f16_1-MLC`) | 376 MB | 194 MB | inside an immersive session, or ≤ 4 GB — headset-safe, English-oriented |
  | Qwen2.5 0.5B (`Qwen2.5-0.5B-Instruct-q4f16_1-MLC`) | 945 MB | 265 MB | typed by hand — multilingual, but the vocabulary table is heavy |

  Two WebLLM quirks are patched in `src/agent/local-llm.ts`: the model is cached
  in IndexedDB (the Cache API rejects Hugging Face's Xet CDN responses), and
  Gemma 3 needs `context_window_size: -1` plus `attention_sink_size: 0`
  because it uses a sliding window. Verified end-to-end on the emulator: Gemma
  3 1B downloads (537 MB), loads and answers ("Hello! It's a pleasure to meet
  you."), SmolLM2 360M downloads (194 MB), loads and answers, and Qwen2.5 0.5B
  downloads (265 MB), loads and answers ("Hello! How can I assist you today?").
  Qwen is the slowest of the three to start because its vocabulary table alone
  is ~150 MB of the download; it is a hand-typed option, not the auto pick.
  The local path is text-only — a 1B model has no image input, so an explicit
  "look at this" is refused with a message instead of a fake description — and
  it has no reliable tool calling, so the avatar stays neutral there. Small
  models loop, so the local path also applies a mild repetition penalty and
  drops an immediately repeated sentence from the model's own text.
- **STT** — `onnx-community/whisper-base` through `@huggingface/transformers`
  (WebGPU, fp32 encoder / q4 decoder). The recording is decoded and resampled
  to 16 kHz mono in the page; audio never leaves the device.
- **TTS** — the operating-system voice (see below). The on-device neural voice
  `Xenova/mms-tts-rus` (VITS, byte-level tokenizer, so no espeak phonemizer is
  needed and Russian works out of the box) is still selectable under
  **TTS → On-device voice**, and it downloads, synthesises and plays with the
  avatar's speaking clip — but it is much harder to understand than the OS
  voice, so it is not the preset default.

### Browser/OS speech: the free tier

The **browser** provider is the cheapest option and needs no key at all.

- **TTS** — `speechSynthesis` exposes the voices installed in the operating
  system. On the test machine that is Microsoft Zira, David and Mark, all with
  `localService === true` (OS voices, not network voices). The default OS voice
  is male, so `src/agent/voices.ts` picks a female-sounding voice for the
  current language first and the panel reports what it chose
  ("Microsoft Zira … OS voice, female"). "Next voice" cycles female voices
  first. Voice names are matched against a curated list; the Web Speech API has
  no gender field.
- **STT** — Chrome 139+ exposes the on-device Web Speech API
  (`SpeechRecognition.available({ langs, processLocally: true })` and
  `install()`), and `ru-RU` is on the supported list. The app checks
  availability, installs the language pack on first use ("Microphone:
  installing the on-device speech pack") and then sets `processLocally = true`,
  so the audio stays on the device. Without the pack the browser falls back to
  the vendor's cloud recognition, and the status says so ("browser, cloud").

**Recorder input uses voice activity, not push-to-talk.** Every recorder-backed
provider (browser/OS speech, on-device Whisper, and the local pipeline) is gated
in `src/agent/stt.ts`: an analyser is polled every 80 ms against an adaptive
noise floor, speech ends after 1.1 s of silence, gives up after 8 s with no
speech and caps one utterance at 30 s. The panel says "Microphone: listening; it
stops automatically after a pause".

### Quest 3 reality check

Not verified on hardware. What the facts say: Meta ships WebGPU in the Horizon
browser as **experimental** (and in WebXR), so the full-local tier may not be
available in the headset browser at all; the app detects that and reports
"Full local mode needs WebGPU…" instead of failing silently. Quest 3 has 8 GB
of shared RAM, and the local tier needs the model's VRAM (711 MB for Gemma 3
1B, 376 MB for SmolLM2 360M) plus its weights in storage, Whisper and the
voice model, on top of the browser and the VRM scene. That is plausible in the
flat browser and risky inside an immersive session, which is why the model is
resolved per session: an immersive session gets the 360M model. The API presets
are the practical path on the headset.

## The panel in VR and AR

In the browser the panel is a screen-space overlay. Inside a session it
becomes a world object again, and it is placed for the person wearing the
headset: 1.15 m ahead, 0.42 m to the left and 0.18 m below the eyes, turned
towards the user, at half the desktop scale. It is deliberately **beside** the
centre of the view, because the centre belongs to the companion and to the
teleport arc — a panel in the middle also made the controller ray "busy" over
the panel, which suppressed the teleport. The distance is a compromise: closer
than a metre put the panel's lower rows at the edge of the field of view, where
the perspective piles the buttons on top of each other.

**The panel has a grab bar, like a Horizon panel.** The bar is a slim handle
under the panel; the panel itself is only a UI surface (`RayInteractable` plus
`PokeInteractable`), so the trigger clicks its buttons and a finger pokes them
without fighting a grab handle. Pointing at the bar and holding the trigger or
the grip takes the panel and moves it with the pointer, and it stays where it
was dropped. Verified in the emulator: the bar sits 0.3 m under the panel, a
controller move of `(+0.30, 0, -0.40)` moves the panel by exactly that delta,
and the panel keeps the new position after the release. A **Panel home** button
(immersive sessions only) puts it back in front of the user, and a one-line hint
("Hold the trigger to move it") teaches the gesture.

Buttons need a *tap*, not a hold: the pointer library only emits a `click` when
the press and the release are inside its click threshold (800 ms for the XR ray
pointer), so a long press on a button does not activate it.

Two UIKit drawing details needed a fix for the panel to look solid. UIKit draws
the panel in the transparent pass **without writing depth**, and the renderer
sorts transparent objects near-to-far for UI readability, so the virtual floor
grid was painted *over* the panel and it looked translucent from below. The
panel's meshes are now assigned `renderOrder = 20`, which draws the whole panel
after the scene's transparent objects while leaving its own layering intact
(`WorkspaceSystem.update`). The body area also grows to fill the panel, so the
bottom of the background is not an empty slab.

The virtual plant belongs to the virtual room: in **MR** (passthrough) the real
room is the environment, so the whole virtual set is hidden there — the room
shell, the plant, every prop and every collider — and the scene is left with the
panel, the avatar and the lights (the avatar would otherwise be unlit over
passthrough). Everything is shown again in VR and on the desktop. The plant and
the props are grabbable in VR; the plant used to sink 11.8 cm into the floor
because the GLTF's base sits below its origin, so it now hangs from a wrapper
node at y 0.15 with the visual offset by the measured 0.0316 m and scaled 1.2.

## The reading room and grabbable props

The virtual set is now a small study rather than the old grid-and-sky arena: a
procedural room (deep-green accent wall, bookcase, rust sofa, sage armchair,
walnut coffee table and sideboard, a window wall with a garden band, a pendant
lamp and framed prints) built as 277 meshes in
`src/scene-assets/reading-room.scene-asset.ts`. The asset keeps the id and name
`vr-space`, so nothing else in the scene document or the MR hiding list had to
change.

Everything on the tables and shelves is grabbable **and** physical. The props
(four books, a mug, a vase, a brass sphere, a keepsake box, two cushions and the
plant) are separate scene nodes carrying `RayInteractable`, `DistanceGrabbable`,
`PhysicsBody` (dynamic) and `PhysicsShape`; the furniture is decoration and gets
separate invisible static colliders (`collider-floor`, `-table`, `-sideboard`,
`-sofa`). Two details are easy to get wrong: `PhysicsShape Auto` derives its
dimensions from the geometry's parameters, **not** from the node scale, so the
collider boxes bake their sizes into the generated geometry; and a distance grab
drives the body through `SetTargetTransform`, so a fast (or single-frame) hand
movement makes the body accumulate a large velocity that is released whole when
the grab ends — the brass sphere ended up at `(-2345, -1412, 1094)` after being
set down. `src/grab-physics.ts` (`GrabPhysicsGuardSystem`) pins a held body to
its own pose with `resetVelocity` on every frame, hands back the prop's own
motion clamped to 3.5 m/s on release, and doubles as a safety net that returns a
body that goes non-finite or beyond 25 m to the last pose it rested at. Verified
in the emulator: the ray intersects the sphere at 2.26 m, a controller move of
`(+0.35, 0, -0.5)` moves the sphere by exactly that delta, a release drops it
onto the floor (y 0.07) instead of launching it, and a mug teleported to
`(140, 4, -60)` is back on the sideboard within 1.5 s.

**Two ways to take a prop.** The trigger with the ray is the distance grab
(`DistanceGrabbable`, the IWSDK default): the prop keeps its distance along the
ray and follows the pointer. Holding the **grip** takes whatever the ray rests
on, at the distance where it was caught, and lets go when the grip is released
(`src/grip-grab.ts`): a controller move of `(+0.30, 0, -0.40)` moves the brass
sphere by exactly that delta, and releasing the grip drops it onto the floor
(y 0.07) rather than launching it. The grip grab moves the body through the
physics system, so a held rigid body follows the hand instead of fighting it,
and its velocity is cleared every frame.

**Haptics.** `src/haptics.ts` follows the usual convention: a short, low
tick (0.22, 16 ms) confirms a button press, a stronger pulse (0.45, 32 ms)
marks "picked up" and a softer one (0.18, 16 ms) marks "put down". Nothing
pulses on hover and there is no continuous rumble - sustained vibration is
tiring and says nothing the tick does not. The pulse goes to the controller
that made the action, and devices without actuators simply do nothing.

Room lighting is point lights only: ambient 0.12, hemisphere 0.16, a front fill
at 2.2, the pendant at 3.2 and the floor lamp at 2.0. The two directional lights
that used to key the avatar are gone because MToon multiplied their intensity
into the dress and face and clipped both to flat white.

**The rig was measured, not guessed.** With the pendant at 12 cd and the avatar
standing 1.19 m below it, the lamp alone delivered an irradiance of 8.5 at her
chest - her white dress rendered at 8x white. With the values above and the
ACES tone mapping, the same camera view renders her region with 0.4 % clipped
pixels instead of 3.7 % (measured by reading the render target back), and the
folds of the dress, the blue bodice and her face are all readable again. The
room keeps its warmth because the scene's IBL gradient still fills the dark
furniture; the lamps only add the pools of light.

## Teleport and input

- The **trigger** is the pointer: it clicks the panel, it aims the teleport
  arc, and it distance-grabs the props. The **grip** takes what the ray rests
  on, and the panel's grab bar moves the panel.
- IWSDK aims the teleport arc with the **thumbstick pushed down**; the marker
  appears where the controller points, which is the usual controller teleport.
  The app adds the Quest-standard **trigger** as a second way to aim: hold the
  trigger for the arc, release to teleport. Verified in the emulator: with the
  trigger held the arc and the landing marker appear 3.1 m ahead, and on
  release the player is moved exactly onto the marker.
- Inside a session the **keyboard locomotion is disabled**. In the browser
  emulator the arrow keys drive the emulated thumbsticks, so the keyboard
  movement fought the XR movement: the same key that aimed a teleport also slid
  the player off the floor.
- The emulated stick and the framework disagree about the sign of the thumbstick
  Y axis (`@iwsdk/xr-input` reads a positive Y as "Down"), which is why the
  stick state has to be checked per device instead of assumed.

## Character card: SillyTavern v3

**Character → Export card** writes a `chara_card_v3` JSON file (and copies it to
the clipboard): name, description, personality, scenario, greeting, example
dialogue, system prompt, alternative greetings, tags and a small character
book. **Import card** accepts that JSON — v3 (`data`) and the older flat v2
layout — and fills the draft with the name and the character instructions.
The bundled card is `public/character/ava.characterv3.json`, generated from the
same source as the in-app export by `node tools/generate-character-card.mjs`,
so the two can never drift apart. The card carries the persona; the 3D model,
the voice and the providers stay in the app.

## Free OpenRouter preset: proof, not branding

The **Free APIs** preset LLM is `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`
on `https://openrouter.ai/api/v1` because that exact model answered a labelled
image fixture end-to-end (the known caption `BLUE KEY 42` was read correctly
from a real JPEG in the real multimodal request, with exactly one request
upload). Gemma 4 31B free is still listed as a selectable model id, but it
returned shared-pool upstream `429`s for every text and image request during
that verification window. Fish `s2.1-pro-free:free` speech is proven through
real `/audio/speech` MP3 bytes; it needs its own explicit key copy after the
preset. No key is bundled.

The avatar performs alongside replies through an **optional typed tool**, not
inline text tags. The live system prompt offers `avatar_perform(emotion,
gesture)` with fixed vocabularies; a zod-validated schema rejects unknown
values. Without the call the avatar stays neutral, and the reply text is
ordinary prose — nothing is parsed out of it, so a small model cannot leak
markup into speech or memory. This reduces formatting failures; it is not a
guard against factual errors in the model's answer.

- Emotions `neutral happy angry sad relaxed surprised` drive VRM expression
  presets with an attack/hold/decay envelope.
- Gestures are backed by **real CC0 VRMA clips** where honestly covered
  (`public/animations/ATTRIBUTION.txt` pins sources, licenses and SHA-256):
  idle, speaking, listening-nod, thinking, kneeling apology (bow),
  encouragement (happy), startled (surprised). Wave and shake remain procedural.
  The `nod` and `think` clips are restricted to the head and torso tracks:
  their limb tracks raised both arms above the head.
- Clips restore the exact captured normalized-skeleton rest pose on completion,
  cancellation, and avatar replacement. A missing or failed clip falls back to
  procedural motion and logs it in development.

## Room understanding and camera

- `getRoomContext()` feeds the model **measured WebXR geometry only** (detected
  planes/meshes with dimensions and origins, browser semantic labels, capped at
  12 surfaces), explicitly labelled as metadata, not vision. Unbounded meshes
  report "dimensions not provided". The prompt forbids inferring objects,
  colours or people from geometry, and states plainly when no photo is attached.
- A photo is captured **only on an explicit command** ("look at this",
  "посмотри, что это", "сделай фото", "what do you see in the camera" — full
  message, anchored). One ephemeral JPEG (max 1024px) is attached to that single
  request; it is never stored in history or memory, and camera tracks are
  stopped before the request is sent. Mentioning a camera is not consent.
- Quest passthrough compositing does not expose camera pixels to WebXR. Capture
  uses `getUserMedia` when the browser exposes a camera; a feed is labelled
  `quest-camera` only on positive camera identity, and an ambiguous Quest feed
  is rejected with an actionable message instead of masquerading as the room.
  Permission denial, missing cameras, and timeouts all report honestly.
- Room geometry requires MR with plane/mesh detection granted (headset space
  setup). The emulator reports simulated geometry, not a physical room.

## Connections

Independent LLM, STT and TTS providers, endpoints, models and keys. Secrets are
never rendered back; blank retains, Clear removes, and the LLM key is copied to
TTS only by an explicit button. The three presets above fill the draft without
touching the keys. Free endpoints are shared-pool rate-limited — 429s happen
and the app reports them instead of falling back to a paid model or a fake
reply. Browser speech recognition/synthesis depend on runtime support. STT
records only while active; stopping releases tracks and aborts transcription.

## Desktop, MR and VR

XR means an immersive browser session. IWER is IWSDK's browser-based XR
emulator: https://iwsdk.dev/guides/02-testing-experience.html#iwer-controls

- Desktop: WASD/arrows move, Space jumps, right mouse looks; the configured
  camera pose is preserved. Inside a session the keyboard locomotion is off, so
  the emulator's arrow keys drive the emulated thumbsticks instead.
- **Enter MR** starts `immersive-ar` (passthrough, hands/controllers, grabbing,
  anchors, plane/mesh detection, hit-test). The virtual room, the plant, the
  props and the colliders hide, because the real room is the environment there;
  the panel, the avatar and the lights stay.
- **Enter VR** starts `immersive-vr` and shows the procedural virtual room with
  the grabbable plant and props. State, avatar and conversation persist across
  mode switches; the panel is re-placed for the user on every session start.

**Phones.** WebXR `immersive-ar` exists in Chrome on Android (ARCore), so the
MR button can start a passthrough session there; iOS Safari has no WebXR at
all, so iPhones are out. The session request survives the difference: every
optional feature in `iwsdk.config.json` is offered as *optional*, so a device
without mesh detection or hand tracking still starts the session. What a phone
does not have is a controller: props cannot be distance-grabbed with a finger
(they are pokeable, so a tap nudges them), the panel cannot be dragged, and the
`Panel home` button is the way to put it back. The panel is also placed
differently there - 0.5 m ahead, 0.12 m left, 0.22 m down and 0.62 scale
instead of the headset placement - because a phone is held at arm's length.
None of this has been verified on real hardware.

## Character and rendering

`public/vrm/user.vrm` is VRoid AvatarSample_D (VRM 1.0), presented as Ava,
loaded with GLTFLoader + VRMLoaderPlugin. Blink, breath, sway and visemes are
procedural; body motion comes from the CC0 VRMA library above. MToon needs real
lights (supplied by the scene), not just an IBL map — and it multiplies them
into a pale model, so the room lights it with ambient 0.28, hemisphere 0.4 and
point lights (front fill, pendant, floor lamp) only. The directional keys that
used to be there clipped the dress and the face to flat white.

IWSDK renders with `NoToneMapping`, which means every value above 1.0 cuts
straight to white instead of rolling off. That was the other half of the
"burned out avatar" look: the app now sets `ACESFilmicToneMapping` with an
exposure of 1.0 (`src/index.ts`), so highlights compress instead of clipping
and the room keeps its colour in the window light and the lamp.

**Asset rights:** the bundled avatar `public/vrm/user.vrm` is **ab-1**, a
user-provided optimization (VRM 1.0, 6.4 MB) whose metadata carries the vrm.dev
default license stub only; confirm the redistribution rights before any further
public redistribution or commercial use. The previous bundled model remains
selectable as `public/vrm/avatar-sample-d.vrm` (VRoid AvatarSample_D): its
metadata declares restricted redistribution/modification and personal non-profit
use, so the same verification applies there. VRMA clips are CC0 (see
`public/animations/`); the Sansevieria plant is MIT from
`@iwsdk/example-assets` 0.4.2 and is bundled under
`public/assets/plant-sansevieria/` (attribution alongside); Unbounded, Geologica
and JetBrains Mono are SIL OFL 1.1.

## Settings transfer by QR

**Connections / Transfer** encrypts the complete saved configuration
(AES-GCM, PBKDF2-SHA256 with 300k iterations from a separate six-digit PIN,
10-minute TTL, URL fragment). The receiver (same UIKitML panel) asks for the
PIN; the fragment is captured and cleared before world bootstrap, and again when
a pairing link is opened in an already-running tab. Not a
server-enforced one-time link: copied ciphertext can be replayed within its
lifetime and a six-digit PIN permits offline guessing. Treat QR + PIN as
secrets. The app sends user-configured keys directly to their endpoints; use
restricted keys and CORS-compatible endpoints. No credentials are bundled.

## Deployment and verification

`.github/workflows/deploy-pages.yml` typechecks, builds and deploys `main` to
GitHub Pages. Before runtime verification run the typecheck; inspect desktop
with the managed runtime screenshot and an active MR/VR session before
immersive claims. Emulated runs do not establish headset performance, real
passthrough, physical camera availability or native keyboard behavior. Verified
in this revision on the emulator: real VRMA playback/restoration, Fish free
speech end-to-end, request composition for Gemma free (blocked upstream by
shared-pool 429 at test time), explicit-photo privacy path, native Horizon
controls with Cyrillic, and the encrypted QR receive flow (link re-entry, PIN
capped at six digits, wrong-PIN error, successful apply). Added in the local
tier: the WebLLM models download and answer in the emulator — Gemma 3 1B
(537 MB, "Hello! It's a pleasure to meet you."), SmolLM2 360M (194 MB) and
Qwen2.5 0.5B (265 MB, "Hello! How can I assist you today?"); the on-device
Whisper model downloads; the browser/OS voice picker selects the female OS
voice; the on-device Web Speech API reports the Russian pack as downloadable
and starts installing it. Added in the immersive work: the panel is placed
beside the user
and turned towards them, the plant is hidden in MR and visible in VR, the
keyboard no longer fights the XR locomotion, the trigger aims the teleport arc
and the release teleports the player onto the marker. Added in the scene work:
the procedural reading room, the grabbable physics props with the grab-velocity
guard (grab, follow, release onto the floor, and a rescue that returns a lost
prop to its resting pose), point-only room lighting so the avatar is no longer
clipped to white, and voice-activity recording instead of a hold-to-talk button.
Added for the controls: the panel's grab bar (the trigger or the grip on the bar
moves the panel and it stays where it was dropped), the grip grab that takes
whatever the ray points at, and haptic ticks on button presses and grabs. The
light rig was measured by reading the render target back: the avatar's clipped
pixels went from 3.7 % to 0.4 %. Added for the character:
a `chara_card_v3` export and import, round-tripped through the panel. Fixed for
the panel: it no longer looks translucent (the floor grid used to be drawn over
it) and its body fills the panel instead of leaving an empty lower half. Not
verified: the headset itself, the Russian on-device recognition quality, and
any speech content beyond the test sentences.

## No invisible failures

The interface is inside the canvas: UIKit draws the panel in WebGL, and the
only DOM nodes the app owns are a hidden keyboard bridge and the bridge's
inputs. So a setup step that throws leaves a window with a room and an avatar
and **no interface**, with the reason buried in the console. That is exactly
what a deployed build looked like once, so booting is now explicit about
failures:

- every system registration is isolated (`boot(...)` in `src/index.ts`), so one
  failing system cannot remove the panel;
- `WorkspaceSystem.init` wraps its setup and turns a throw into a strip at the
  top of the window (`src/boot-diagnostics.ts`) with the message, instead of an
  empty screen;
- panel text updates are guarded, so a missing UIKitML element reports
  `Panel update failed: UIKitML element "#id" was not found` **and the panel is
  still shown** - `updateMode`, which clears the panel's authored
  `Visibility: false`, now runs before the cosmetic WebXR capability probe;
- `World.create(...)` has a rejection handler: a missing blocking asset
  (including a 404 on the panel document) now reads
  `World failed to start: Failed to load asset "agent-panel" ...`;
- `window.__agentBody` is kept in production, so a deployed page can be
  inspected from the console instead of guessed at.

The panel document is versioned with a build stamp (`?v=<build id>` from
`define` in `vite.config.ts`). GitHub Pages caches `public/` for ten minutes,
and an older cached `agent.uikitml` next to a newer bundle is a real failure
mode: the new code looks up element ids the old document does not have. The
stamp keeps the document and the code in step.

The panel's grab bar is created **hidden** and is only shown by `updateMode`
inside a session. It used to be created visible, so on the desktop - where the
panel is a screen-space overlay - the bar sat in the room as a grey strip on
the sofa until the first mode change hid it.
