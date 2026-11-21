/**
 * On-device speech synthesis. The voice model is fetched from Hugging Face
 * once and then cached by the browser; no audio leaves the device.
 *
 * Default model: `Xenova/mms-tts-rus` (VITS, byte-level tokenizer, so no
 * espeak/phonemizer is needed and Russian works out of the box).
 */

export interface LocalAudio {
  audio: Float32Array;
  samplingRate: number;
}

type Synthesizer = (text: string) => Promise<{ audio: Float32Array; sampling_rate: number }>;
type Progress = { status?: string; file?: string; progress?: number };

let synthesizer: Synthesizer | null = null;
let loadedModel = '';
let loading: Promise<Synthesizer> | null = null;

async function loadSynthesizer(
  modelId: string,
  onStatus: (status: string) => void,
): Promise<Synthesizer> {
  if (synthesizer && loadedModel === modelId) return synthesizer;
  if (loading) {
    await loading;
    return loadSynthesizer(modelId, onStatus);
  }
  loading = (async () => {
    onStatus('Voice: loading the on-device model');
    const transform = await import('@huggingface/transformers');
    const create = transform.pipeline as unknown as (
      task: string,
      model: string,
      options?: Record<string, unknown>,
    ) => Promise<Synthesizer>;
    let bucket = '';
    const options = (device: string): Record<string, unknown> => ({
      device,
      dtype: 'q8',
      progress_callback: (report: Progress) => {
        if (report.status !== 'progress') return;
        const percent = typeof report.progress === 'number' ? Math.round(report.progress) : 0;
        const next = `${report.file ?? 'model'}:${Math.floor(percent / 10) * 10}`;
        if (next === bucket) return;
        bucket = next;
        onStatus(`Voice: downloading model (${percent}%)`);
      },
    });
    let loaded: Synthesizer;
    try {
      loaded = await create('text-to-speech', modelId, options('webgpu'));
    } catch (error) {
      // WebGPU can be busy with the local LLM; the WASM backend always works.
      onStatus('Voice: WebGPU unavailable, using the CPU backend');
      loaded = await create('text-to-speech', modelId, options('wasm'));
      void error;
    }
    synthesizer = loaded;
    loadedModel = modelId;
    onStatus('Voice: model ready');
    return loaded;
  })().finally(() => { loading = null; });
  return loading;
}

/** Synthesize one utterance locally. Errors are reported, never swallowed. */
export async function synthesizeLocally(
  text: string,
  modelId: string,
  onStatus: (status: string) => void,
): Promise<LocalAudio> {
  if (!modelId.trim()) throw new Error('Set an on-device voice model, for example Xenova/mms-tts-rus');
  const run = await loadSynthesizer(modelId.trim(), onStatus);
  const result = await run(text);
  const audio = result?.audio;
  if (!audio || !audio.length) throw new Error('The on-device voice produced no audio');
  return { audio, samplingRate: result.sampling_rate || 16000 };
}
