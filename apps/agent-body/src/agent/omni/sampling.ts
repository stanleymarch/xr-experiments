/**
 * Adapted from brvtl/act-it-out src/model/sampling.ts (MIT).
 */
export type Rng = () => number;

/** Small seeded PRNG so sampled speech is reproducible in tests and evals. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function argmax(logits: Float32Array, suppress?: ReadonlySet<number>): number {
  let best = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < logits.length; i++) {
    if (suppress?.has(i)) continue;
    if (logits[i] > bestScore) {
      bestScore = logits[i];
      best = i;
    }
  }
  return best;
}

/** transformers' RepetitionPenaltyLogitsProcessor: every id seen in `history` is penalized once, in place. */
export function applyRepetitionPenalty(scores: Float32Array, history: Iterable<number>, penalty: number): void {
  for (const id of new Set(history)) {
    const s = scores[id];
    scores[id] = s < 0 ? s * penalty : s / penalty;
  }
}

export function sampleWithTemperature(logits: Float32Array, temperature: number, rng: Rng): number {
  let max = -Infinity;
  for (const v of logits) if (v > max) max = v;
  const probs = new Float64Array(logits.length);
  let sum = 0;
  for (let i = 0; i < logits.length; i++) sum += probs[i] = Math.exp((logits[i] - max) / temperature);
  let r = rng() * sum;
  for (let i = 0; i < probs.length; i++) {
    r -= probs[i];
    if (r <= 0) return i;
  }
  return probs.length - 1;
}
