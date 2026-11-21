import { describe, expect, it } from 'vitest';
import { PATCH_DIM, patchifyPair, tokensPerGroup } from '../src/agent/omni/patchify';

const W = 96;
const H = 64;

/** A deterministic RGBA frame with a recognizable gradient. */
function frame(seed: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    px[i * 4] = (i * seed) & 0xff;
    px[i * 4 + 1] = (i * seed + 40) & 0xff;
    px[i * 4 + 2] = (i * seed + 80) & 0xff;
    px[i * 4 + 3] = 255;
  }
  return px;
}

/**
 * An independent transcription of the reference layout ([H/32, W/32, 2, 2,
 * 3·2·16·16], normalized to [-1, 1] with mean 0.5 / std 0.5), written directly
 * from the numpy view+permute in the reference processor.
 */
function referenceLayout(a: Uint8ClampedArray, b: Uint8ClampedArray): Float32Array {
  const PATCH = 16;
  const MERGE = 2;
  const BLOCK = PATCH * MERGE;
  const out: number[] = [];
  for (let bh = 0; bh < H / BLOCK; bh++) {
    for (let bw = 0; bw < W / BLOCK; bw++) {
      for (let my = 0; my < MERGE; my++) {
        for (let mx = 0; mx < MERGE; mx++) {
          for (let c = 0; c < 3; c++) {
            for (let t = 0; t < 2; t++) {
              const px = t === 0 ? a : b;
              for (let py = 0; py < PATCH; py++) {
                const row = (bh * MERGE + my) * PATCH + py;
                for (let pxi = 0; pxi < PATCH; pxi++) {
                  const col = (bw * MERGE + mx) * PATCH + pxi;
                  out.push((px[(row * W + col) * 4 + c] / 127.5) - 1);
                }
              }
            }
          }
        }
      }
    }
  }
  return Float32Array.from(out);
}

describe('patchifyPair', () => {
  const a = frame(3);
  const b = frame(7);
  const out = patchifyPair(a, b, W, H);

  it('has one 2x2 merge block of patches per 32x32 pixels', () => {
    expect(out.dims).toEqual([2, 3, 2, 2, PATCH_DIM]);
    expect(out.data.length).toBe(2 * 3 * 2 * 2 * PATCH_DIM);
  });

  it('matches the reference processor layout and normalization', () => {
    const expected = referenceLayout(a, b);
    let mismatches = 0;
    for (let i = 0; i < expected.length; i++) if (Math.abs(out.data[i] - expected[i]) > 1e-6) mismatches++;
    expect(mismatches).toBe(0);
  });

  it('rejects sizes that are not multiples of 32', () => {
    expect(() => patchifyPair(new Uint8ClampedArray(48 * 32 * 4), new Uint8ClampedArray(48 * 32 * 4), 48, 32)).toThrow(
      /multiple of 32/,
    );
  });

  it('counts one language token per merge block', () => {
    expect(tokensPerGroup(W, H)).toBe(6);
    expect(tokensPerGroup(448, 256)).toBe(14 * 8);
  });
});
