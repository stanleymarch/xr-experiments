/**
 * The LFM3-Omni-2B runtime on WebGPU, adapted from brvtl/act-it-out
 * src/model/omni.ts (MIT) with the audio-in path from Dudoxx/icedliquid
 * (Apache-2.0): tokenizer, vision encoder, audio encoder, decoder
 * conversation (KV + conv caches kept on the GPU between steps), the speech
 * depth decoder and the 24 kHz codec.
 */
import * as ort from 'onnxruntime-web/webgpu';
import { Tokenizer } from '@huggingface/tokenizers';
import { HIDDEN_SIZE, NUM_CODEBOOKS, TOKENS } from './constants';
import { createGraphSessions, fetchModelFile, initialCache, pastNameFor, type OmniSessions } from './sessions';
import { AudioChunker, generate, IncrementalDecoder, type DecoderOutput, type DecoderPort } from './generate';
import { sampleFrame, type DepthPort } from './maskgit';
import { buildConversation, expandMedia, parseToolCall, ASR_SYSTEM } from './prompt';
import { logMel, readFeatureConfig, type AudioFeatureConfig } from './audio-features';
import { patchifyStill, tokensPerGroup, type ImagePixels } from './patchify';
import { istftFromFeatures } from './istft';
import { mulberry32 } from './sampling';
import type { MediaCounts, OmniTurn, ToolSchema } from './types';

type Feeds = Record<string, ort.Tensor>;

const int64 = (values: readonly number[], dims: number[]) =>
  new ort.Tensor('int64', BigInt64Array.from(values, BigInt), dims);
/** Feature rows for one media input, consumed in order by the prefill cursor. */
export interface MediaFeatures {
  image: Float32Array[];
  video: Float32Array[];
  audio: Float32Array[];
}

const emptyMedia = (): MediaFeatures => ({ image: [], video: [], audio: [] });

const PREFILL_CHUNK = 1024;
const AUDIO_CHUNK_FRAMES = 32;
/** Speech frames per second: 24 kHz audio with a 320-sample hop. */
const SPEECH_FPS = 75;

/** One conversation on the decoder session; its KV and conv caches stay on the GPU between steps. */
class OrtConversation implements DecoderPort {
  private cache: Feeds;
  private length = 0;
  private readonly cursor: Record<string, number> = { image: 0, video: 0, audio: 0 };

  constructor(
    private readonly session: ort.InferenceSession,
    private readonly media: MediaFeatures,
  ) {
    this.cache = initialCache(session, HIDDEN_SIZE);
  }

  async prefill(inputIds: number[]): Promise<DecoderOutput> {
    let out: DecoderOutput | undefined;
    for (let start = 0; start < inputIds.length; start += PREFILL_CHUNK) {
      const chunk = inputIds.slice(start, start + PREFILL_CHUNK);
      out = await this.step(chunk);
    }
    if (!out) throw new Error('empty prompt');
    return out;
  }

  feedToken(id: number): Promise<DecoderOutput> {
    return this.step([id]);
  }

  feedFrame(codes: Int32Array): Promise<DecoderOutput> {
    return this.step([TOKENS.audioOut], { audioOutCodes: codes });
  }

  dispose(): void {
    for (const tensor of Object.values(this.cache)) tensor.dispose();
  }

  private async step(ids: number[], extra?: { audioOutCodes?: Int32Array }): Promise<DecoderOutput> {
    const total = this.length + ids.length;
    const feeds: Feeds = {
      input_ids: int64(ids, [1, ids.length]),
      attention_mask: int64(Array<number>(total).fill(1), [1, total]),
      position_ids: int64(
        ids.map((_, i) => this.length + i),
        [1, ids.length],
      ),
      image_features: this.mediaTensor('image', ids),
      video_features: this.mediaTensor('video', ids),
      audio_features: this.mediaTensor('audio', ids),
      audio_out_codes: extra?.audioOutCodes
        ? int64(Array.from(extra.audioOutCodes), [1, extra.audioOutCodes.length])
        : int64([], [0, NUM_CODEBOOKS]),
      logits_to_keep: int64([1], [1]),
      ...this.cache,
    };
    const results = await this.session.run(feeds);
    const next: Feeds = {};
    for (const [name, tensor] of Object.entries(results)) {
      if (name.startsWith('present')) next[pastNameFor(name)] = tensor;
    }
    for (const tensor of Object.values(this.cache)) tensor.dispose();
    this.cache = next;
    this.length = total;
    const [logits, hidden] = await Promise.all([results.logits.getData(), results.hidden_states.getData()]);
    return { logits: logits as Float32Array, hidden: hidden as Float32Array };
  }

