/**
 * The LFM3-Omni decode loop, adapted from brvtl/act-it-out
 * src/model/generate.ts (MIT): greedy text, `<|audio_start|>` switching to
 * speech until an end-of-speech frame, and `<|mixed_start|>` alternating 6
 * text tokens with 12 frames. Streaming helpers (incremental text deltas and
 * fixed-size speech chunks) are added on top for the worker protocol.
 */
import {
  AUDIO_EOS_CODE,
  INTERLEAVED_N_AUDIO,
  INTERLEAVED_N_TEXT,
  NUM_CODEBOOKS,
  SPEECH_SAMPLING,
  TOKENS,
} from './constants';
import { argmax } from './sampling';

export interface DecoderOutput {
  /** Logits of the last position, `[vocab]`. */
  logits: Float32Array;
  /** Final-norm hidden state of the last position, `[2048]`. */
  hidden: Float32Array;
}

/** One running conversation on the language model; each call appends to its cache. */
export interface DecoderPort {
  prefill(inputIds: number[]): Promise<DecoderOutput>;
  feedToken(id: number): Promise<DecoderOutput>;
  feedFrame(codes: Int32Array): Promise<DecoderOutput>;
}

export interface FrameSampler {
  /** `history` holds the recent speech frames, oldest first, for the repetition penalty. */
  sample(hidden: Float32Array, history: readonly Int32Array[]): Promise<Int32Array>;
}

export interface GenerateOptions {
  inputIds: number[];
  /** Allow speech; when false the reply is forced to text, as `generation_mode="text"` does. */
  speech: boolean;
  maxNewTokens: number;
  onText?: (id: number) => void;
  onFrame?: (codes: Int32Array) => void;
  signal?: AbortSignal;
}

export interface GenerateResult {
  /** Text tokens, including the closing `<|text_end|>` / `<|im_end|>`. */
  textIds: number[];
  /** Spoken frames, without the end-of-speech frame. */
  frames: Int32Array[];
}

type Mode = 'text' | 'audio' | 'interleaved';

const TEXT_ONLY_SUPPRESS: ReadonlySet<number> = new Set([TOKENS.audioStart, TOKENS.mixedStart]);

function initialMode(lastPromptToken: number | undefined): Mode {
  if (lastPromptToken === TOKENS.mixedStart) return 'interleaved';
  if (lastPromptToken === TOKENS.audioStart || lastPromptToken === TOKENS.audioOut) return 'audio';
  return 'text';
}

export async function generate(
  decoder: DecoderPort,
  sampler: FrameSampler,
  { inputIds, speech, maxNewTokens, onText, onFrame, signal }: GenerateOptions,
): Promise<GenerateResult> {
  const textIds: number[] = [];
  const frames: Int32Array[] = [];
  const history: Int32Array[] = [];
  let mode = speech ? initialMode(inputIds.at(-1)) : 'text';
  let slotsLeft = INTERLEAVED_N_TEXT;
  let speaking = false;
  let textDone = false;
  let finished = false;

  let out = await decoder.prefill(inputIds);
  for (let step = 0; step < maxNewTokens; step++) {
    signal?.throwIfAborted();
    const interleaving = mode === 'interleaved';
    let feed: () => Promise<DecoderOutput>;

    if (mode === 'audio' || (interleaving && speaking)) {
      let codes = await sampler.sample(out.hidden, history);
      if (codes.includes(AUDIO_EOS_CODE)) {
        codes = new Int32Array(NUM_CODEBOOKS).fill(AUDIO_EOS_CODE);
        mode = 'text';
      } else {
        history.push(codes);
        if (history.length > SPEECH_SAMPLING.repetitionWindow) history.shift();
        frames.push(codes);
        onFrame?.(codes);
      }
      const frame = codes;
      feed = () => decoder.feedFrame(frame);
    } else {
      const token = argmax(out.logits, speech ? undefined : TEXT_ONLY_SUPPRESS);
      textIds.push(token);
      onText?.(token);
      if (token === TOKENS.textEnd) {
        if (interleaving) [textDone, speaking] = [true, true];
        else finished = true;
      } else if (token === TOKENS.imEnd) {
        finished = true;
      } else if (!interleaving && token === TOKENS.audioStart) {
        mode = 'audio';
      } else if (!interleaving && token === TOKENS.mixedStart) {
        mode = 'interleaved';
        [slotsLeft, speaking, textDone] = [INTERLEAVED_N_TEXT, false, false];
      }
      feed = () => decoder.feedToken(token);
    }

    if (interleaving && !textDone && --slotsLeft === 0) {
      speaking = !speaking;
      slotsLeft = speaking ? INTERLEAVED_N_AUDIO : INTERLEAVED_N_TEXT;
    }
    if (finished || step === maxNewTokens - 1) break;
    out = await feed();
  }
  return { textIds, frames };
}

/**
 * Emits only the stable prefix of a token stream: BPE pieces merge across
 * token boundaries, so the last two tokens stay buffered until more text
 * arrives or the flush ends the turn.
 */
export class IncrementalDecoder {
  private pending: number[] = [];

  constructor(
    private readonly decode: (ids: readonly number[]) => string,
    private readonly holdBack = 2,
  ) {}

  push(id: number, onDelta: (text: string) => void): void {
    this.pending.push(id);
    if (this.pending.length <= this.holdBack) return;
    const stable = this.pending.slice(0, this.pending.length - this.holdBack);
    const text = this.decode(stable);
    this.pending = this.pending.slice(this.pending.length - this.holdBack);
    if (text) onDelta(text);
  }

  /** Emits everything still held back; the returned tail completes the turn. */
  flush(): string {
    const text = this.decode(this.pending);
    this.pending = [];
    return text;
  }
}

/**
 * Accumulates speech frames and hands fixed-size groups to the codec decoder:
 * one graph call per `size` frames keeps GPU work batched and the audio
 * playback queue fed steadily.
 */
export class AudioChunker {
  private pending: Int32Array[] = [];

  constructor(
    private readonly speak: (frames: readonly Int32Array[]) => Promise<number>,
    private readonly size = 32,
  ) {}

  async push(frame: Int32Array): Promise<void> {
    this.pending.push(frame);
    if (this.pending.length < this.size) return;
    const chunk = this.pending;
    this.pending = [];
    await this.speak(chunk);
  }

  /** Runs the codec over the remainder; returns how many frames it held. */
  async flush(): Promise<number> {
    const chunk = this.pending;
    this.pending = [];
    if (!chunk.length) return 0;
    await this.speak(chunk);
    return chunk.length;
  }
}
