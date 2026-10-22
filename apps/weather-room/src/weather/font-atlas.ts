/**
 * Pre-generated MSDF atlas fast path for the spatial panel.
 *
 * `@pmndrs/uikit` normally builds MSDF atlases in a worker at runtime. The
 * default ASCII preload is ~19 s for six faces on a software-rendered browser,
 * and the full-Cyrillic atlas is ~99 s for six faces. The panel only ever uses
 * four faces, so `scripts/generate-font-atlases.mjs` bakes those atlases at
 * build time. This module patches `TTFLoader.loadAsync` to serve the baked
 * glyph JSON + PNG page for those exact TTF URLs.
 *
 * Both the SDK's `@font-face` preload and `spatial-fonts.ts` go through
 * `TTFLoader.loadAsync`, so both receive the same full-charset face object.
 * Unknown fonts and any load failure fall through to the stock loader, which
 * keeps the old runtime generation as a correctness fallback.
 */

import { UIKit } from '@iwsdk/core';
import manifest from './font-atlas-manifest.json';

interface FontAtlasEntry {
  family: string;
  weight: string;
  src: string;
  json: string;
  page: string;
}

interface FontAtlasManifest {
  version: number;
  generatorVersion: number;
  buildId: string;
  fonts: FontAtlasEntry[];
}

type FontFaceInfo = Exclude<UIKit.MSDFResult[string][number], string>;
type LoadAsyncInput = Parameters<UIKit.TTFLoader['loadAsync']>[0];
type LoadAsyncProgress = Parameters<UIKit.TTFLoader['loadAsync']>[1];

interface PatchableTTFLoader {
  loadAsync(
    input: LoadAsyncInput,
    onProgress?: LoadAsyncProgress,
  ): Promise<UIKit.MSDFResult>;
  __weatherPreGeneratedFonts?: boolean;
}

const atlasManifest = manifest as FontAtlasManifest;
const atlasBase = import.meta.env.BASE_URL;

function absoluteAssetUrl(file: string): string {
  return new URL(`${atlasBase}${file.replace(/^\/+/u, '')}`, window.location.href).href;
}

/** TTF URL (as resolved by the UIKitML parser) → baked atlas entry. */
const atlasBySource = new Map<string, FontAtlasEntry>();
for (const entry of atlasManifest.fonts) {
  atlasBySource.set(absoluteAssetUrl(entry.src), entry);
}

const facePromises = new Map<string, Promise<UIKit.MSDFResult>>();

function loadFace(entry: FontAtlasEntry): Promise<UIKit.MSDFResult> {
  const cached = facePromises.get(entry.json);
  if (cached != null) return cached;

  const jsonUrl = absoluteAssetUrl(entry.json);
  const promise = (async (): Promise<UIKit.MSDFResult> => {
    const response = await fetch(jsonUrl);
    if (!response.ok) {
      throw new Error(`Font atlas ${jsonUrl} failed with HTTP ${response.status}.`);
    }
    const info = (await response.json()) as FontFaceInfo;
    if (!Array.isArray(info.pages) || info.pages.length !== 1) {
      throw new Error(`Font atlas ${jsonUrl} must contain exactly one page.`);
    }
    const page = info.pages[0];
    if (typeof page !== 'string') {
      throw new Error(`Font atlas ${jsonUrl} has an invalid page reference.`);
    }
    // UIKit resolves object page URLs against the document; make it absolute
    // so the same face object works at any app base path.
    info.pages = [new URL(page, jsonUrl).href];
    return {
      [entry.family]: { [Number(entry.weight)]: info },
    } as UIKit.MSDFResult;
  })();

  facePromises.set(entry.json, promise);
  return promise;
}

function inputUrls(input: LoadAsyncInput): string[] | null {
  const items: unknown[] = Array.isArray(input) ? input : [input];
  const urls: string[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      urls.push(item);
      continue;
    }
    if (item != null && typeof item === 'object') {
      const url = (item as { url?: unknown }).url;
      if (typeof url === 'string') {
        urls.push(url);
        continue;
      }
    }
    return null;
  }
  return urls;
}

function mergeResults(results: UIKit.MSDFResult[]): UIKit.MSDFResult {
  const merged: UIKit.MSDFResult = {};
  for (const result of results) {
    for (const [family, weights] of Object.entries(result)) {
      merged[family] = { ...(merged[family] ?? {}), ...weights };
    }
  }
  return merged;
}

/**
 * Install the baked-atlas loader. Must run before `World.create()` so the
 * UIKitML `@font-face` preload already uses it.
 */
export function installPreGeneratedFonts(): void {
  if (atlasManifest.fonts.length === 0) return;

  const proto = UIKit.TTFLoader.prototype as unknown as PatchableTTFLoader;
  if (proto.__weatherPreGeneratedFonts === true) return;
  proto.__weatherPreGeneratedFonts = true;
  const original = proto.loadAsync;

  proto.loadAsync = function (
    this: UIKit.TTFLoader,
    input: LoadAsyncInput,
    onProgress?: LoadAsyncProgress,
  ): Promise<UIKit.MSDFResult> {
    const urls = inputUrls(input);
    if (urls == null) return original.call(this, input, onProgress);

    const entries = urls.map((url) =>
      atlasBySource.get(new URL(url, window.location.href).href),
    );
    if (entries.some((entry) => entry == null)) {
      return original.call(this, input, onProgress);
    }

    return Promise.all(entries.map((entry) => loadFace(entry as FontAtlasEntry)))
      .then(mergeResults)
      .catch((error: unknown) => {
        console.warn(
          '[weather-room] pre-generated font atlas unavailable; using runtime MSDF generation.',
          error,
        );
        return original.call(this, input, onProgress);
      });
  };

  // The SDK preload is sequential. Start every glyph JSON fetch now so each
  // per-face preload resolves from an already-warm promise.
  for (const entry of atlasManifest.fonts) {
    void loadFace(entry).catch(() => {
      // The loadAsync wrapper above reports the failure and falls back.
    });
  }
}
