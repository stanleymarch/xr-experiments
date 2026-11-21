import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  WebWorkerMLCEngine,
} from '@mlc-ai/web-llm';
import { resolveLocalModel, type LocalModelInfo } from './local-model.js';

/** Plain OpenAI-style history; the local preset deliberately has no tools. */
export interface LocalLlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

let engine: WebWorkerMLCEngine | null = null;
let worker: Worker | null = null;
let loadedModel = '';
let loading: Promise<WebWorkerMLCEngine> | null = null;
let status = '';
const listeners = new Set<(status: string) => void>();

function setStatus(next: string): void {
  if (status === next) return;
  status = next;
  for (const listener of listeners) listener(next);
}

export function getLocalLlmStatus(): string {
  return status;
}

/** Subscribe to model download/compile progress; also report the current text. */
export function onLocalLlmStatus(callback: (status: string) => void): () => void {
  listeners.add(callback);
  callback(status);
  return () => { listeners.delete(callback); };
}

type GpuNavigator = Navigator & {
  gpu?: { requestAdapter(): Promise<unknown | null> };
};

/**
 * Gemma 3 uses a sliding window. WebLLM refuses a model whose context window
 * and sliding window are both positive, so the context window is disabled.
 */
const MODEL_OVERRIDES: Record<string, Record<string, number>> = {
  'gemma3-1b-it-q4f16_1-MLC': { context_window_size: -1, attention_sink_size: 0 },
};

async function assertWebGpu(): Promise<void> {
  const gpu = typeof navigator === 'undefined' ? undefined : (navigator as GpuNavigator).gpu;
  if (!gpu) {
    throw new Error('Full local mode needs WebGPU. Use a desktop Chrome/Edge build with WebGPU enabled, or choose a free or paid API preset.');
  }
  const adapter = await gpu.requestAdapter();
  if (!adapter) {
    throw new Error('WebGPU is present but no GPU adapter is available. Close other GPU-heavy tabs, disable software rendering, or choose an API preset.');
  }
}

function createWorker(): Worker {
  return new Worker(new URL('./local-llm.worker.ts', import.meta.url), { type: 'module' });
}

async function ensureEngine(model: LocalModelInfo): Promise<WebWorkerMLCEngine> {
  const modelId = model.id;
  if (engine && loadedModel === modelId) return engine;
  if (loading) {
    await loading;
    return ensureEngine(model);
  }
  loading = (async () => {
    await assertWebGpu();
    const { CreateWebWorkerMLCEngine, prebuiltAppConfig } = await import('@mlc-ai/web-llm');
    const overrides = MODEL_OVERRIDES[modelId];
    const modelList = overrides
      ? prebuiltAppConfig.model_list.map((record) => record.model_id === modelId
        ? { ...record, overrides: { ...record.overrides, ...overrides } }
        : record)
      : prebuiltAppConfig.model_list;
    if (!engine) {
      worker = createWorker();
      engine = await CreateWebWorkerMLCEngine(worker, modelId, {
        // The Cache API cannot store Hugging Face's Xet CDN responses
        // (Cache.add() rejects them), so the model is cached in IndexedDB.
        appConfig: { ...prebuiltAppConfig, model_list: modelList, cacheBackend: 'indexeddb' },
        initProgressCallback: ({ text }) => setStatus(text),
      });
    } else {
      setStatus(`Loading ${model.label} (${model.vramMB} MB VRAM)...`);
      await engine.reload(modelId);
    }
    loadedModel = modelId;
    setStatus('');
    return engine;
  })().finally(() => { loading = null; });
  return loading;
}

/**
 * Small local models sometimes repeat the same sentence. The repetition is
 * dropped from the model's own text; nothing is invented or rewritten.
 */
function collapseRepeatedSentences(text: string): string {
  const sentences = text.split(/(?<=[.!?…])\s+/u);
  const kept: string[] = [];
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    const previous = kept[kept.length - 1]?.trim().toLowerCase();
    if (previous === trimmed.toLowerCase()) continue;
    kept.push(trimmed);
  }
  return kept.join(' ').trim();
}

/**
 * Run one text-only turn in the WebLLM worker. Throws actionable errors as-is;
 * the brain does not invent a reply when WebGPU or the model is unavailable.
 */
export async function completeLocalLlm(
  messages: LocalLlmMessage[],
  modelId: string,
  signal: AbortSignal,
): Promise<string> {
  const model = resolveLocalModel(modelId);
  const active = await ensureEngine(model);
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

  const interrupt = (): void => { void active.interruptGenerate(); };
  signal.addEventListener('abort', interrupt, { once: true });
  try {
    const completion = await active.chat.completions.create({
      messages: messages as ChatCompletionMessageParam[],
      stream: true,
      temperature: model.compact ? 0.6 : 0.7,
      max_tokens: model.compact ? 160 : 512,
      // Small models loop; a mild repetition penalty keeps the answer usable.
      ...(model.compact ? { repetition_penalty: 1.15 } : {}),
    });
    let reply = '';
    for await (const chunk of completion as AsyncIterable<ChatCompletionChunk>) {
      if (signal.aborted) break;
      reply += chunk.choices[0]?.delta?.content ?? '';
    }
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return collapseRepeatedSentences(reply);
  } finally {
    signal.removeEventListener('abort', interrupt);
  }
}

/**
 * Begin the model download and compile as soon as the user applies the local
 * preset, instead of hiding it inside the first chat turn. Progress still
 * streams through setStatus, so the panel's status line shows it live.
 */
export async function warmLocalLlm(modelId: string): Promise<void> {
  let model: LocalModelInfo;
  try {
    model = resolveLocalModel(modelId);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Unknown local model.');
    return;
  }
  setStatus(`Preparing ${model.label} (${model.downloadMB} MB download, cached)...`);
  try {
    await ensureEngine(model);
    setStatus('');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'The local model could not be loaded.');
  }
}

/** Release the WebGPU worker (used when the user changes away from local mode). */
export async function unloadLocalLlm(): Promise<void> {
  const current = engine;
  engine = null;
  loadedModel = '';
  setStatus('');
  try {
    await current?.unload();
  } catch {
    // The worker is terminated below regardless of backend state.
  }
  worker?.terminate();
  worker = null;
}