  /**
   * One feature row per placeholder token of this kind in the chunk, taken
   * from the media queue in order (act-it-out's video splicing generalized).
   */
  private mediaTensor(kind: 'image' | 'video' | 'audio', ids: number[]): ort.Tensor {
    const rows = ids.reduce((count, id) => {
      if (kind === 'image' && id === TOKENS.image) return count + 1;
      if (kind === 'video' && id === TOKENS.video) return count + 1;
      if (kind === 'audio' && id === TOKENS.audio) return count + 1;
      return count;
    }, 0);
    const queue = this.media[kind];
    const offset = this.cursor[kind];
    this.cursor[kind] = offset + rows;
    const data = new Float32Array(rows * HIDDEN_SIZE);
    for (let row = 0; row < rows; row++) {
      const block = queue[offset + row];
      if (!block) throw new Error(`missing ${kind} features row ${offset + row}`);
      data.set(block.subarray(0, HIDDEN_SIZE), row * HIDDEN_SIZE);
    }
    return new ort.Tensor('float32', data, [rows, HIDDEN_SIZE]);
  }
}

export interface LoadProgressMessage {
  graph: string;
  phase: 'download' | 'compile';
  loaded: number;
  total: number;
}

export interface OmniReply {
  text: string;
  toolCalls: { name: string; args: Record<string, unknown> }[];
  spokenFrames: number;
}

export interface RespondHandlers {
  onTextDelta?: (text: string) => void;
  onAudio?: (pcm: Float32Array) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
}

export interface RespondRequest {
  turns: OmniTurn[];
  tools?: ToolSchema[];
  speech: boolean;
  media?: { image?: ImagePixels; audioPcm?: Float32Array };
  /** Tool-call parser whitelist; empty disables the tool loop. */
  toolNames?: readonly string[];
  signal?: AbortSignal;
}

/** The LFM3-Omni-2B model on WebGPU: tokenizer, encoders, decoder, speech codec. */
export class OmniRuntime {
  private constructor(
    private readonly tokenizer: Tokenizer,
    private readonly sessions: OmniSessions,
    private readonly audioConfig: AudioFeatureConfig,
    readonly template: string,
  ) {}

  static async load(
    onProgress: (p: LoadProgressMessage) => void,
    signal: AbortSignal,
    templateSource: string,
  ): Promise<OmniRuntime> {
    ort.env.wasm.wasmPaths = { wasm: `${import.meta.env.BASE_URL}ort/ort-wasm-simd-threaded.asyncify.wasm` };
    ort.env.wasm.numThreads = 1;

    const sessions = await createGraphSessions(onProgress, signal, HIDDEN_SIZE);
    const tokenizerJson = decodeModelFile(await fetchModelFile('tokenizer.json', signal));
    const tokenizerConfig = decodeModelFile(await fetchModelFile('tokenizer_config.json', signal));
    const audioConfig = readFeatureConfig(decodeModelFile(await fetchModelFile('preprocessor_config.json', signal)));
    const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
    return new OmniRuntime(tokenizer, sessions, audioConfig, templateSource);
  }

  encode(text: string): number[] {
    return [...this.tokenizer.encode(text, { add_special_tokens: false }).ids];
  }

  decode(ids: readonly number[]): string {
    return this.tokenizer.decode([...ids], { skip_special_tokens: true }).trim();
  }

  /** Vision encoder rows for one still image (one temporal patch, frame duplicated). */
  async encodeImage(pixels: ImagePixels): Promise<{ features: Float32Array[]; tokens: number }> {
    const patch = patchifyStill(pixels);
    const { image_features } = await this.sessions.vision.run({
      pixel_values: new ort.Tensor('float32', patch.data, patch.dims),
    });
    return { features: await rowsOf(image_features), tokens: tokensPerGroup(pixels.width, pixels.height) };
  }

  /** Audio encoder rows for one 16 kHz mono clip (the log-mel path). */
  async encodeAudio(pcm: Float32Array): Promise<{ features: Float32Array[]; tokens: number }> {
    const mel = logMel(pcm, 16000, this.audioConfig);
    const { audio_features } = await this.sessions.audio.run({
      input_features: new ort.Tensor('float32', mel.data, [1, mel.numMelBins, mel.numFrames]),
    });
    return { features: await rowsOf(audio_features), tokens: mel.encoderTokens };
  }

