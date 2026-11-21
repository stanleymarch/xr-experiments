import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { probeOmniCapability } from '../src/agent/omni/capability';

function stubNavigator(gpu: unknown, deviceMemory?: number): void {
  vi.stubGlobal('navigator', { ...(deviceMemory !== undefined ? { deviceMemory } : {}), gpu });
}

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('probeOmniCapability', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports WebGPU missing with an actionable reason', async () => {
    stubNavigator(undefined, 32);
    const probe = await probeOmniCapability();
    expect(probe.capable).toBe(false);
    expect(probe.reason).toMatch(/WebGPU/);
  });

  it('reports an adapter failure', async () => {
    stubNavigator({ requestAdapter: async () => null }, 32);
    const probe = await probeOmniCapability();
    expect(probe.capable).toBe(false);
    expect(probe.reason).toMatch(/adapter|GPU/i);
  });

  it('reports shader-f16 as the missing feature', async () => {
    stubNavigator(
      { requestAdapter: async () => ({ features: new Set<string>() }) },
      32,
    );
    const probe = await probeOmniCapability();
    expect(probe.capable).toBe(false);
    expect(probe.reason).toMatch(/shader-f16/);
  });

  it('is capable with WebGPU, shader-f16 and enough memory', async () => {
    stubNavigator(
      { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) },
      32,
    );
    const probe = await probeOmniCapability();
    expect(probe.capable).toBe(true);
    expect(probe.reason).toBe('');
  });

  it('rejects devices reporting under 4 GB of memory', async () => {
    stubNavigator(
      { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) },
      2,
    );
    const probe = await probeOmniCapability();
    expect(probe.capable).toBe(false);
    expect(probe.reason).toMatch(/memory|GB/i);
  });
});
