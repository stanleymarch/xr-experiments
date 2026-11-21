import { z } from 'zod';
import type { AgentSettings } from './contracts.js';
export const agentSettingsSchema = z.object({
  agentName: z.string().min(1),
  idleMotion: z.boolean(),
  gazeTracking: z.boolean(),
  modelEndpoint: z.string(),
  modelId: z.string(),
  modelApiKey: z.string(),
  characterVrmUrl: z.string(),
  characterPrompt: z.string(),
  characterScale: z.number().min(0.5).max(2),
  speechLanguage: z.string().min(2),
  ttsProvider: z.enum(['off', 'browser', 'local', 'openai']),
  ttsEndpoint: z.string(),
  ttsModel: z.string(),
  ttsVoice: z.string(),
  ttsApiKey: z.string(),
  sttProvider: z.enum(['off', 'browser', 'local', 'openai']),
  sttEndpoint: z.string(),
  sttModel: z.string(),
  sttApiKey: z.string(),
});

/** WebLLM model ids are resolved against WebLLM's prebuilt model list. */
export const LOCAL_LLM_ENDPOINT = 'local://webllm';
/** `auto` picks the model that fits the device at load time (see local-model.ts). */
export const LOCAL_LLM_MODEL = 'auto';
export const LOCAL_STT_MODEL = 'onnx-community/whisper-base';
export const LOCAL_TTS_MODEL = 'Xenova/mms-tts-rus';
export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1';

export function isLocalLlmEndpoint(endpoint: string): boolean {
  return endpoint.trim().toLowerCase().startsWith('local://');
}

/**
 * Presets fill the draft only. Credentials are never included, copied, or
 * cleared by a preset, so an existing key keeps working across tiers.
 */
export const LOCAL_PRESET = {
  modelEndpoint: LOCAL_LLM_ENDPOINT,
  modelId: LOCAL_LLM_MODEL,
  sttProvider: 'local',
  sttModel: LOCAL_STT_MODEL,
  sttEndpoint: '',
  // The operating-system voice is local, free and intelligible; the on-device
  // neural voice (MMS-TTS) stays available but is much harder to understand.
  ttsProvider: 'browser',
  ttsVoice: '',
} as const satisfies Partial<AgentSettings>;

export const FREE_PRESET = {
  modelEndpoint: OPENROUTER_ENDPOINT,
  modelId: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  sttProvider: 'browser',
  ttsProvider: 'browser',
  ttsVoice: '',
} as const satisfies Partial<AgentSettings>;

export const PAID_PRESET = {
  modelEndpoint: OPENROUTER_ENDPOINT,
  /** Paid Gemma 4 31B: OpenRouter is told to sort providers by price. */
  modelId: 'google/gemma-4-31b-it',
  sttProvider: 'browser',
  ttsProvider: 'openai',
  ttsEndpoint: OPENROUTER_ENDPOINT,
  ttsModel: 'fish-audio/s2.1-pro-free:free',
  ttsVoice: 'b347db033a6549378b48d00acb0d06cd',
} as const satisfies Partial<AgentSettings>;

export const DEFAULT_SETTINGS: AgentSettings = {
  agentName: 'Ava',
  idleMotion: true,
  gazeTracking: true,
  modelEndpoint: PAID_PRESET.modelEndpoint,
  modelId: PAID_PRESET.modelId,
  modelApiKey: '',
  characterVrmUrl: '',
  characterPrompt: 'You are Ava, a thoughtful, curious companion. Reply in the language the user speaks. Be concise and honest about what you know.',
  characterScale: 1,
  speechLanguage: 'ru-RU',
  ttsProvider: 'off',
  ttsEndpoint: PAID_PRESET.ttsEndpoint,
  ttsModel: PAID_PRESET.ttsModel,
  ttsVoice: PAID_PRESET.ttsVoice,
  ttsApiKey: '',
  sttProvider: 'off',
  sttEndpoint: '',
  sttModel: '',
  sttApiKey: '',
};
