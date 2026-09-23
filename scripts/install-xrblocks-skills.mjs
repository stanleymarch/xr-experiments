// Синк скиллов XR Blocks в .agents/skills/ — их оттуда подхватывает
// OMP-провайдер скиллов (`.agent[s]/skills` грузится по умолчанию).
// Запускается postinstall'ом: скиллы всегда соответствуют версии SDK
// из package-lock. Чужие (не xb-*) скиллы в .agents/skills не трогаем.
import {cpSync, rmSync, readdirSync, existsSync, mkdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'xrblocks', 'skills');
const dest = join(root, '.agents', 'skills');

if (!existsSync(src)) {
  console.log('xrblocks not installed; nothing to sync');
  process.exit(0);
}

mkdirSync(dest, {recursive: true});
const names = readdirSync(src, {withFileTypes: true})
  .filter((d) => d.isDirectory() && existsSync(join(src, d.name, 'SKILL.md')))
  .map((d) => d.name);

for (const name of names) {
  rmSync(join(dest, name), {recursive: true, force: true});
  cpSync(join(src, name), join(dest, name), {recursive: true});
}

// Устаревшие xb-* скиллы, которых больше нет в пакете, убираем.
for (const d of readdirSync(dest, {withFileTypes: true})) {
  if (d.isDirectory() && d.name.startsWith('xb-') && !names.includes(d.name)) {
    rmSync(join(dest, d.name), {recursive: true, force: true});
  }
}

console.log(`xrblocks skills synced: ${names.join(', ')}`);
