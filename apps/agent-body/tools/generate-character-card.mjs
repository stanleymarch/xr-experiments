/**
 * Writes the bundled SillyTavern character card (spec chara_card_v3) from the
 * same source the app uses, so the exported file and the in-app export can
 * never drift apart.
 *
 * Usage: node tools/generate-character-card.mjs
 */
import esbuild from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { build } = esbuild;

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outFile = resolve(root, 'public/character/ava.characterv3.json');
const bundleFile = resolve(root, 'node_modules/.cache/agent-body-character-card.mjs');

await build({
  entryPoints: [resolve(root, 'src/agent/character-card.ts')],
  outfile: bundleFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'warning',
});

const { buildCharacterCard, serializeCharacterCard } = await import(pathToFileURL(bundleFile).href);

const card = buildCharacterCard({
  name: 'Ava',
  prompt: 'You are Ava, a thoughtful, curious companion. Reply in the language the user speaks. Be concise and honest about what you know.',
  scenario: '',
  model: 'ab-1',
});

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${serializeCharacterCard(card)}\n`, 'utf8');
console.log(`character card written to ${outFile}`);
