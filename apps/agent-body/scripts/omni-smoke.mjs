// End-to-end omni smoke against the dev runtime: boots the app in headless
// Chromium, waits for the 2.1 GB graph set to load (Cache API makes this
// one-time), then runs a text turn and a spoken turn. The spoken audio is
// written to a WAV next to the log so the reply can be listened to later.
//   node scripts/omni-smoke.mjs [--timeout <seconds>] [--url <url>]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
};
const timeoutSeconds = Number(option('--timeout', '900')) || 900;
const url = option('--url', 'https://127.0.0.1:8081/');
const outputDir = resolve('.superpowers/sdd/2026-11-11-lfm3-omni');
mkdirSync(outputDir, { recursive: true });

/** Minimal WAV writer for mono 24 kHz float32 samples. */
function toWav(samples, sampleRate = 24000) {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buffer;
}

// The headless shell ships without GPU support; the full Chromium's new
// headless mode keeps WebGPU (and the hardware adapter) available.
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--enable-unsafe-webgpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
const messages = [];
page.on('console', (message) => messages.push(`[${message.type()}] ${message.text()}`));
page.on('pageerror', (error) => messages.push(`[pageerror] ${error.message}`));

// The dev server compiles on first request and can take minutes after a restart.
let navigated = false;
for (let attempt = 0; attempt < 3 && !navigated; attempt++) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    navigated = true;
  } catch {
    await page.waitForTimeout(5000);
  }
}
if (!navigated) throw new Error('the dev server did not answer within three attempts');

// Boot: poll for the world handle like dev-screenshot.
const bootDeadline = Date.now() + 240000;
let booted = false;
while (Date.now() < bootDeadline) {
  booted = await page.evaluate(() => Boolean(globalThis.__agentBody?.world?.scene));
  if (booted) break;
  await page.waitForTimeout(2000);
}
if (!booted) throw new Error('the world did not boot');
console.log('boot: ok');

// Load: poll the omni status until ready or failed.
const loadDeadline = Date.now() + timeoutSeconds * 1000;
let status = '';
let loadFailed = false;
while (Date.now() < loadDeadline) {
  status = await page.evaluate(() => String(globalThis.__omniTest?.status?.() ?? ''));
  if (/ready/i.test(status)) break;
  if (/failed/i.test(status)) { loadFailed = true; break; }
  process.stdout.write(`\r${status}          `);
  await page.waitForTimeout(3000);
}
console.log(`\nload: ${status}${loadFailed ? ' (FAILED)' : ''}`);
if (loadFailed || !/ready/i.test(status)) {
  console.log(messages.slice(-25).join('\n'));
  await browser.close();
  process.exit(1);
}

// Text turn (speech off): proves prefill + decode on the real graphs.
const textReply = await page.evaluate(async () => {
  const result = await globalThis.__omniTest.respond('Say hello in exactly three words.', false);
  return result.text;
});
console.log('text reply:', JSON.stringify(textReply));

// Spoken turn: interleaved output; collect the streamed PCM into a WAV.
const spoken = await page.evaluate(async () => {
  const chunks = [];
  const result = await globalThis.__omniTest.respond('Say hello in exactly three words.', true, (pcm) => chunks.push(pcm));
  const audio = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.length; }
  return { text: result.text, spokenFrames: result.spokenFrames, audio: Array.from(audio) };
});
const wavPath = resolve(`${outputDir}/omni-speech.wav`);
writeFileSync(wavPath, toWav(Float32Array.from(spoken.audio)));
let peak = 0;
for (const sample of spoken.audio) peak = Math.max(peak, Math.abs(sample));
console.log('spoken reply:', JSON.stringify(spoken.text), '| frames:', spoken.spokenFrames, '| samples:', spoken.audio.length, '| peak:', peak.toFixed(3));
console.log('wav:', wavPath);

const ok = textReply.trim().length > 0 && spoken.audio.length > 24000 && peak > 0.01;
console.log(ok ? 'SMOKE OK' : 'SMOKE INCONCLUSIVE');
console.log(messages.slice(-15).join('\n'));
await browser.close();
process.exit(ok ? 0 : 2);
