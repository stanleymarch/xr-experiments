/**
 * Spatial-font (UIKit MSDF atlas) coverage for WEATHER//ROOM.
 *
 * Exact cause (measured in the local SDK corpus, not a guess):
 * `@pmndrs/uikit`'s `TTFLoader` generates its MSDF atlas at runtime with a
 * charset default of ASCII printables plus `°ÄÖÜäöüß§`
 * (`@pmndrs/uikit/dist/loaders/ttf.js` `DEFAULT_OPTIONS`). `@drawcall/uikitml`
 * calls `loadAsync(src)` with a plain URL string (`dist/fonts.js` `loadTTF`),
 * so every custom TTF gets an ASCII-only atlas even when the source font
 * contains full Cyrillic outlines. Any glyph outside that atlas hits
 * `Font.getGlyphInfo` → `console.warn('Missing glyph info for character …')`
 * and renders as a tofu box (`@pmndrs/uikit/dist/text/font.js`).
 *
 * No `@font-face` descriptor can fix this: the UIKitML parser accepts only
 * `font-family`/`src`/`font-weight` with a `.ttf` URL (`dist/css.js`
 * `parseFontFace`), and `InstantiateOptions` carries no font passthrough.
 * The only app-owned seam is replacing the resolved `fontFamilies` loader
 * functions on the instantiated panel root; children inherit them through
 * UIKit's `computedFontFamilies`, and swapping the map re-fires each text
 * node's `computedFont` effect so the fuller atlas is generated once and
 * then shared from UIKit's font cache.
 *
 * `weather.uikitml` keeps its six `.ttf` declarations untouched (they build
 * the family map this module overrides). If a face is added/renamed there,
 * update `SPATIAL_FONT_FILES` below to match.
 */

import { UIKit } from '@iwsdk/core';
import type { UIKitMLAsset } from '@iwsdk/core';

/** Family → weight → TTF file, mirroring weather.uikitml exactly. */
const SPATIAL_FONT_FILES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Geologica: {
    '400': 'fonts/Geologica-Regular.ttf',
    '500': 'fonts/Geologica-Medium.ttf',
    '600': 'fonts/Geologica-SemiBold.ttf',
    '700': 'fonts/Geologica-Bold.ttf',
  },
  Unbounded: {
    '500': 'fonts/Unbounded-Medium.ttf',
    '700': 'fonts/Unbounded-Bold.ttf',
  },
};

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

/** Atlas texture for ~430 glyphs at 48 px; bundled Inter fits 104 glyphs in 256×512. */
const SPATIAL_ATLAS_TEXTURE_SIZE: [number, number] = [1024, 1024];

const absoluteFontUrl = (file: string): string =>
  new URL(`${import.meta.env.BASE_URL}${file.replace(/^\/+/u, '')}`, window.location.href).href;

/** One resolved MSDF face: the non-URL member of the SDK's own family map. */
type SpatialFontFace = Exclude<UIKit.MSDFResult[string][number], string>;

type FontLoaderFn = () => Promise<SpatialFontFace>;

function firstFontOf(loaded: UIKit.MSDFResult, source: string): SpatialFontFace {
  const firstFamily = Object.values(loaded)[0];
  const font =
    firstFamily == null
      ? undefined
      : Object.values(firstFamily).find(
          (entry): entry is SpatialFontFace => typeof entry !== 'string',
        );
  if (font == null) throw new Error(`Spatial font "${source}" produced no font face.`);
  return font;
}
function charsetLoader(url: string): FontLoaderFn {
  return () =>
    new UIKit.TTFLoader()
      // Array input: TTFInput is `string | TTFInputItem[]`; a bare object is rejected by the type.
      .loadAsync([
        {
          url,
          charset: SPATIAL_FONT_CHARSET,
          fontSize: 48,
          textureSize: SPATIAL_ATLAS_TEXTURE_SIZE,
          fieldRange: 4,
          padding: 4,
          fixOverlaps: true,
        },
      ])
      // No ASCII fallback: a failed face rejects (UIKit logs it and leaves
      // the face unresolved) instead of rendering tofu boxes.
      .then((loaded) => firstFontOf(loaded, url));
}

/**
 * Replace the panel root's MSDF loaders with charset-aware ones covering
 * {@link SPATIAL_FONT_CHARSET}. Safe to call once the `weather-panel`
 * scene object exists; returns `false` (leaving the ASCII atlas in place)
 * when the panel or its UIKit root is not ready yet.
 */
export function installSpatialFonts(panel: UIKitMLAsset | null | undefined): boolean {
  // Component.setProperties merges over the existing base layer
  // (resetProperties({...this.inputProperties, ...inputProperties}) in the
  // SDK corpus), so passing only fontFamilies preserves every other root
  // base property. No public getProperties() exists in the corpus
  // (component.d.ts exposes set/resetProperties only), and none is needed.
  const root = panel?.document?.rootElement;
  if (root == null) return false;
  const fontFamilies: Record<string, Record<string, FontLoaderFn>> = {};
  for (const [family, weights] of Object.entries(SPATIAL_FONT_FILES)) {
    const loaders: Record<string, FontLoaderFn> = {};
    for (const [weight, file] of Object.entries(weights)) {
      loaders[weight] = charsetLoader(absoluteFontUrl(file));
    }
    fontFamilies[family] = loaders;
  }
  root.setProperties({ fontFamilies });
  return true;
}
