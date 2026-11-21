/**
 * Graph-session registry for LiquidAI/LFM3-Omni-2B-ONNX, adapted from
 * brvtl/act-it-out src/model/omni.ts (MIT): one WebGPU session per graph,
 * decoder outputs kept on the GPU, per-graph download and compile progress.
 */
import * as ort from 'onnxruntime-web/webgpu';
import { CACHE_NAME, GRAPHS, MODEL_FILES, REPO, type GraphKey } from './constants';
import { fetchCached } from './fetch-cached';

export interface GraphProgress {
  graph: string;
  phase: 'download' | 'compile';
  loaded: number;
  total: number;
}

type Feeds = Record<string, ort.Tensor>;

const GRAPHS_BY_FILE = new Map<string, string>();
for (const graph of Object.values(GRAPHS)) {
  GRAPHS_BY_FILE.set(`onnx/${graph}.onnx`, graph);
  GRAPHS_BY_FILE.set(`onnx/${graph}.onnx_data`, graph);
}

function createSession(files: Map<string, Uint8Array>, graph: string): Promise<ort.InferenceSession> {
  const model = files.get(`onnx/${graph}.onnx`);
  const data = files.get(`onnx/${graph}.onnx_data`);
  if (!model || !data) throw new Error(`missing files for ${graph}`);
  return ort.InferenceSession.create(model, {
    executionProviders: ['webgpu'],
    graphOptimizationLevel: 'all',
    externalData: [{ path: `${graph}.onnx_data`, data }],
    preferredOutputLocation: graph === GRAPHS.decoder ? 'gpu-buffer' : 'cpu',
  });
}

/** Maps a decoder output cache name to the input it feeds on the next step. */
export function pastNameFor(presentName: string): string {
  return presentName.replace(/^present_conv\./, 'past_conv.').replace(/^present\./, 'past_key_values.');
}

export function initialCache(session: ort.InferenceSession, hiddenSize: number): Feeds {
  const cache: Feeds = {};
  for (const name of session.inputNames) {
    if (name.startsWith('past_conv.')) {
      cache[name] = new ort.Tensor('float16', new Uint16Array(hiddenSize * 7), [1, hiddenSize, 7]);
    } else if (name.startsWith('past_key_values.')) {
      cache[name] = new ort.Tensor('float16', new Uint16Array(0), [1, 4, 0, 128]);
    }
  }
  return cache;
}

export interface OmniSessions {
  decoder: ort.InferenceSession;
  vision: ort.InferenceSession;
  depth: ort.InferenceSession;
  codec: ort.InferenceSession;
  audio: ort.InferenceSession;
}

/** One config/tokenizer file of the pinned ONNX release, cached like the graphs. */
export async function fetchModelFile(name: string, signal: AbortSignal): Promise<Uint8Array> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const { fetchCached } = await import('./fetch-cached');
  return fetchCached(`${REPO}/${name}`, CACHE_NAME);
}

/**
 * Downloads every model file (progress per graph), then compiles the four
 * WebGPU sessions one at a time so the panel can show where the load is.
 */
export async function createGraphSessions(
  onProgress: (p: GraphProgress) => void,
  signal: AbortSignal,
  hiddenSize: number,
): Promise<OmniSessions> {
  const files = new Map<string, Uint8Array>();
  const totals = new Map<string, number>();
  for (const file of MODEL_FILES) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const url = `${REPO}/${file}`;
    const bytes = await fetchCached(url, CACHE_NAME, (p) => {
      const graph = GRAPHS_BY_FILE.get(file) ?? 'configs';
      totals.set(graph, (totals.get(graph) ?? 0) + p.total);
      onProgress({ graph, phase: 'download', loaded: p.loaded, total: p.total });
    });
    files.set(file, bytes);
    const graph = GRAPHS_BY_FILE.get(file) ?? 'configs';
    onProgress({ graph, phase: 'download', loaded: bytes.byteLength, total: totals.get(graph) ?? bytes.byteLength });
  }

  const sessions = {} as Record<GraphKey, ort.InferenceSession>;
  for (const key of Object.keys(GRAPHS) as GraphKey[]) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    onProgress({ graph: GRAPHS[key], phase: 'compile', loaded: 0, total: 1 });
    sessions[key] = await createSession(files, GRAPHS[key]);
    files.delete(`onnx/${GRAPHS[key]}.onnx_data`);
    onProgress({ graph: GRAPHS[key], phase: 'compile', loaded: 1, total: 1 });
  }
  void hiddenSize;
  return sessions as OmniSessions;
}
