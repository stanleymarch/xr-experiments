// IWSDK 1.1.0-rc reads the current process's birth time through PowerShell with
// a 1500 ms timeout. On this machine PowerShell cold-starts in ~2.4 s, so the
// plugin's runtime-owner acquisition fails ("Cannot establish this process
// birth identity") and the managed dev server never starts. This patch raises
// that timeout to 10 s in the installed @iwsdk packages. It runs on postinstall
// and no-ops when the pattern is absent (a future IWSDK that fixes or makes
// this configurable needs no change here). See .superpowers ledger, Task 1.
import { readFileSync, writeFileSync } from 'node:fs';

const files = [
  'node_modules/@iwsdk/vite-plugin-dev/dist/index.js',
  'node_modules/@iwsdk/cli/dist/runtime-owner.js',
  'node_modules/@iwsdk/cli/dist/runtime-files.js',
  'node_modules/@iwsdk/cli/dist/index.js',
];

let patched = 0;
for (const file of files) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    continue; // package layout changed; nothing to patch
  }
  let index = -1;
  let count = 0;
  while ((index = source.indexOf('timeout: 1500', index + 1)) !== -1) {
    // Only the PowerShell process-identity probes carry this timeout today;
    // keep the guard so a future unrelated 1500 is left alone.
    const context = source.slice(Math.max(0, index - 800), index + 200);
    if (!context.includes('powershell.exe')) continue;
    source = source.slice(0, index) + 'timeout: 10000' + source.slice(index + 'timeout: 1500'.length);
    count += 1;
  }
  if (count) {
    writeFileSync(file, source);
    patched += count;
    console.log(`patch-iwsdk-powershell: ${file} -> ${count} timeout(s) raised to 10s`);
  }
}
if (!patched) console.log('patch-iwsdk-powershell: nothing to patch (pattern absent)');
