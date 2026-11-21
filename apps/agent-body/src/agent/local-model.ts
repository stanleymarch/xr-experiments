/**
 * Local model selection.
 *
 * The local tier has to fit whatever device it runs on. A Quest 3 shares 8 GB
 * with the headset OS, the browser and the VRM scene, so the model that is
 * comfortable on a desktop (Gemma 3 1B, 711 MB VRAM) is too heavy for an
 * immersive session, while a 360M model (376 MB VRAM) is fine.
 *
 * `auto` is resolved at load time - not when the preset is applied - so the
 * same settings travel to the headset over the encrypted QR transfer and are
 * still re-evaluated there.
 */

export interface LocalModelInfo {
  id: string;
  label: string;
  /** VRAM the model needs while it is loaded, in megabytes. */
  vramMB: number;
  /** Size of the weight download, in megabytes. */
  downloadMB: number;
  /** True for models that need a short, plain prompt. */
  compact: boolean;
  note: string;
}

export const LOCAL_MODEL_AUTO = 'auto';

export const LOCAL_MODELS: Record<string, LocalModelInfo> = {
  'gemma3-1b-it-q4f16_1-MLC': {
    id: 'gemma3-1b-it-q4f16_1-MLC',
    label: 'Gemma 3 1B',
    vramMB: 711,
    downloadMB: 537,
    compact: false,
    note: 'best Russian of the small class',
  },
  'Qwen2.5-0.5B-Instruct-q4f16_1-MLC': {
    id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
    label: 'Qwen2.5 0.5B',
    vramMB: 945,
    downloadMB: 265,
    compact: true,
    note: 'multilingual, but the vocabulary table is heavy',
  },
  'SmolLM2-360M-Instruct-q4f16_1-MLC': {
    id: 'SmolLM2-360M-Instruct-q4f16_1-MLC',
    label: 'SmolLM2 360M',
    vramMB: 376,
    downloadMB: 194,
    compact: true,
    note: 'headset-safe size, English-oriented',
  },
};

let immersiveSession = false;

/** True while an immersive MR/VR session is running. */
export function setLocalImmersiveSession(value: boolean): void {
  immersiveSession = value;
}

export function isLocalImmersiveSession(): boolean {
  return immersiveSession;
}

function deviceMemoryGB(): number {
  const host = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { deviceMemory?: number });
  const memory = host?.deviceMemory;
  return typeof memory === 'number' && memory > 0 ? memory : 8;
}

/**
 * Resolve the requested model id. `auto` picks the best model that fits the
 * current device and session; any other id is honoured as typed.
 */
export function resolveLocalModel(requested: string): LocalModelInfo {
  const id = requested.trim();
  if (id && id !== LOCAL_MODEL_AUTO) {
    const known = LOCAL_MODELS[id];
    if (known) return known;
    return { id, label: id, vramMB: 0, downloadMB: 0, compact: true, note: 'custom model id' };
  }
  if (immersiveSession || deviceMemoryGB() <= 4) {
    return LOCAL_MODELS['SmolLM2-360M-Instruct-q4f16_1-MLC'];
  }
  return LOCAL_MODELS['gemma3-1b-it-q4f16_1-MLC'];}

/** One-line description for the panel status line. */
export function describeLocalModel(requested: string): string {
  const model = resolveLocalModel(requested);
  const footprint = model.vramMB ? `${model.vramMB} MB VRAM, ${model.downloadMB} MB download` : 'custom model';
  return `${model.label} (${footprint})`;
}
