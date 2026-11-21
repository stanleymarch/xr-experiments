/**
 * The omni tier needs WebGPU with the shader-f16 feature and enough device
 * memory for the ~2.5 GB graph set. The probe answers honestly so the panel
 * can report exactly why the tier is unavailable (the repo's "no invisible
 * failures" rule) instead of downloading 2.1 GB into a browser that cannot
 * run it.
 */

type GpuNavigator = Navigator & {
  gpu?: {
    requestAdapter(options?: { powerPreference?: string }): Promise<{
      features: Set<string>;
    } | null>;
  };
};

export interface OmniCapability {
  capable: boolean;
  /** Empty when capable; otherwise an actionable sentence for the panel. */
  reason: string;
}

let cached: OmniCapability | null = null;

/** Probes once and caches; re-probe only after an XR session change. */
export async function getOmniCapability(): Promise<OmniCapability> {
  cached ??= await probeOmniCapability();
  return cached;
}

/** The cached result, or null before the first probe completed. */
export function peekOmniCapability(): OmniCapability | null {
  return cached;
}

export async function probeOmniCapability(): Promise<OmniCapability> {
  if (typeof navigator === 'undefined' || !((navigator as GpuNavigator).gpu)) {
    return {
      capable: false,
      reason:
        'The on-device omni model needs WebGPU. Use a recent desktop Chrome or Edge, or keep the WebLLM/Whisper stack and API presets.',
    };
  }
  let adapter: { features: Set<string> } | null = null;
  try {
    adapter = await (navigator as GpuNavigator).gpu!.requestAdapter({ powerPreference: 'high-performance' });
  } catch {
    adapter = null;
  }
  if (!adapter) {
    return {
      capable: false,
      reason: 'No WebGPU adapter was available (the GPU may be busy, blocked, or unsupported). The omni tier stays off.',
    };
  }
  if (!adapter.features.has('shader-f16')) {
    return {
      capable: false,
      reason: 'The WebGPU adapter lacks the shader-f16 feature the omni model needs. The WebLLM/Whisper stack stays available.',
    };
  }
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (typeof memory === 'number' && memory > 0 && memory < 4) {
    return {
      capable: false,
      reason: `This device reports ${memory} GB of memory; the omni model needs about 2.5 GB of GPU memory. The WebLLM stack stays available.`,
    };
  }
  return { capable: true, reason: '' };
}
