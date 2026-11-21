/**
 * The omni worker: keeps the 2.1 GB graph set, the tokenizer and the decode
 * loop off the UI thread. Only text deltas and Float32 PCM chunks cross back.
 * Template source arrives at load time from the client (vite ?raw import).
 */
import { OmniRuntime } from './runtime';
import type { RespondPayload, WorkerInbound, WorkerOutbound } from './protocol';

/** The worker-global postMessage with transferables, typed apart from the DOM Window overload. */
const post = (message: WorkerOutbound, transfer?: Transferable[]): void => {
  (self as unknown as { postMessage(m: WorkerOutbound, t?: Transferable[]): void }).postMessage(message, transfer);
};

let runtime: OmniRuntime | null = null;
let loadPromise: Promise<OmniRuntime> | null = null;
let templateSource = '';
const controllers = new Map<number, AbortController>();

async function ensureRuntime(): Promise<OmniRuntime> {
  if (runtime) return runtime;
  if (!loadPromise) {
    loadPromise = OmniRuntime.load(
      (progress) => post({ type: 'progress', progress }),
      new AbortController().signal,
      templateSource,
    ).then((loaded) => {
      runtime = loaded;
      post({ type: 'ready' });
      return loaded;
    }).catch((error: unknown) => {
      loadPromise = null;
      const message = error instanceof Error ? error.message : String(error);
      post({ type: 'loadError', message });
      throw error;
    });
  }
  return loadPromise;
}

self.onmessage = (event: MessageEvent<WorkerInbound>) => {
  const message = event.data;
  if (message.type === 'load') {
    templateSource = message.template;
    void ensureRuntime().catch(() => { /* loadError already posted */ });
    return;
  }
  if (message.type === 'cancel') {
    controllers.get(message.id)?.abort(new DOMException('Canceled', 'AbortError'));
    controllers.delete(message.id);
    return;
  }
  if (message.type === 'asr') {
    void ensureRuntime().then((loaded) => loaded.asr(message.pcm)).then((text) => {
      post({ type: 'transcript', id: message.id, text });
    }).catch((error: unknown) => {
      post({ type: 'error', id: message.id, message: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  if (message.type === 'respond') {
    const payload: RespondPayload = message.payload;
    const controller = new AbortController();
    controllers.set(payload.id, controller);
    void ensureRuntime().then((loaded) => loaded.respond({
      turns: payload.turns,
      tools: payload.tools,
      speech: payload.speech,
      toolNames: payload.toolNames,
      media: payload.media,
      signal: controller.signal,
    }, {
      onTextDelta: (text) => post({ type: 'text', id: payload.id, delta: text }),
      onAudio: (pcm) => post({ type: 'audio', id: payload.id, pcm }, [pcm.buffer]),
      onToolCall: (name, args) => post({ type: 'tool', id: payload.id, name, args }),
    })).then((reply) => {
      controllers.delete(payload.id);
      post({ type: 'done', id: payload.id, text: reply.text, spokenFrames: reply.spokenFrames });
    }).catch((error: unknown) => {
      controllers.delete(payload.id);
      self.postMessage({
        type: 'error',
        id: payload.id,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }
};
