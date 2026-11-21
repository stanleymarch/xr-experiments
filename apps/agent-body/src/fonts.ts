/**
 * Brand font plumbing for the UIKit panel.
 *
 * UIKit's TTFLoader turns a .ttf into a single-channel MSDF atlas with a fixed
 * default charset (ASCII without `_`). Everything outside that set is drawn as
 * a missing glyph, which is why Cyrillic and underscores used to render as
 * boxes. This module widens the atlas charset to the brand fonts' real
 * coverage and serialises atlas generation, because concurrent MSDF workers
 * can produce incomplete atlases.
 */
import { TTFLoader } from '@pmndrs/uikit';
import { BRAND_CHARSET } from './fonts-charset.js';

interface FontRequest {
  url: string;
  charset?: string;
  fontSize?: number;
  textureSize?: number[];
}

interface LoaderPrototype {
  loadAsync(input: unknown, onProgress?: unknown): Promise<unknown>;
  __brandFontPatched?: boolean;
}

/** Latin, Cyrillic and typographic punctuation; 1024² fits the 309 glyphs. */
const ATLAS = {
  charset: BRAND_CHARSET,
  fontSize: 40,
  textureSize: [1024, 1024],
};

const prototype = TTFLoader.prototype as unknown as LoaderPrototype;

if (!prototype.__brandFontPatched) {
  const original = prototype.loadAsync;
  let queue: Promise<unknown> = Promise.resolve();
  prototype.loadAsync = function loadAsyncWithBrandCharset(input: unknown, onProgress?: unknown): Promise<unknown> {
    const widen = (item: unknown): FontRequest => {
      if (typeof item === 'string') return { url: item, ...ATLAS };
      const request = item as FontRequest;
      return {
        ...request,
        charset: request.charset ?? ATLAS.charset,
        fontSize: request.fontSize ?? ATLAS.fontSize,
        textureSize: request.textureSize ?? ATLAS.textureSize,
      };
    };
    const widened = Array.isArray(input) ? input.map(widen) : widen(input);
    const run = (): Promise<unknown> => original.call(this, widened, onProgress);
    const result = queue.then(run, run);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  prototype.__brandFontPatched = true;
}

/** Family names used by the UIKitML panel. */
export const BRAND_FONTS = {
  heading: 'Unbounded',
  body: 'Geologica',
  label: 'JetBrains Mono',
} as const;
