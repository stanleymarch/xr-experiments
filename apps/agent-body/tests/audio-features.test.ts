import { describe, expect, it } from 'vitest';
import { logMel, numEncoderTokens, numFrames, readFeatureConfig, type AudioFeatureConfig } from '../src/agent/omni/audio-features';

/** The feature_extractor block of LFM3-Omni's processor_config.json (pinned values). */
const CONFIG: AudioFeatureConfig = {
  sampling_rate: 16000,
  n_fft: 400,
  win_length: 400,
  hop_length: 160,
  feature_size: 128,
  log_floor: -12,
  normalization_offset: 4,
  normalization_divisor: 4,
  encoder_stride: 8,
};

describe('readFeatureConfig', () => {
  it('rejects a config missing required fields', () => {
    expect(() => readFeatureConfig(JSON.stringify({ feature_extractor: { sampling_rate: 16000 } }))).toThrow(/lacks/);
  });

  it('reads the pinned processor config fields', () => {
    const cfg = readFeatureConfig(JSON.stringify({ feature_extractor: CONFIG }));
    expect(cfg.n_fft).toBe(400);
    expect(cfg.feature_size).toBe(128);
  });
});

describe('logMel', () => {
  it('rejects a wrong sample rate instead of resampling silently', () => {
    expect(() => logMel(new Float32Array(8000), 22050, CONFIG)).toThrow(/16000 Hz/);
  });

  it('rejects empty and non-finite clips', () => {
    expect(() => logMel(new Float32Array(0), 16000, CONFIG)).toThrow(/empty/);
    const bad = new Float32Array(8000);
    bad[10] = Number.NaN;
    expect(() => logMel(bad, 16000, CONFIG)).toThrow(/not finite/);
  });

  it('produces the documented frame count and encoder token count', () => {
    // 1 second at 16 kHz: frames = 1 + ceil((16000-400)/160) = 99; tokens = ceil(99/8) = 13.
    const features = logMel(new Float32Array(16000), 16000, CONFIG);
    expect(features.numFrames).toBe(99);
    expect(features.encoderTokens).toBe(13);
    expect(features.data.length).toBe(CONFIG.feature_size * 99);
  });

  it('maps silence to the log floor, offset and divisor', () => {
    const features = logMel(new Float32Array(16000), 16000, CONFIG);
    // Every band of a silent clip has zero energy → log10(0) = -inf → floor.
    expect(features.data[0]).toBe((-12 + 4) / 4);
    expect(features.data[features.data.length - 1]).toBe((-12 + 4) / 4);
  });
});

describe('frame math', () => {
  it('matches the reference num_frames / num_encoder_tokens', () => {
    expect(numFrames(16000, CONFIG)).toBe(99);
    expect(numEncoderTokens(99, CONFIG)).toBe(13);
    expect(numEncoderTokens(1, CONFIG)).toBe(1);
  });
});
