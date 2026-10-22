/**
 * Browser-side helper for `scripts/generate-font-atlases.mjs`.
 *
 * Runs the real `@pmndrs/uikit` TTFLoader once per face with the same charset
 * and options as the runtime fallback. The Node script serializes the result
 * (glyph metrics + atlas PNG) into `public/fonts/msdf/`.
 */
import { TTFLoader } from '@pmndrs/uikit';
import {
  SPATIAL_ATLAS_FONT_SIZE,
  SPATIAL_ATLAS_TEXTURE_SIZE,
  SPATIAL_FONT_CHARSET,
} from '../../src/weather/font-charset.ts';

const out = document.getElementById('out');
const log = (line) => {
  console.log(line);
  if (out) out.textContent += `\n${line}`;
};

const config = {
  charset: SPATIAL_FONT_CHARSET,
  fontSize: SPATIAL_ATLAS_FONT_SIZE,
  textureSize: SPATIAL_ATLAS_TEXTURE_SIZE,
  fieldRange: 4,
  padding: 4,
  fixOverlaps: true,
};

function firstFace(loaded) {
  for (const family of Object.values(loaded)) {
    for (const entry of Object.values(family ?? {})) {
      if (entry != null && typeof entry === 'object') return entry;
    }
  }
  throw new Error('TTFLoader produced no font face');
}

window.__fontConfig = {
  charsetLength: SPATIAL_FONT_CHARSET.length,
  charset: SPATIAL_FONT_CHARSET,
  fontSize: config.fontSize,
  textureSize: config.textureSize,
  fieldRange: config.fieldRange,
  padding: config.padding,
  fixOverlaps: config.fixOverlaps,
};

window.__generateFace = async ({ family, weight, url }) => {
  const started = performance.now();
  const loaded = await new TTFLoader().loadAsync([{ url, ...config }]);
  const face = firstFace(loaded);
  const ms = Math.round(performance.now() - started);
  log(`${family} ${weight}: ${ms} ms`);
  return { face, ms };
};

window.__fontGeneratorReady = true;
log('Generator ready');
