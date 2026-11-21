import { describe, expect, it } from 'vitest';
import { AudioChunker, generate, IncrementalDecoder, type DecoderPort, type DecoderOutput } from '../src/agent/omni/generate';
import { CODEBOOK_SIZE, NUM_CODEBOOKS, TOKENS } from '../src/agent/omni/constants';

/** A DecoderPort whose prefill and feeds replay a scripted sequence of outputs. */
function scriptedDecoder(steps: DecoderOutput[]) {
  const feeds: { token?: number; frame?: Int32Array }[] = [];
  let cursor = 0;
  const next = (): DecoderOutput => steps[Math.min(cursor++, steps.length - 1)];
  const port: DecoderPort = {
    async prefill() {
      feeds.push({});
      return next();
    },
    async feedToken(token) {
      feeds.push({ token });
      return next();
    },
    async feedFrame(frame) {
      feeds.push({ frame });
      return next();
    },
  };
  return { port, feeds };
}

const output = (peakToken: number, runnerUp?: number): DecoderOutput => {
  const logits = new Float32Array(130000);
  logits[peakToken] = 10;
  if (runnerUp !== undefined) logits[runnerUp] = 9;
  return { logits, hidden: new Float32Array(8) };
};

/** A sampler whose Nth call returns the Nth scripted code vector; the last repeats. */
function scriptedSampler(frames: Int32Array[]) {
  let call = 0;
  return {
    async sample(): Promise<Int32Array> {
      const frame = frames[Math.min(call, frames.length - 1)];
      call++;
      return frame;
    },
  };
}

const frameOf = (code: number) => Int32Array.from({ length: NUM_CODEBOOKS }, () => code);

describe('generate', () => {
  it('streams text tokens and stops at <|im_end|>', async () => {
    const { port, feeds } = scriptedDecoder([output(11), output(22), output(TOKENS.imEnd)]);
    const tokens: number[] = [];
    const result = await generate(port, scriptedSampler([]), {
      inputIds: [1, 2, 3],
      speech: false,
      maxNewTokens: 16,
      onText: (id) => tokens.push(id),
    });
    expect(tokens).toEqual([11, 22, TOKENS.imEnd]);
    expect(result.textIds).toEqual([11, 22, TOKENS.imEnd]);
    expect(result.frames).toHaveLength(0);
    expect(feeds[1].token).toBe(11);
    expect(feeds[2].token).toBe(22);
  });

  it('forces text when speech is false by suppressing audio entry tokens', async () => {
    // The logits peak at <|mixed_start|>; with speech off the loop falls back
    // to the runner-up instead of entering audio.
    const { port } = scriptedDecoder([output(TOKENS.mixedStart, 7), output(TOKENS.imEnd)]);
    const result = await generate(port, scriptedSampler([]), {
      inputIds: [1],
      speech: false,
      maxNewTokens: 8,
    });
    expect(result.textIds).toEqual([7, TOKENS.imEnd]);
  });

  it('alternates 6 text tokens with 12 frames in interleaved mode', async () => {
    // Six text tokens, the sixth being <|text_end|>; then one 12-frame speech
    // slot; then text ends at <|im_end|>.
    const steps = [
      output(5),
      output(5),
      output(5),
      output(5),
      output(5),
      output(TOKENS.textEnd),
      output(TOKENS.imEnd),
    ];
    const { port, feeds } = scriptedDecoder(steps);
    const speech: Int32Array[] = [];
    for (let i = 0; i < 11; i++) speech.push(frameOf(3));
    speech.push(Int32Array.from({ length: NUM_CODEBOOKS }, () => 2016)); // end-of-speech
    speech.push(frameOf(3));
    const sampler = scriptedSampler(speech);
    const frames: Int32Array[] = [];
    const result = await generate(port, sampler, {
      inputIds: [1, TOKENS.mixedStart],
      speech: true,
      maxNewTokens: 64,
      onFrame: (codes) => frames.push(codes),
    });
    expect(frames).toHaveLength(11);
    expect(result.textIds).toEqual([5, 5, 5, 5, 5, TOKENS.textEnd, TOKENS.imEnd]);
    const frameFeeds = feeds.filter((feed) => feed.frame !== undefined);
    // Eleven spoken frames plus the closing EOS frame are fed back.
    expect(frameFeeds).toHaveLength(12);
  });

  it('ends speech when the sampler emits the EOS code in every codebook', async () => {
    const { port } = scriptedDecoder([output(5), output(TOKENS.textEnd), output(TOKENS.imEnd)]);
    const sampler = scriptedSampler([Int32Array.from({ length: NUM_CODEBOOKS }, () => 2016)]);
    const frames: Int32Array[] = [];
    await generate(port, sampler, {
      inputIds: [1, TOKENS.mixedStart],
      speech: true,
      maxNewTokens: 64,
      onFrame: (codes) => frames.push(codes),
    });
    expect(frames).toHaveLength(0);
  });
});

describe('IncrementalDecoder', () => {
  it('emits stable prefixes and flushes the tail', () => {
    const decoder = new IncrementalDecoder((ids) => `«${ids.join(',')}»`);
    const deltas: string[] = [];
    decoder.push(1, (delta) => deltas.push(delta));
    decoder.push(2, (delta) => deltas.push(delta));
    expect(deltas).toEqual([]);
    expect(decoder.flush()).toBe('«1,2»');
  });

  it('emits the prefix once the hold-back window fills', () => {
    const decoder = new IncrementalDecoder((ids) => `«${ids.join(',')}»`);
    const deltas: string[] = [];
    decoder.push(1, (delta) => deltas.push(delta));
    decoder.push(2, (delta) => deltas.push(delta));
    decoder.push(3, (delta) => deltas.push(delta));
    expect(deltas).toEqual(['«1»']);
    expect(decoder.flush()).toBe('«2,3»');
  });
});

describe('AudioChunker', () => {
  it('emits one chunk per 32 frames and flushes the remainder', async () => {
    const chunks: number[] = [];
    const chunker = new AudioChunker(async (frames) => {
      chunks.push(frames.length);
      return frames.length;
    });
    const frame = frameOf(1);
    for (let i = 0; i < 70; i++) await chunker.push(frame);
    const tail = await chunker.flush();
    expect(chunks).toEqual([32, 32, 6]);
    expect(tail).toBe(6);
  });

  it('reports zero for an empty flush', async () => {
    const chunker = new AudioChunker(async () => 0);
    expect(await chunker.flush()).toBe(0);
  });

  it('sizes each codebook row at CODEBOOK_SIZE logits', () => {
    expect(NUM_CODEBOOKS * CODEBOOK_SIZE).toBe(12 * 2017);
  });
});
