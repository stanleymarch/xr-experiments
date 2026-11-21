/**
 * Main-thread client for the omni worker. Owns the request ids, the status
 * line text (what the panel shows during the 2.1 GB first load), and the
 * main-thread fallback for runtimes without module workers.
 */
import templateSource from './chat-template.jinja?raw';
import type { WorkerInbound, WorkerOutbound } from './protocol';
import type { OmniRuntime } from './runtime';
import type { OmniTurn, ToolSchema } from './types';
import type { ImagePixels } from './patchify';

export interface OmniRespondRequest {
  turns: OmniTurn[];
  tools?: ToolSchema[];
  speech: boolean;
  toolNames?: readonly string[];
  media?: { image?: ImagePixels; audioPcm?: Float32Array };
}

export interface OmniStreamHandlers {
  onTextDelta?: (text: string) => void;
  onAudio?: (pcm: Float32Array) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
}

export interface OmniClient {
  /** Loads the graphs once; progress goes to onOmniStatus listeners. */
  ensureLoaded(): Promise<void>;
  /** Streams one reply; resolves with the final text. */
  respond(request: OmniRespondRequest, handlers?: OmniStreamHandlers): Promise<{ text: string; spokenFrames: number }>
  /** The ASR pass over a 16 kHz mono clip. */
  asr(pcm: Float32Array): Promise<string>;
  /** Aborts the active respond request, if any. */
  cancel(): void;
  readonly loaded: boolean;
}

type StatusListener = (status: string) => void;
const listeners = new Set<StatusListener>();
let status = 'Omni model: not loaded';
function setStatus(next: string): void {
  status = next;
  for (const listener of listeners) {
    try {
      listener(next);
    } catch {
      /* a listener must not break the others */
    }
  }
}

/** The panel's engine line: what the omni tier is doing right now. */
export function getOmniStatus(): string {
  return status;
}

export function onOmniStatus(callback: StatusListener): () => void {
  listeners.add(callback);
  callback(status);
  return () => { listeners.delete(callback); };
}

function progressStatus(progress: { graph: string; phase: 'download' | 'compile'; loaded: number; total: number }): string {
  const percent = progress.total > 0 ? Math.min(100, Math.round((progress.loaded / progress.total) * 100)) : 0;
  return progress.phase === 'download'
    ? `Omni model: downloading ${progress.graph} (${percent}%)`
    : `Omni model: compiling ${progress.graph}`;
}

/**
 * Sends the pipeline to a Worker and resolves when it is ready. Falls back to
 * the in-page runtime when module workers are unavailable (same handlers, no
 * thread separation).
 */
async function spawn(): Promise<OmniClient> {
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL('./omni.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
  }
  if (!worker) return spawnMainThreadClient();
  return new Promise<OmniClient>((resolve, reject) => {
    const pending = new Map<number, {
      resolve: (value: { text: string; spokenFrames: number }) => void;
      reject: (error: Error) => void;
      handlers: OmniStreamHandlers;
    }>();
    const asrPending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>();
    let nextId = 1;
    let readyResolve: (() => void) | null = null;
    let readyReject: ((error: Error) => void) | null = null;
    let ready = false;
    let activeRespond = 0;
    let activeRespondId: number | null = null;
    let clientRef: OmniClient;

    worker!.onmessage = (event: MessageEvent<WorkerOutbound>) => {
      const message = event.data;
      switch (message.type) {
        case 'progress':
          setStatus(progressStatus(message.progress));
          break;
        case 'ready':
          ready = true;
          setStatus('Omni model: ready');
          readyResolve?.();
          break;
        case 'loadError':
          setStatus(`Omni model failed: ${message.message}`);
          readyReject?.(new Error(message.message));
          break;
        case 'text':
          pending.get(message.id)?.handlers.onTextDelta?.(message.delta);
          break;
        case 'audio':
          pending.get(message.id)?.handlers.onAudio?.(message.pcm);
          break;
        case 'tool':
          pending.get(message.id)?.handlers.onToolCall?.(message.name, message.args);
          break;
        case 'transcript':
          asrPending.get(message.id)?.resolve(message.text);
          asrPending.delete(message.id);
          break;
        case 'done':
          pending.get(message.id)?.resolve({ text: message.text, spokenFrames: message.spokenFrames });
          pending.delete(message.id);
          if (activeRespondId === message.id) activeRespondId = null;
          if (--activeRespond === 0) setStatus('Omni model: ready');
          break;
        case 'error':
          pending.get(message.id)?.reject(new Error(message.message));
          pending.delete(message.id);
          asrPending.get(message.id)?.reject(new Error(message.message));
          asrPending.delete(message.id);
          if (activeRespondId === message.id) activeRespondId = null;
          if (--activeRespond < 0) activeRespond = 0;
          setStatus('Omni model: ready');
          break;
      }
    };
    worker!.onerror = (event) => {
      const error = new Error(`omni worker crashed: ${event.message}`);
      readyReject?.(error);
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    };

    const post = (message: WorkerInbound): void => {
      worker!.postMessage(message);
    };

    const client: OmniClient = {
      async ensureLoaded() {
        if (ready) return;
        setStatus('Omni model: loading');
        await new Promise<void>((res, rej) => {
          readyResolve = res;
          readyReject = rej;
          post({ type: 'load', template: templateSource });
        });
      },
      async respond(request, handlers) {
        const id = nextId++;
        if (!ready) await clientRef.ensureLoaded();
        return new Promise<{ text: string; spokenFrames: number }>((res, rej) => {
          pending.set(id, { resolve: res, reject: rej, handlers: handlers ?? {} });
          activeRespondId = id;
          activeRespond++;
          setStatus('Omni model: generating');
          post({
            type: 'respond',
            payload: {
              id,
              turns: request.turns,
              tools: request.tools,
              speech: request.speech,
              toolNames: request.toolNames,
              media: request.media,
            },
          });
        });
      },
      async asr(pcm) {
        const id = nextId++;
        if (!ready) await clientRef.ensureLoaded();
        return new Promise<string>((res, rej) => {
          asrPending.set(id, { resolve: res, reject: rej });
          post({ type: 'asr', id, pcm }, );
        });
      },
      cancel() {
        if (activeRespondId !== null) post({ type: 'cancel', id: activeRespondId });
      },
      get loaded() {
        return ready;
      },
    };
    clientRef = client;
    resolve(client);
    // Kick the load immediately so the progress line is live.
    post({ type: 'load', template: templateSource });
  }).catch(async (error: unknown) => {
    // A worker that fails before init (e.g. no module-worker support) falls
    // back to the in-page runtime.
    if (error instanceof Error && error.message.includes('crashed')) throw error;
    return spawnMainThreadClient();
  });
}

