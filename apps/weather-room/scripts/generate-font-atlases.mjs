/**
 * Generate the four MSDF atlases used by the spatial panel.
 *
 * Why: `@pmndrs/uikit` builds MSDF atlases in a worker at runtime. For the full
 * Cyrillic charset that costs tens of seconds per face on a software-rendered
 * browser (and is still expensive on mobile GPUs). The panel only needs four
 * Static faces, so we generate them once and ship the glyph JSON + PNG pages.
 *
 * Usage: npm run fonts:generate
 * Requires: `npx playwright install chromium` once.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, '..');
const publicRoot = path.join(appRoot, 'public');
const outDir = path.join(publicRoot, 'fonts', 'msdf');
const tempDir = path.join(appRoot, '.font-atlas-tmp');
const manifestPath = path.join(appRoot, 'src', 'weather', 'font-atlas-manifest.json');

/**
 * Bump when the generated output shape or options change. It participates in
 * the asset hash, so browsers never keep a stale atlas after regeneration.
 */
const GENERATOR_VERSION = 2;

/** The faces the UIKitML panel actually uses. Keep in sync with spatial-fonts.ts. */
const FACES = [
  { family: 'Geologica', weight: '500', src: 'fonts/Geologica-Medium.ttf' },
  { family: 'Geologica', weight: '600', src: 'fonts/Geologica-SemiBold.ttf' },
  { family: 'Geologica', weight: '700', src: 'fonts/Geologica-Bold.ttf' },
  { family: 'Unbounded', weight: '700', src: 'fonts/Unbounded-Bold.ttf' },
];

async function main() {
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.mkdir(tempDir, { recursive: true });

  const server = await createServer({
    root: path.join(scriptDir, 'font-atlas'),
    configFile: false,
    publicDir: publicRoot,
    resolve: { dedupe: ['three', '@pmndrs/uikit', '@drawcall/uikitml'] },
    optimizeDeps: { include: ['@pmndrs/uikit', '@zappar/msdf-generator'] },
    server: {
      host: '127.0.0.1',
      port: 8094,
      strictPort: false,
      fs: { allow: [appRoot] },
    },
    logLevel: 'warn',
  });

  let browser;
  try {
    await server.listen();
    const pageUrl = server.resolvedUrls?.local?.[0];
    if (!pageUrl) throw new Error('Vite did not report a local URL');

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(300_000);
    page.on('pageerror', (error) => console.error('[generator page]', error.stack ?? error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        console.error(`[generator ${message.type()}]`, message.text());
      }
    });

    await page.goto(pageUrl, { waitUntil: 'load', timeout: 180_000 });
    await page.waitForFunction(() => window.__fontGeneratorReady === true, null, { timeout: 180_000 });
    const config = await page.evaluate(() => window.__fontConfig);

    const hash = createHash('sha256');
    hash.update(`generator:${GENERATOR_VERSION}:no-kernings`);
    hash.update(JSON.stringify(config));
    for (const face of FACES) {
      hash.update(face.src);
      hash.update(await fs.readFile(path.join(publicRoot, face.src)));
    }
    const buildId = hash.digest('hex').slice(0, 8);

    const entries = [];
    let totalBytes = 0;
    for (const face of FACES) {
      const started = Date.now();
      const url = `/${face.src.replace(/^\/+/u, '')}`;
      const result = await page.evaluate(
        ({ family, weight, faceUrl }) => window.__generateFace({ family, weight, url: faceUrl }),
        { family: face.family, weight: face.weight, faceUrl: url },
      );
      const faceInfo = result.face;
      const dataUrl = faceInfo?.pages?.[0];
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
        throw new Error(`${face.family} ${face.weight}: generator returned no PNG page`);
      }
      const png = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
      if (png.readUInt32BE(0) !== 0x89504e47 || png.toString('ascii', 12, 16) !== 'IHDR') {
        throw new Error(`${face.family} ${face.weight}: invalid PNG header`);
      }
      const width = png.readUInt32BE(16);
      const height = png.readUInt32BE(20);
      if (width !== 1024 || height !== 1024) {
        throw new Error(`${face.family} ${face.weight}: atlas is ${width}x${height}, expected 1024x1024`);
      }
      const glyphs = Array.isArray(faceInfo.chars) ? faceInfo.chars.length : 0;
      if (glyphs < 350) {
        throw new Error(`${face.family} ${face.weight}: only ${glyphs} glyphs generated`);
      }

      const base = `${face.family}-${face.weight}-${buildId}`;
      const pageFile = `${base}.png`;
      await fs.writeFile(path.join(tempDir, pageFile), png);
      faceInfo.pages = [pageFile];
      // The full font kerning table can be tens of thousands of pairs (2 MB
      // of JSON per Geologica face). Panel labels are short and do not need
      // it; keep the glyph metrics and drop kerning to keep the atlas payload
      // small. `Font` treats an empty list as "no kerning".
      faceInfo.kernings = [];
      await fs.writeFile(path.join(tempDir, `${base}.json`), JSON.stringify(faceInfo));

      entries.push({
        family: face.family,
        weight: face.weight,
        src: face.src,
        json: `fonts/msdf/${base}.json`,
        page: `fonts/msdf/${pageFile}`,
      });
      totalBytes += png.length + Buffer.byteLength(JSON.stringify(faceInfo));
      console.log(
        `${base}: ${glyphs} glyphs, ${(png.length / 1024).toFixed(0)} KiB PNG, ` +
        `${Date.now() - started} ms`,
      );
    }

    await fs.rm(outDir, { recursive: true, force: true });
    await fs.mkdir(outDir, { recursive: true });
    for (const file of await fs.readdir(tempDir)) {
      await fs.copyFile(path.join(tempDir, file), path.join(outDir, file));
    }

    const manifest = {
      version: 1,
      generatorVersion: GENERATOR_VERSION,
      buildId,
      charsetLength: config.charsetLength,
      fontSize: config.fontSize,
      textureSize: config.textureSize,
      fieldRange: config.fieldRange,
      padding: config.padding,
      fixOverlaps: config.fixOverlaps,
      fonts: entries,
    };
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`\nWrote ${entries.length} faces (${(totalBytes / 1024 / 1024).toFixed(2)} MiB) to ${outDir}`);
    console.log(`Wrote ${manifestPath}`);
  } finally {
    if (browser != null) await browser.close();
    await server.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
