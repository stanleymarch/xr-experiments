/**
 * Adapted from Dudoxx/icedliquid src/lib/webgpu/audio-features.ts (Apache-2.0,
 * © Dudoxx UG / Acceleate Consulting - Walid Boudabbous).
 *
 * Log-mel features of a 16 kHz mono clip for the LFM3 audio encoder: periodic
 * Hann, exact real DFT, Slaney mel, log10 floor, (x + offset) / divisor — the
 * float64 transcription of mlx_vlm's lfm3_audio log_mel.
 */

/** `feature_extractor` block of processor_config.json (Lfm3OmniFeatureExtractor). */
export interface AudioFeatureConfig {
  sampling_rate: number;
  n_fft: number;
  win_length: number;
  hop_length: number;
  feature_size: number;
  log_floor: number;
  normalization_offset: number;
  normalization_divisor: number;
  encoder_stride: number;
}

/** Log-mel features, row-major [feature_size][numFrames] (the encoder's input_features minus batch). */
export interface LogMelFeatures {
  data: Float32Array;
  numMelBins: number;
  numFrames: number;
  /** Audio placeholder tokens the encoder emits for this clip: ceil(numFrames / encoder_stride). */
  encoderTokens: number;
}

const CONFIG_FIELDS = [
  'sampling_rate',
  'n_fft',
  'win_length',
  'hop_length',
  'feature_size',
  'log_floor',
  'normalization_offset',
  'normalization_divisor',
  'encoder_stride',
] as const satisfies readonly (keyof AudioFeatureConfig)[];

/** Parse processor_config.json; every field the port uses must be present and numeric. */
export function readFeatureConfig(processorConfigJson: string): AudioFeatureConfig {
  const root: unknown = JSON.parse(processorConfigJson);
  const record = (typeof root === 'object' && root !== null ? root : {}) as Record<string, unknown>;
  const block = record['feature_extractor'];
  const fe = (typeof block === 'object' && block !== null ? block : {}) as Record<string, unknown>;
  const missing = CONFIG_FIELDS.filter((field) => typeof fe[field] !== 'number');
  if (missing.length > 0) {
    throw new Error(`processor_config.json feature_extractor lacks ${missing.join(', ')}`);
  }
  const cfg = Object.fromEntries(CONFIG_FIELDS.map((field) => [field, fe[field] as number])) as unknown as AudioFeatureConfig;
  // The reference windows with a Hann of n_fft points; a shorter win_length would need centring.
  if (cfg.win_length !== cfg.n_fft) {
    throw new Error(`win_length ${cfg.win_length} != n_fft ${cfg.n_fft} is not supported`);
  }
  return cfg;
}

/** Feature frames of a clip of `numSamples` samples (the reference's num_frames). */
export function numFrames(numSamples: number, cfg: AudioFeatureConfig): number {
  return 1 + Math.max(0, Math.ceil((numSamples - cfg.n_fft) / cfg.hop_length));
}

/** Audio placeholder tokens for `frames` feature frames (the reference's num_encoder_tokens). */
export function numEncoderTokens(frames: number, cfg: AudioFeatureConfig): number {
  return Math.ceil(frames / cfg.encoder_stride);
}

/** Linear-to-mel on the Slaney scale (linear below 1 kHz, log above), as mlx_audio hz_to_mel. */
function hzToSlaneyMel(freq: number): number {
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / fSp;
  const logstep = Math.log(6.4) / 27;
  return freq >= minLogHz ? minLogMel + Math.log(freq / minLogHz) / logstep : freq / fSp;
}

function slaneyMelToHz(mel: number): number {
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / fSp;
  const logstep = Math.log(6.4) / 27;
  return mel >= minLogMel ? minLogHz * Math.exp(logstep * (mel - minLogMel)) : fSp * mel;
}

/** One Slaney-normalised triangle: weights over FFT bins [lo, lo + weights.length). */
export interface MelBand {
  lo: number;
  weights: Float64Array;
}

/** A band with no non-zero weight (also the typed fallback for a band read; bands.length === nMels). */
const EMPTY_BAND: MelBand = { lo: 0, weights: new Float64Array(0) };

const filterCache = new Map<string, MelBand[]>();

/**
 * Slaney mel filterbank (norm "slaney", mel_scale "slaney", f_min 0, f_max sr / 2), built in float64
 * and rounded to float32 per weight exactly like mel_filters(precise=True). Cached per geometry.
 */
