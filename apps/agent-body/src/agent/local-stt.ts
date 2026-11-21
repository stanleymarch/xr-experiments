/**
 * On-device speech recognition. The model is fetched from Hugging Face once,
 * then cached by the browser; audio never leaves the page.
 */

type Transcriber = (audio: Float32Array, options?: Record<string, unknown>) => Promise<unknown>;
type Progress = { status?: string; file?: string; progress?: number };

let transcriber: Transcriber | null = null;
let transcriberModel = '';
let loading: Promise<Transcriber> | null = null;

const LANGUAGE_NAMES: Record<string, string> = {
  ar: 'arabic', de: 'german', en: 'english', es: 'spanish', fr: 'french', hi: 'hindi',
  it: 'italian', ja: 'japanese', ko: 'korean', nl: 'dutch', pl: 'polish', pt: 'portuguese',
  ru: 'russian', tr: 'turkish', uk: 'ukrainian', zh: 'chinese',
};

type GpuNavigator = Navigator & { gpu?: unknown };

function requireWebGpu(): void {
  if (typeof navigator === 'undefined' || !(navigator as GpuNavigator).gpu) {
    throw new Error('On-device Whisper needs WebGPU. Use a desktop Chrome/Edge build with WebGPU enabled, or select Browser/OpenAI-compatible STT.');
  }
}

async function loadTranscriber(
  modelId: string,
  signal: AbortSignal,
  onStatus: (status: string) => void,
): Promise<Transcriber> {
  if (transcriber && transcriberModel === modelId) return transcriber;
  if (loading) {
    await loading;
    return loadTranscriber(modelId, signal, onStatus);
  }
  loading = (async () => {
    requireWebGpu();
    onStatus('Whisper: loading on-device model');
    const transform = await import('@huggingface/transformers');
    const create = transform.pipeline as unknown as (
      task: string,
      model: string,
      options?: Record<string, unknown>,
    ) => Promise<Transcriber>;
    let progressBucket = '';
    const loaded = await create('automatic-speech-recognition', modelId, {
      device: 'webgpu',
      dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
      progress_callback: (report: Progress) => {
        if (signal.aborted || report.status !== 'progress') return;
        const percent = typeof report.progress === 'number' ? Math.round(report.progress) : 0;
        const bucket = `${report.file ?? 'model'}:${Math.floor(percent / 10) * 10}`;
        if (bucket === progressBucket) return;
        progressBucket = bucket;
        onStatus(`Whisper: downloading model (${percent}%)`);
      },
    });
    if (transcriber && transcriber !== loaded) {
      await (transcriber as Transcriber & { dispose?: () => Promise<void> }).dispose?.();
    }
    transcriber = loaded;
    transcriberModel = modelId;
    onStatus('Whisper: model ready');
    return loaded;
  })().finally(() => { loading = null; });
  return loading;
}

/** Decode any MediaRecorder blob and resample it to Whisper's 16 kHz mono input. */
export async function decodeMono16k(blob: Blob): Promise<Float32Array> {
  if (typeof AudioContext === 'undefined' || typeof OfflineAudioContext === 'undefined') {
    throw new Error('Audio decoding is unavailable in this browser');
  }
  const bytes = await blob.arrayBuffer();
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(bytes.slice(0));
    const length = Math.max(1, Math.ceil(decoded.duration * 16000));
    const offline = new OfflineAudioContext(1, length, 16000);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0).slice();
  } finally {
    await context.close().catch(() => { /* already closed */ });
  }
}

export async function transcribeLocally(
  blob: Blob,
  modelId: string,
  speechLanguage: string,
  signal: AbortSignal,
  onStatus: (status: string) => void,
): Promise<string> {
  if (!modelId.trim()) throw new Error('Set an on-device Whisper model id, for example onnx-community/whisper-base');
  if (!blob.size) throw new Error('The recording was empty');
  onStatus('Whisper: decoding recording');
  const audio = await decodeMono16k(blob);
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const run = await loadTranscriber(modelId.trim(), signal, onStatus);
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  onStatus('Microphone: transcribing on device');
  const code = speechLanguage.split(/[-_]/u)[0]?.toLowerCase() ?? '';
  const language = LANGUAGE_NAMES[code];
  const result = await run(audio, {
    task: 'transcribe',
    ...(language ? { language } : {}),
    return_timestamps: false,
    chunk_length_s: 30,
    stride_length_s: 5,
  });
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const first = Array.isArray(result) ? result[0] : result;
  const text = first && typeof first === 'object' && 'text' in first ? String(first.text) : '';
  return text.trim();
}
