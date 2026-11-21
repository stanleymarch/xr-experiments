import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm';

// WebLLM keeps the WebGPU model and its KV cache off the UI thread.
const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (event: MessageEvent) => handler.onmessage(event);
