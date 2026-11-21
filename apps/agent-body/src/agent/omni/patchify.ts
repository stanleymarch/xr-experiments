/**
 * Adapted from brvtl/act-it-out src/model/patchify.ts (MIT).
 */
export const PATCH = 16;
export const MERGE = 2;
export const BLOCK = PATCH * MERGE;
const TEMPORAL = 2;
const CHANNELS = 3;
export const PATCH_DIM = CHANNELS * TEMPORAL * PATCH * PATCH;

export interface PatchTensor {
  data: Float32Array;
  dims: [number, number, number, number, number];
}

export interface ImagePixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Turns two RGBA frames (one temporal patch) into the vision encoder's `pixel_values`,
 * `[H/32, W/32, 2, 2, 3·2·16·16]`, normalized to [-1, 1] with mean 0.5 and std 0.5.
 */
export function patchifyPair(a: Uint8ClampedArray, b: Uint8ClampedArray, width: number, height: number): PatchTensor {
  if (width % BLOCK || height % BLOCK) throw new Error(`frame ${width}x${height} must be a multiple of ${BLOCK}`);
  const blocksH = height / BLOCK;
  const blocksW = width / BLOCK;
  const data = new Float32Array(blocksH * blocksW * MERGE * MERGE * PATCH_DIM);
  const frames = [a, b];
  let o = 0;
  for (let bh = 0; bh < blocksH; bh++)
    for (let bw = 0; bw < blocksW; bw++)
      for (let my = 0; my < MERGE; my++)
        for (let mx = 0; mx < MERGE; mx++)
          for (let c = 0; c < CHANNELS; c++)
            for (let t = 0; t < TEMPORAL; t++) {
              const px = frames[t];
              for (let py = 0; py < PATCH; py++) {
                const row = (bh * MERGE + my) * PATCH + py;
                let i = (row * width + (bw * MERGE + mx) * PATCH) * 4 + c;
                for (let pxi = 0; pxi < PATCH; pxi++, i += 4) data[o++] = px[i] / 127.5 - 1;
              }
            }
  return { data, dims: [blocksH, blocksW, MERGE, MERGE, PATCH_DIM] };
}

/**
 * A still image fills one temporal patch: the processor pads odd clip lengths by
 * repeating the last frame, so a photo is the same frame in both temporal slots.
 */
export function patchifyStill(image: ImagePixels): PatchTensor {
  return patchifyPair(image.data, image.data, image.width, image.height);
}

/** Language tokens one temporal patch becomes: one per 2x2 block of 16px patches. */
export function tokensPerGroup(width: number, height: number): number {
  return (width / BLOCK) * (height / BLOCK);
}
