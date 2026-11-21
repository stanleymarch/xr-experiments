/**
 * Which on-device stack runs the conversation loop. The language row and the
 * Connections preset stay orthogonal: the preset picks the LLM provider, the
 * language picks the speech pipeline. The omni tier (one LFM3-Omni-2B model
 * doing speech in/out, vision and tools on WebGPU) resolves only for English
 * on a capable non-immersive session — everywhere else the established
 * WebLLM/Whisper stack or a remote endpoint runs, as before.
 */
import type { AgentSettings } from './contracts.js';
import { isLocalLlmEndpoint } from './settings.js';

export type AgentPipeline = 'omni' | 'webllm' | 'remote';

export interface PipelineCapability {
  capable: boolean;
}

export function resolvePipeline(
  settings: Pick<AgentSettings, 'modelEndpoint' | 'speechLanguage'>,
  capability: PipelineCapability | null,
  immersive: boolean,
): AgentPipeline {
  if (!isLocalLlmEndpoint(settings.modelEndpoint)) return 'remote';
  const language = settings.speechLanguage.trim().toLowerCase();
  const english = language === 'en' || language.startsWith('en-');
  if (english && capability?.capable && !immersive) return 'omni';
  return 'webllm';
}