  /**
   * Runs one reply turn: prefill (with media features), the interleaved/text
   * decode loop, incremental text deltas, batched speech chunks, and the tool
   * call parse. Media features are injected once per call.
   */
  async respond(request: RespondRequest, handlers: RespondHandlers = {}): Promise<OmniReply> {
    const { turns, tools, speech, signal } = request;
    const mediaFeatures = emptyMedia();
    const counts: MediaCounts = { images: [], videos: [], audios: [] };

    if (request.media?.image) {
      const encoded = await this.encodeImage(request.media.image);
      mediaFeatures.image = encoded.features;
      counts.images.push(encoded.tokens);
    }
    if (request.media?.audioPcm) {
      const encoded = await this.encodeAudio(request.media.audioPcm);
      mediaFeatures.audio = encoded.features;
      counts.audios.push(encoded.tokens);
    }

    const prompt = expandMedia(buildConversation(this.template, turns, {
      addGenerationPrompt: true,
      speech,
      tools: tools?.length ? tools : undefined,
    }), counts);
    const inputIds = this.encode(prompt);

    const conversation = new OrtConversation(this.sessions.decoder, mediaFeatures);
    const sampler = {
      sample: (hidden: Float32Array, history: readonly Int32Array[]) =>
        sampleFrame(depthPort(this.sessions.depth), hidden, history, mulberry32(0x5eed ^ (Date.now() & 0xffff))),
    };

    const incremental = new IncrementalDecoder((ids) => this.decode(ids));
    const chunker = new AudioChunker(async (frames) => {
      const pcm = await this.speak(frames);
      handlers.onAudio?.(pcm);
      return frames.length;
    }, AUDIO_CHUNK_FRAMES);

    const result = await generate(conversation, sampler, {
      inputIds,
      speech,
      maxNewTokens: 2048,
      signal,
      onText: (id) => {
        if (!handlers.onTextDelta) return;
        incremental.push(id, (text) => handlers.onTextDelta?.(text));
      },
      onFrame: (codes) => {
        void chunker.push(codes).catch(() => { /* the reply path reports codec failures */ });
      },
    });

    const tail = incremental.flush();
    if (tail && handlers.onTextDelta) handlers.onTextDelta(tail);
    const spokenFrames = await chunker.flush();
    conversation.dispose();

    const text = this.decode(result.textIds);
    const toolCall = request.toolNames?.length ? parseToolCall(text, request.toolNames) : null;
    if (toolCall) handlers.onToolCall?.(toolCall.name, toolCall.args);
    return { text, toolCalls: toolCall ? [toolCall] : [], spokenFrames };
  }

  /** The ASR pass: one audio-only request transcribed with the documented system prompt. */
  async asr(pcm: Float32Array, signal?: AbortSignal): Promise<string> {
    const encoded = await this.encodeAudio(pcm);
    const prompt = expandMedia(buildConversation(this.template, [
      { role: 'system', content: [{ type: 'text', text: ASR_SYSTEM }] },
      { role: 'user', content: [{ type: 'audio' }] },
    ], { addGenerationPrompt: true }), { images: [], videos: [], audios: [encoded.tokens] });
    const conversation = new OrtConversation(this.sessions.decoder, {
      image: [],
      video: [],
      audio: encoded.features,
    });
    const result = await generate(conversation, {
      sample: (hidden, history) => sampleFrame(depthPort(this.sessions.depth), hidden, history, mulberry32(0xa5a5)),
    }, {
      inputIds: this.encode(prompt),
      speech: false,
      maxNewTokens: 512,
      signal,
    });
    conversation.dispose();
    return this.decode(result.textIds);
  }

  /** Speech frames → 24 kHz audio: codec decoder on the GPU, iSTFT on the CPU. */
  async speak(frames: readonly Int32Array[]): Promise<Float32Array> {
    const n = frames.length;
    const codes = new Array<number>(NUM_CODEBOOKS * n);
    frames.forEach((frame, f) => frame.forEach((code, c) => (codes[c * n + f] = code)));
    const { stft_features } = await this.sessions.codec.run({
      audio_codes: int64(codes, [1, NUM_CODEBOOKS, n]),
    });
    const features = (await stft_features.getData()) as Float32Array;
    return istftFromFeatures(features, stft_features.dims[1]);
  }
}

const depthPort = (session: ort.InferenceSession): DepthPort => ({
  async logits(hidden, codes, masked) {
    const { logits } = await session.run({
      hidden_states: new ort.Tensor('float32', hidden, [1, HIDDEN_SIZE]),
      codes: int64(Array.from(codes), [1, NUM_CODEBOOKS]),
      masked: new ort.Tensor('bool', Uint8Array.from(masked, Number), [1, NUM_CODEBOOKS]),
    });
    return (await logits.getData()) as Float32Array;
  },
});

/** Splits a [rows, width] float32 output tensor into per-row blocks. */
async function rowsOf(tensor: ort.Tensor): Promise<Float32Array[]> {
  const data = (await tensor.getData()) as Float32Array;
  const width = tensor.dims[tensor.dims.length - 1] ?? HIDDEN_SIZE;
  const blocks: Float32Array[] = [];
  for (let offset = 0; offset < data.length; offset += width) {
    blocks.push(data.subarray(offset, offset + width));
  }
  return blocks;
}

function decodeModelFile(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
