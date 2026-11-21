// Dev-runtime visual verification: opens the IWSDK dev server in headless
// Chromium, waits for the scene and the panel to settle, captures a screenshot
// and the console output. Usage:
//   node scripts/dev-screenshot.mjs [output.png] [--wait <seconds>] [--url <url>]
// The screenshot lands next to the dev server logs (default .superpowers/
// sdd/2026-11-11-lfm3-omni/task-<n>-desktop.png is passed by the caller).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
};
const waitSeconds = Number(option('--wait', '25')) || 25;
const url = option('--url', 'https://localhost:8081/');
const positional = args.find((value, index) => !value.startsWith('--') && args[index - 1] !== '--wait' && args[index - 1] !== '--url');
const output = resolve(positional ?? '.superpowers/sdd/2026-11-11-lfm3-omni/desktop.png');
mkdirSync(dirname(output), { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-webgpu-adapter=default'],
});
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  ignoreHTTPSErrors: true,
});
const messages = [];
page.on('console', (message) => { messages.push(`[${message.type()}] ${message.text()}`); });
page.on('pageerror', (error) => { messages.push(`[pageerror] ${error.message}`); });
const dracoRequests = [];
page.on('response', (response) => {
  if (response.url().includes('/draco/')) dracoRequests.push(`${response.status()} ${response.url()}`);
});

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
// A fresh profile re-fetches every asset and rebuilds the MSDF atlases, so
// boot time varies; poll for the world handle instead of sleeping a guess.
const bootDeadline = Date.now() + Math.max(waitSeconds, 60) * 1000 * 2;
let booted = false;
while (Date.now() < bootDeadline) {
  booted = await page.evaluate(() => Boolean(globalThis.__agentBody?.world?.scene));
  if (booted) break;
  await page.waitForTimeout(2000);
}
if (!booted) throw new Error('the world did not boot before the deadline');
// The avatar load trails the boot; wait for it so the flags below are honest.
await page.waitForFunction(
  () => Boolean(globalThis.__agentBody?.avatarBody?.available),
  null,
  { timeout: 120000 },
).catch(() => { /* reported through the boot flags below */ });
// Frame the avatar for the record: the default desktop camera looks at the
// room centre, so the verification shot moves next to her and looks back.
await page.evaluate(() => {
  const handle = globalThis.__agentBody;
  const camera = handle?.world?.camera ?? handle?.world?.renderer?.domElement?.__camera;
  if (camera?.isCamera) {
    camera.position.set(0.6, 1.45, -0.9);
    camera.lookAt(-0.45, 1.05, -2);
    camera.updateMatrixWorld(true);
  }
});
await page.waitForTimeout(700);
await page.screenshot({ path: output });

const boot = await page.evaluate(() => {
  const handle = globalThis.__agentBody;
  return {
    hasAgentBody: Boolean(handle),
    hasWorld: Boolean(handle?.world),
    worldReady: Boolean(handle?.world?.scene),
    avatarAvailable: Boolean(handle?.avatarBody?.available),
  };
});
// The character status lives in its module; import it the way the dev server
// serves it to read why an avatar may be missing.
const character = await page.evaluate(async () => {
  try {
    const module = await import('/src/agent/character.js');
    return module.getCharacterStatus();
  } catch (error) {
    return { error: String(error) };
  }
});
// Decode the first draco primitive in the PAGE context with the served
// wrapper+wasm. If this succeeds while DRACOLoader's worker fails, the problem
// is worker-specific; if it fails too, the data reaching the page differs.
const dracoProbe = await page.evaluate(async () => {
  try {
    const response = await fetch('./vrm/user.vrm');
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const jsonLength = bytes[12] | (bytes[13] << 8) | (bytes[14] << 16) | (bytes[15] << 24);
    const json = JSON.parse(new TextDecoder().decode(bytes.slice(20, 20 + jsonLength)));
    const binaryStart = 20 + jsonLength + 8;
    const binary = bytes.slice(binaryStart, binaryStart + (bytes[20 + jsonLength] | (bytes[21 + jsonLength] << 8) | (bytes[22 + jsonLength] << 16) | (bytes[23 + jsonLength] << 24)));
    const primitive = json.meshes[0].primitives[0];
    const view = json.bufferViews[primitive.extensions.KHR_draco_mesh_compression.bufferView];
    const data = binary.slice(view.byteOffset ?? 0, (view.byteOffset ?? 0) + (view.byteLength ?? 0));
    const [wrapperText, wasm] = await Promise.all([
      fetch('./draco/draco_wasm_wrapper.js').then((r) => r.text()),
      fetch('./draco/draco_decoder.wasm').then((r) => r.arrayBuffer()),
    ]);
    const factory = new Function(`${wrapperText}; return DracoDecoderModule;`)();
    const draco = await factory({ wasmBinary: wasm, noInitialRun: true });
    const decoder = new draco.Decoder();
    const int8 = new Int8Array(data.buffer, data.byteOffset, data.byteLength);
    const type = decoder.GetEncodedGeometryType(int8);
    const mesh = new draco.Mesh();
    const status = decoder.DecodeArrayToMesh(int8, data.byteLength, mesh);
    return { type, ok: status.ok(), message: status.error_msg(), ptr: mesh.ptr, dracoBytes: data.byteLength };
  } catch (error) {
    return { probeError: String(error) };
  }
});
console.log('screenshot:', output);
console.log('boot:', JSON.stringify(boot));
console.log('character:', JSON.stringify(character));
console.log('dracoProbe:', JSON.stringify(dracoProbe));
console.log('dracoRequests:', JSON.stringify(dracoRequests));
console.log(messages.slice(-40).join('\n'));
await browser.close();
