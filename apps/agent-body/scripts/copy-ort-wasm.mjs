// Serves onnxruntime-web's WebGPU wasm from our own origin (public/ort) instead
// of a CDN, the way brvtl/act-it-out does (MIT). Runs on predev/prebuild.
import { copyFileSync, mkdirSync } from 'node:fs';

const file = 'ort-wasm-simd-threaded.asyncify.wasm';
mkdirSync('public/ort', { recursive: true });
copyFileSync(`node_modules/onnxruntime-web/dist/${file}`, `public/ort/${file}`);
console.log(`copy-ort-wasm: public/ort/${file}`);
