import { describe, expect, it } from 'vitest';
import { CODEBOOK_SIZE, NUM_CODEBOOKS } from '../src/agent/omni/constants';
import { sampleFrame, type DepthPort } from '../src/agent/omni/maskgit';
import { mulberry32 } from '../src/agent/omni/sampling';

/** A depth decoder whose logits peak at `target(codebook)`, recording what it was asked. */
function fakeDepth(target: (codebook: number) => number, runnerUp?: (codebook: number) => number) {
  const calls: { codes: number[]; masked: boolean[] }[] = [];
  const port: DepthPort = {
    async logits(_hidden, codes, masked) {
      calls.push({ codes: Array.from(codes), masked: [...masked] });
      const out = new Float32Array(NUM_CODEBOOKS * CODEBOOK_SIZE);
      for (let c = 0; c < NUM_CODEBOOKS; c++) {
        out[c * CODEBOOK_SIZE + target(c)] = 10;
        if (runnerUp) out[c * CODEBOOK_SIZE + runnerUp(c)] = 9.5;
      }
      return out;
    },
  };
  return { port, calls };
}

const hidden = new Float32Array(4);
const sharp = { temperature: 0.01, repetitionPenalty: 1.2 };

describe('sampleFrame', () => {
  it('reveals the 12 codebooks in three passes of four', async () => {
    const { port, calls } = fakeDepth((c) => c + 100);
    await sampleFrame(port, hidden, [], mulberry32(3), sharp);

    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.masked.filter(Boolean).length)).toEqual([12, 8, 4]);
  });

  it('feeds the codes revealed so far back to the depth decoder', async () => {
    const { port, calls } = fakeDepth((c) => c + 100);
    await sampleFrame(port, hidden, [], mulberry32(3), sharp);

    const second = calls[1];
    second.masked.forEach((m, c) => expect(second.codes[c]).toBe(m ? 0 : c + 100));
  });

  it('samples each codebook from its own logits', async () => {
    const { port } = fakeDepth((c) => c * 7);
    const codes = await sampleFrame(port, hidden, [], mulberry32(5), sharp);
    expect(Array.from(codes)).toEqual(Array.from({ length: NUM_CODEBOOKS }, (_, c) => c * 7));
  });

  it('penalizes codes a codebook emitted recently', async () => {
    const { port } = fakeDepth(
      () => 1,
      () => 2,
    );
    const history = [Int32Array.from({ length: NUM_CODEBOOKS }, () => 1)];
    const codes = await sampleFrame(port, hidden, history, mulberry32(5), sharp);
    expect(Array.from(codes).every((c) => c === 2)).toBe(true);
  });
});
