# Design: LFM3-Omni in-browser tier, IWSDK 1.1.0-rc.2, new avatar

Date: 2026-11-11
Status: draft for approval (revised after builder check)

## Intent and why

The demo should default to **English** and run its whole conversation loop on
**one model** — **LFM3-Omni-2B** (Liquid AI, released 2026-10-27): speech in
(ASR), vision in (photos), text in/out, speech out (24 kHz), tool calls —
running **fully in the browser** on WebGPU, loaded from the official
[LiquidAI/LFM3-Omni-2B-ONNX](https://huggingface.co/LiquidAI/LFM3-Omni-2B-ONNX)
release. The model is all-in-one by design; the browser path that proves it
exists in two permissively-licensed open-source projects and we adapt that:

- [brvtl/act-it-out](https://github.com/brvtl/act-it-out) (MIT) — full ONNX
  orchestration (chunked prefill ≤1024, KV/conv caches on GPU, vision/video
  encoding, MaskGIT depth decoder, iSTFT speech streaming), TypeScript +
  tests, measured on RTX 5090 and M-series Mac (~2.1 GB download, cached).
- [Dudoxx/icedliquid](https://github.com/Dudoxx/icedliquid) (Apache-2.0) —
  the same graphs with the missing halves: audio-encoder input path (live
  ASR with VAD), speech loop, tool calls, OPFS caching, worker protocol.

The decoder graph itself accepts `image_features` / `video_features` /
`audio_features` at the `<|image|>`/`<|video|>`/`<|audio|>` placeholders and
`audio_out_codes` at `<|audio_out|>` — so one model covers voice, photos and
tools; no second "vision" model and no vendored Liquid bundle needed.

A user who picks **Russian** keeps the existing Russian-capable pipeline
(WebLLM + Whisper + OS/mms voices). IWSDK is updated 1.0.1 → **1.1.0-rc.2**
(Three.js r185, Quest Browser multiview/XR-layer fixes), the bundled avatar
becomes the optimized **ab-1** VRM, and the metavr CLI skills bundle is
installed locally (done, outside this repo).

## Goals

- One on-device engine for the English demo: speech in → interleaved reply
  (text in the chat log + spoken audio through the avatar), VAD turn-taking.
- Explicit-photo requests ("look at this") answered by the same omni model
  through its vision encoder; one ephemeral JPEG per request, never stored
  (existing privacy rules unchanged).
- Tool calling in the omni loop with the full existing tool set:
  `avatar_perform` (zod-validated) **and** the memory tools
  (`remember note/fact`, `search`) — the Memory tab must keep working in
  the default path.
- Persona and `getRoomContext()` prompt assembly carried into the omni
  system prompt (no regression to a generic assistant).
- IWSDK 1.1.0-rc.2 migration with no regressions: panel, reading room,
  avatar lighting/tone mapping, grab bar, teleport, props, boot diagnostics.
- ab-1 VRM as the bundled avatar; visemes/expressions/lookAt verified;
  AvatarSample_D kept as an alternate.
- Panel gains an explicit interface-language setting (English default,
  Russian optional) and honest per-graph load progress.

## Non-goals / anti-goals

- No Russian speech output from the omni model (its TTS has no Russian);
  Russian selection routes to the existing pipeline. No fake Russian speech.
- No barge-in in this pass: playback is interruptible by the user's stop
  action only; recorder and playback stay sequential (self-trigger risk of
  VAD hearing the avatar's own voice outweighs the demo benefit).
- No llama.cpp server tier in this pass (the follow-up headset path; the
  server version of this same model does voice+vision in one there too).
- No silent fallbacks: unsupported devices get an explicit message
  ("No invisible failures" rule of this repo).
- No bundling of model weights in the repo; weights download at runtime from
  Hugging Face (pinned commit), cached client-side, as the existing
  WebLLM/Whisper models already do.
- No vendoring of Liquid's Space bundle (`Lfm3OmniForConditionalGeneration.js`):
  it is speech-only (hard-rejects images), unlicensed, and unnecessary given
  the ONNX path — dropped after this revision.

## Constraints

- Quest headset: 8 GB shared RAM with the WebXR scene; the omni bundle is
  ~2.1 GB download and ~2.5 GB GPU memory — desktop-first; per-session
  capability probe reports honestly (existing `local-model.ts` pattern).
  The emulator/IWER and the Quest browser path keep the existing WebLLM
  resolution when the probe fails.
- The panel is the only UI (UIKitML, MSDF atlas charset from `src/fonts.ts`);
  new UI copy must fit the atlas charset and the brand fonts.
- WebGPU feature needs (`shader-f16`, recent Chrome) — probe before
  offering the tier; explicit "Full local mode needs WebGPU…" otherwise.
- Secrets stay out of the repo; the omni tier needs no keys.

## Approaches considered

1. **ONNX all-in-one orchestration (chosen).** Adapt the two open-source
   implementations onto the official ONNX release: icedliquid's audio-in +
   speech loop + tools + OPFS cache + worker protocol, act-it-out's clean
   vision/video path, tests and load UX. One model, one stack, permissive
   licenses (MIT/Apache-2.0), typed code we own. Costs: ~2.1 GB download
   (vs 1.3 GB GGUF) and more integration code than a vendored bundle.
2. **Liquid's Space bundle.** Official and smaller (1.3 GB GGUF) but
   speech-only (rejects images by design), minified, no license header —
   would still need a second vision model. Dropped.
3. **llama.cpp local server** (`llama serve -hf LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M`):
   OpenAI-compatible + `/v1/realtime` WS; the practical *headset* path.
   Follow-up, not this pass.
4. **transformers.js everywhere**: supports `lfm3_vl` (4.3.2) but has **no
   omni support at all** (no audio graphs) — cannot drive this tier.
5. **Liquid AI cloud API**: remote, keys, not a local demo.

## Decisions (the how, as chosen)

### Engine wiring

- New `src/agent/omni/` module set, structured after the references:
  graph-session registry with per-graph progress and byte ledger (OPFS +
  Cache API caching, pinned HF commit), tokenizer via
  `@huggingface/tokenizers` + `@huggingface/jinja` for the chat template,
  chunked prefill, `DecoderPort` conversation (feedToken / feedFrame /
  audio-in features), depth-decoder MaskGIT passes, iSTFT → 24 kHz,
  speech playback queue, tool-call loop.
- Generation runs in a **Web Worker** (worker protocol after icedliquid's
  `protocol.ts`/`ort-worker.ts`); only text deltas and Float32Array audio
  chunks cross to the main thread. Fallback: if a graph refuses worker
  context in smoke testing, the engine falls back to main thread with the
  same API (decided by test, not by preference).
- Media inputs: audio-in via `audio_encoder` (log-mel 16 kHz, the path
  icedliquid implements); photo-in via `vision_encoder_q8` single-patch
  (act-it-out's `encodeVideo` handles the general patch case; a still image
  is one patch group).
- ASR: `audio_to_text` pass (ASR system prompt, media-only request) fills
  the chat-log transcript; the reply pass receives the raw audio +
  persona/room context system prompt (interleaved out).

### Tier and language routing (builder-check Q1, resolved)

- Language and presets stay **orthogonal**: the new language row
  (English default / Russian) selects the *speech pipeline*; the
  Connections preset selects the LLM provider as today.
- The **Full local preset** now resolves: omni (if WebGPU probe passes and
  the device fits) → otherwise the existing per-session WebLLM resolution.
  Free/Paid API presets are unaffected by language except for STT/TTS
  provider choice.
- **Default settings for a fresh install change to the Full local preset**
  (the demo defaults to the omni experience; no keys needed). Existing
  saved settings keep their preset; `speechLanguage` maps onto the new row
  (`en-US` default, migration keeps `ru-RU` as Russian).

### Model loading (builder-check Q2, resolved)

- Lazy-but-eager: the omni graphs start downloading **after the scene and
  panel boot** (non-blocking), with a per-graph progress line in the panel;
  voice/text actions report "loading" until ready. No boot blocking; on
  probe failure the download never starts.

### Persona / memory (builder-check Q3, resolved)

- The omni system prompt = character card persona + `getRoomContext()`
  metadata (same assembly as `brain.ts` today); the tool loop exposes
  `avatar_perform` **and** the memory tools with the same zod schemas.
  Context budget: 32k tokens; `ContextOverflowError` → drop oldest exchange
  (as in both references).

### Photo answers (builder-check Q4, resolved)

- Photo request detection stays transcript-anchored (`requestsPhoto()` on
  the user's explicit words; mentioning a camera is not consent). The JPEG
  goes to the omni decoder as image features of **that one request**;
  nothing persisted. The reply is one conversation turn — the model sees
  the image and speaks; no side-channel description needed (unlike the
  earlier two-model draft).

### Audio plumbing and playback

- Recording stays as-is (VAD gating in `src/agent/stt.ts`, 16 kHz mono
  Float32 decode/resample exists for Whisper and is reused).
- Playback: the Space-style AudioContext scheduling queue (ported pattern:
  interruptible via explicit stop, spoken-word tracking) drives the
  avatar's speaking clip and speech envelope. Viseme-from-audio extraction
  is a stretch goal (VRM has aa/ih/ou/ee/oh; the engine provides no
  viseme mapping).

### IWSDK upgrade

- `@iwsdk/*` → 1.1.0-rc.2, `three` override → `super-three@0.185.0`,
  `@types/three` → ^0.185, `@pmndrs/uikit*` → 1.0.78,
  `@meta-quest/metavr` (devDep) → ^1.10.0.
- Re-verify after bump: MToon lighting (measured rig), ACES tone mapping,
  panel `renderOrder` translucency fix, boot diagnostics strip, grab bar,
  teleport trigger, prop physics guard, IWER emulator run.

### Avatar

- `public/vrm/user.vrm` ← `ab-1_optimized.vrm` (6.4 MB, VRM 1.0, 54 bones,
  full expression preset + visemes, firstPerson + lookAt). AvatarSample_D
  moves to `public/vrm/avatar-sample-d.vrm` as a selectable alternate.
- **Pending user confirmation (builder-check Q5):** ab-1's provenance — if
  it is the user's own work, bundle it and add a README asset-rights entry;
  if it derives from a third-party model, keep AvatarSample_D bundled and
  load ab-1 by URL or secure permission.
- Verify: expressions/visemes drive, lookAt works, scale/placement sane,
  animation clips still land on the shared skeleton rest pose.

### UI/UX pass (hz-immersive-designer + metavr docs)

- Run the immersive-designer checklist (comfort / interaction /
  spatial layout / accessibility) against the panel and the voice loop;
  verify Quest claims with `metavr docs search` (hz-quest-verify-first)
  before citing them.
- Panel additions: language row, per-graph model-load progress line,
  engine status. Keep grab bar / poke / haptic conventions; keep all copy
  within the font atlas charset.

### Licensing

- `NOTICE` entries + README credit for adapted code: act-it-out (MIT),
  icedliquid (Apache-2.0); weights under LFM Open License v1.0 (runtime
  download from the pinned official release; nothing redistributed
  in-repo). No Liquid bundle vendoring → no open license question remains.

## What is left to the builder

- Exact pinned commit / file list of the ONNX release and the byte ledger
  shape; smoke-test graph loads in worker context (per-graph fallback).
- Exact UIKitML rows (language, progress, engine status) and their ids.
- Verification scripts: spoken-output WAV capture, labelled image fixture
  ("BLUE KEY 42" pattern) for the vision check, emulator regression pass.
- Whether the persona/room-context prompt fits the 2B model's reply
  quality — verified by conversation, tuned by trimming room context first.
