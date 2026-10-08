import { DataTexture, LinearFilter, RepeatWrapping, RGBAFormat } from '@iwsdk/core';

const SIZE = 128;

function lattice(x: number, y: number, period: number): number {
  const ix = ((x % period) + period) % period;
  const iy = ((y % period) + period) % period;
  const hash = Math.imul(ix + 17, 374761393) ^ Math.imul(iy + 31, 668265263);
  return ((Math.imul(hash ^ (hash >>> 13), 1274126177) >>> 0) / 4294967295);
}

function noise(u: number, v: number, period: number): number {
  const x = u * period, y = v * period;
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = lattice(ix, iy, period), b = lattice(ix + 1, iy, period);
  const c = lattice(ix, iy + 1, period), d = lattice(ix + 1, iy + 1, period);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

/** One reusable 64 KiB tile; cloud fragments sample it instead of evaluating
 * nine simplex-noise octaves per pixel, per layer, per eye. R = billows,
 * G = offset billows for thickness shading. Generated once, not per frame. */
export function createCloudNoise(): DataTexture {
  const density = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const u = x / SIZE, v = y / SIZE;
      density[y * SIZE + x] = Math.round(255 * (
        noise(u, v, 4) * 0.5 + noise(u, v, 8) * 0.27 +
        noise(u, v, 16) * 0.15 + noise(u, v, 32) * 0.08
      ));
    }
  }
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const offset = (y * SIZE + x) * 4;
      data[offset] = density[y * SIZE + x];
      data[offset + 1] = density[((y + 5) % SIZE) * SIZE + (x + 8) % SIZE];
      data[offset + 2] = 0;
      data[offset + 3] = 255;
    }
  }
  const texture = new DataTexture(data, SIZE, SIZE, RGBAFormat);
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.magFilter = texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
