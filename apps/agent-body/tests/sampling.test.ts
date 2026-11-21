import { describe, expect, it } from 'vitest';
import { argmax, applyRepetitionPenalty, mulberry32, sampleWithTemperature } from '../src/agent/omni/sampling';

describe('argmax', () => {
  it('skips suppressed ids', () => {
    const logits = new Float32Array([0, 5, 3, 9]);
    expect(argmax(logits)).toBe(3);
    expect(argmax(logits, new Set([3]))).toBe(1);
  });
});

describe('applyRepetitionPenalty', () => {
  it('divides positive and multiplies negative scores of seen ids, once per id', () => {
    const scores = new Float32Array([2, -2, 4]);
    applyRepetitionPenalty(scores, [0, 1, 0], 2);
    expect(Array.from(scores)).toEqual([1, -4, 4]);
  });
});

describe('sampleWithTemperature', () => {
  it('is deterministic for a seeded generator', () => {
    const logits = new Float32Array([1, 2, 3, 2.5]);
    const a = sampleWithTemperature(logits, 1, mulberry32(7));
    const b = sampleWithTemperature(logits, 1, mulberry32(7));
    expect(a).toBe(b);
  });

  it('collapses to the top logit at very low temperature', () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 20; i++) expect(sampleWithTemperature(new Float32Array([1, 4, 2]), 0.01, rng)).toBe(1);
  });
});
