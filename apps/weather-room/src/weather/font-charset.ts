/**
 * Character coverage and atlas options shared by the runtime spatial-font
 * fallback and the build-time MSDF atlas generator. No DOM or SDK imports:
 * `scripts/font-atlas/generate.js` evaluates this module in a browser through
 * Vite, while `spatial-fonts.ts` imports the same constants.
 */

function rangeString(first: number, last: number): string {
  let out = '';
  for (let code = first; code <= last; code += 1) out += String.fromCodePoint(code);
  return out;
}

/**
 * Every character the spatial panel can display:
 * - ASCII printables + tab (clocks, units `mm/h`, `km/h`, `C`, `%`, coords,
 *   compass `N/NE/…`, provider tokens, URLs in demo reasons).
 * - Latin-1 Supplement (U+00A0–U+00FF): `°` in `12.34°, …` location labels,
 *   diacritics in reverse-geocoded IP place names.
 * - Latin Extended-A (U+0100–U+017F): central/eastern-European city names
 *   from IP reverse-geocoding (any city worldwide can appear).
 * - Full Cyrillic (U+0400–U+045F, incl. `Ёё`) plus `Ґґ` (U+0490–U+0491) for
 *   Ukrainian place names, and `№` (U+2116).
 * - General punctuation used by the dictionary: en/em dash, curly quotes,
 *   ellipsis `…`.
 *
 * IP place names are unbounded, so coverage is by range, not by dictionary
 * enumeration. Runtime negatives use ASCII hyphen-minus (JS `toFixed`), which
 * is already in the ASCII range.
 */
export const SPATIAL_FONT_CHARSET: string =
  ` \t${rangeString(0x21, 0x7e)}` +
  rangeString(0x00a0, 0x00ff) +
  rangeString(0x0100, 0x017f) +
  rangeString(0x0400, 0x045f) +
  'Ґґ№–—‘’“”…';

/**
 * Atlas texture for ~426 glyphs at 48 px. The bundled Inter atlas fits 104
 * glyphs in 256×512; the full Cyrillic range needs the larger square.
 */
export const SPATIAL_ATLAS_TEXTURE_SIZE: [number, number] = [1024, 1024];

/** Glyph render size used for the pre-generated and fallback atlases. */
export const SPATIAL_ATLAS_FONT_SIZE = 48;
