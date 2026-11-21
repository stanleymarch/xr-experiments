import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/agent/settings';
import { resolvePipeline } from '../src/agent/pipeline';

const base = { ...DEFAULT_SETTINGS, modelEndpoint: 'local://webllm', modelId: 'auto' };

describe('resolvePipeline', () => {
  it('resolves omni for English on a capable desktop', () => {
    expect(resolvePipeline({ ...base, speechLanguage: 'en-US' }, { capable: true }, false)).toBe('omni');
  });

  it('keeps Russian on the WebLLM stack even on a capable desktop', () => {
    expect(resolvePipeline({ ...base, speechLanguage: 'ru-RU' }, { capable: true }, false)).toBe('webllm');
  });

  it('falls back to WebLLM when the capability probe fails', () => {
    expect(resolvePipeline({ ...base, speechLanguage: 'en-US' }, { capable: false }, false)).toBe('webllm');
    expect(resolvePipeline({ ...base, speechLanguage: 'en-US' }, null, false)).toBe('webllm');
  });

  it('falls back to WebLLM inside an immersive session', () => {
    expect(resolvePipeline({ ...base, speechLanguage: 'en-US' }, { capable: true }, true)).toBe('webllm');
  });

  it('routes remote endpoints to the remote tier regardless of language', () => {
    expect(
      resolvePipeline(
        { ...base, modelEndpoint: 'https://openrouter.ai/api/v1', modelId: 'google/gemma-4-31b-it', speechLanguage: 'ru-RU' },
        { capable: true },
        false,
      ),
    ).toBe('remote');
  });
});