export function melFilterbank(sampleRate: number, nFft: number, nMels: number): MelBand[] {
  const key = `${sampleRate}:${nFft}:${nMels}`;
  const hit = filterCache.get(key);
  if (hit) return hit;
  const nFreqs = Math.floor(nFft / 2) + 1;
  const freqStep = Math.floor(sampleRate / 2) / (nFreqs - 1);
  const melMax = hzToSlaneyMel(sampleRate / 2);
  const melStep = melMax / (nMels + 1);
  const fPts = Float64Array.from({ length: nMels + 2 }, (_, i) => slaneyMelToHz(i * melStep));
  const bands: MelBand[] = [];
  for (let m = 0; m < nMels; m += 1) {
    // Triangle corners (left, centre, right); m + 2 < fPts.length, so the fallbacks never apply.
    const left = fPts[m] ?? 0;
    const centre = fPts[m + 1] ?? 0;
    const right = fPts[m + 2] ?? 0;
    const enorm = 2 / (right - left);
    const row = new Float64Array(nFreqs);
    let lo = nFreqs;
    let hi = 0;
    for (let f = 0; f < nFreqs; f += 1) {
      const hz = f * freqStep;
      const down = (hz - left) / (centre - left);
      const up = (right - hz) / (right - centre);
      const weight = Math.fround(Math.max(0, Math.min(down, up)) * enorm);
      row[f] = weight;
      if (weight !== 0) {
        lo = Math.min(lo, f);
        hi = f + 1;
      }
    }
    bands.push(lo < hi ? { lo, weights: row.slice(lo, hi) } : { lo: 0, weights: new Float64Array(0) });
  }
  filterCache.set(key, bands);
  return bands;
}

/** Periodic Hann of n points: 0.5 - 0.5 cos(2 pi i / n). */
function periodicHann(n: number): Float64Array {
  return Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
}

/** cos/sin of 2 pi j / n for j in [0, n): every DFT angle is one of these (index k * i mod n). */
function twiddles(n: number): { cos: Float64Array; sin: Float64Array } {
  const cos = new Float64Array(n);
  const sin = new Float64Array(n);
  for (let j = 0; j < n; j += 1) {
    cos[j] = Math.cos((2 * Math.PI * j) / n);
    sin[j] = Math.sin((2 * Math.PI * j) / n);
  }
  return { cos, sin };
}

/** Exact n-point real DFT power |X[k]|^2 for k in [0, n / 2], float64, into `out`. */
function powerSpectrum(frame: Float64Array, tw: { cos: Float64Array; sin: Float64Array }, out: Float64Array): void {
  const n = frame.length;
  for (let k = 0; k < out.length; k += 1) {
    let re = 0;
    let im = 0;
    let idx = 0;
    for (let i = 0; i < n; i += 1) {
      // In-range typed-array reads (i < n, idx < n); `?? 0` only satisfies noUncheckedIndexedAccess.
      const x = frame[i] ?? 0;
      re += x * (tw.cos[idx] ?? 0);
      im -= x * (tw.sin[idx] ?? 0);
      idx += k;
      if (idx >= n) idx -= n;
    }
    out[k] = re * re + im * im;
  }
}

function checkClip(pcm: Float32Array, sampleRate: number, cfg: AudioFeatureConfig): void {
  if (sampleRate !== cfg.sampling_rate) {
    throw new Error(
      `audio is ${sampleRate} Hz; the encoder needs ${cfg.sampling_rate} Hz mono (resample before sending)`,
    );
  }
  if (pcm.length === 0) throw new Error('audio clip is empty');
  for (let i = 0; i < pcm.length; i += 1) {
    if (!Number.isFinite(pcm[i])) {
      throw new Error(`audio sample ${i} is not finite`);
    }
  }
}

/**
 * Log-mel features of one mono clip. Rejects a clip whose rate is not the config's sampling_rate
 * (16 kHz); resampling is the caller's job, never done silently here.
 */
export function logMel(pcm: Float32Array, sampleRate: number, cfg: AudioFeatureConfig): LogMelFeatures {
  checkClip(pcm, sampleRate, cfg);
  const nFft = cfg.n_fft;
  const hop = cfg.hop_length;
  const nMels = cfg.feature_size;
  const frames = numFrames(pcm.length, cfg);
  const bands = melFilterbank(cfg.sampling_rate, nFft, nMels);
  const window = periodicHann(nFft);
  const tw = twiddles(nFft);
  const frame = new Float64Array(nFft);
  const power = new Float64Array(Math.floor(nFft / 2) + 1);
  const data = new Float32Array(nMels * frames);
  for (let t = 0; t < frames; t += 1) {
    const start = t * hop;
    // Right padding with zeros up to n_fft + (T - 1) * hop_length, as np.pad in the reference.
    for (let i = 0; i < nFft; i += 1) {
      const s = start + i;
      // s past the clip end reads undefined → 0: the reference's right zero padding.
      frame[i] = (pcm[s] ?? 0) * (window[i] ?? 0);
    }
    powerSpectrum(frame, tw, power);
    for (let m = 0; m < nMels; m += 1) {
      const { lo, weights } = bands[m] ?? EMPTY_BAND;
      let energy = 0;
      for (let j = 0; j < weights.length; j += 1) energy += (weights[j] ?? 0) * (power[lo + j] ?? 0);
      // log10(0) = -Infinity, so an all-zero band lands on log_floor like np.maximum(-inf, floor).
      const logged = Math.max(Math.log10(energy), cfg.log_floor);
      data[m * frames + t] = (logged + cfg.normalization_offset) / cfg.normalization_divisor;
    }
  }
  return { data, numMelBins: nMels, numFrames: frames, encoderTokens: numEncoderTokens(frames, cfg) };
}