/** Same interface, driven by the in-page runtime (no worker). */
async function spawnMainThreadClient(): Promise<OmniClient> {
  const { OmniRuntime } = await import('./runtime');
  const { probeOmniCapability } = await import('./capability');
  const probe = await probeOmniCapability();
  if (!probe.capable) throw new Error(probe.reason);
  setStatus('Omni model: loading');
  let runtime: OmniRuntime | null = null;
  let ready = false;
  const load = OmniRuntime.load(
    (progress) => setStatus(progressStatus(progress)),
    new AbortController().signal,
    templateSource,
  ).then((loaded) => {
    runtime = loaded;
    ready = true;
    setStatus('Omni model: ready');
    return loaded;
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Omni model failed: ${message}`);
    throw error;
  });
  return {
    async ensureLoaded() {
      if (!ready) await load;
    },
    async respond(request, handlers) {
      if (!runtime) await load;
      setStatus('Omni model: generating');
      const reply = await runtime!.respond({
        turns: request.turns,
        tools: request.tools,
        speech: request.speech,
        toolNames: request.toolNames,
        media: request.media,
      }, handlers);
      setStatus('Omni model: ready');
      return { text: reply.text, spokenFrames: reply.spokenFrames };
    },
    async asr(pcm) {
      if (!runtime) await load;
      return runtime!.asr(pcm);
    },
    cancel() { /* the in-page runtime honors its own abort signals per call */ },
    get loaded() {
      return ready;
    },
  };
}

/** The shared client; the first call spawns the worker and starts the load. */
let clientPromise: Promise<OmniClient> | null = null;
let readyFlag = false;
void onOmniStatus((value) => {
  if (value === 'Omni model: ready') readyFlag = true;
});

function getClient(): Promise<OmniClient> {
  if (!clientPromise) {
    clientPromise = spawn().catch((error: unknown) => {
      clientPromise = null;
      setStatus(`Omni model failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    });
  }
  return clientPromise;
}

export const omniClient: OmniClient = {
  ensureLoaded: () => getClient().then((client) => client.ensureLoaded()),
  respond: (request, handlers) => getClient().then((client) => client.respond(request, handlers)),
  asr: (pcm) => getClient().then((client) => client.asr(pcm)),
  cancel: () => {
    void getClient().then((client) => client.cancel()).catch(() => { /* not spawned yet */ });
  },
  get loaded() {
    return readyFlag;
  },
};

/** Dev-only harness: drive the tier from the console without the panel. */
export function installDevHarness(): void {
  if (!import.meta.env.DEV) return;
  (window as unknown as Record<string, unknown>).__omniTest = {
    status: () => getOmniStatus(),
    respond: (text: string, speech = false, onAudio?: (pcm: Float32Array) => void) => omniClient.respond({
      turns: [{ role: 'user', content: [{ type: 'text', text }] }],
      speech,
      toolNames: ['avatar_perform'],
    }, { onAudio }),
    asr: (pcm: Float32Array) => omniClient.asr(pcm),
  };
}

/**
 * Boot-time hook: when the resolved pipeline is omni, start the graph load in
 * the background. Never awaited; the status line reports progress and the
 * panel message covers failures.
 */
export function warmOmniIfSelected(): void {
  void (async () => {
    const { agentState } = await import('../state.js');
    const { resolvePipeline } = await import('../pipeline.js');
    const { getOmniCapability } = await import('./capability.js');
    const { isLocalImmersiveSession } = await import('../local-model.js');
    await agentState.ready;
    const pipeline = resolvePipeline(agentState.getSettings(), await getOmniCapability(), isLocalImmersiveSession());
    if (pipeline !== 'omni') return;
    await omniClient.ensureLoaded();
  })().catch(() => { /* the status line carries the failure */ });
}
