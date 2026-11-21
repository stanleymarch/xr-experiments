import { describe, expect, it } from 'vitest';
import { HOP, N_FFT, istftFromFeatures } from '../src/agent/omni/istft';

/** Forward STFT (center=False, periodic Hann) into the codec's [log-magnitude ‖ angle] layout. */
function stftFeatures(signal: Float32Array): { features: Float32Array; frames: number } {
  const bins = N_FFT / 2 + 1;
  const frames = Math.floor((signal.length - N_FFT) / HOP) + 1;
  const features = new Float32Array(frames * bins * 2);
  for (let f = 0; f < frames; f++) {
    for (let k = 0; k < bins; k++) {
      let re = 0;
      let im = 0;
      for (let n = 0; n < N_FFT; n++) {
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N_FFT);
        const v = signal[f * HOP + n] * w;
        re += v * Math.cos((2 * Math.PI * k * n) / N_FFT);
        im -= v * Math.sin((2 * Math.PI * k * n) / N_FFT);
      }
      features[f * bins * 2 + k] = Math.log(Math.hypot(re, im));
      features[f * bins * 2 + bins + k] = Math.atan2(im, re);
    }
  }
  return { features, frames };
}

describe('istftFromFeatures', () => {
  // The reference irfft is the naive O(N_FFT·bins) form; the golden round-trip
  // is intentionally exact, so give it room on loaded CI machines.
  it('reconstructs a signal from its log-magnitude/angle STFT, trimmed like the codec', { timeout: 30000 }, () => {
    const length = N_FFT + HOP * 11;
    const signal = new Float32Array(length);
    for (let i = 0; i < length; i++) signal[i] = 0.5 * Math.sin(i * 0.05) + 0.25 * Math.sin(i * 0.31 + 1);
    const { features, frames } = stftFeatures(signal);

    const audio = istftFromFeatures(features, frames);

    const trim = (N_FFT - HOP) / 2;
    expect(audio.length).toBe((frames - 1) * HOP + N_FFT - 2 * trim);
    for (let i = 0; i < audio.length; i += 37) expect(audio[i]).toBeCloseTo(signal[i + trim], 3);
  });
});
