/**
 * Adapted from brvtl/act-it-out src/model/maskgit.ts (MIT).
 */
import { CODEBOOK_SIZE, MASKGIT_SCHEDULE, NUM_CODEBOOKS, SPEECH_SAMPLING } from './constants';
import { applyRepetitionPenalty, sampleWithTemperature, type Rng } from './sampling';

/** The depth decoder: logits `[12, 2017]` for every codebook, given the codes revealed so far. */
export interface DepthPort {
  logits(hidden: Float32Array, codes: Int32Array, masked: readonly boolean[]): Promise<Float32Array>;
}

export interface FrameSamplingOptions {
  temperature: number;
  repetitionPenalty: number;
}

function shuffledCodebooks(rng: Rng): number[] {
  const order = Array.from({ length: NUM_CODEBOOKS }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/**
 * Samples one speech frame from a decoder hidden state, as the reference `sample_audio_frame` does: the 12 codebooks
 * are revealed in a random order over the MaskGIT schedule, each pass scoring the codebooks still hidden.
 */
export async function sampleFrame(
  depth: DepthPort,
  hidden: Float32Array,
  history: readonly Int32Array[],
  rng: Rng,
  { temperature, repetitionPenalty }: FrameSamplingOptions = SPEECH_SAMPLING,
): Promise<Int32Array> {
  const codes = new Int32Array(NUM_CODEBOOKS);
  const masked = Array<boolean>(NUM_CODEBOOKS).fill(true);
  const order = shuffledCodebooks(rng);
  let start = 0;
  for (const size of MASKGIT_SCHEDULE) {
    const pick = order.slice(start, start + size);
    start += size;
    const logits = await depth.logits(hidden, codes, masked);
    for (const c of pick) {
      const scores = logits.slice(c * CODEBOOK_SIZE, (c + 1) * CODEBOOK_SIZE);
      applyRepetitionPenalty(
        scores,
        history.map((frame) => frame[c]),
        repetitionPenalty,
      );
      codes[c] = sampleWithTemperature(scores, temperature, rng);
    }
    for (const c of pick) masked[c] = false;
  }
  return codes;
}
