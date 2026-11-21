/**
 * Adapted from brvtl/act-it-out src/model/constants.ts (MIT) and
 * Dudoxx/icedliquid src/lib/webgpu (Apache-2.0); token ids and decoding
 * constants of LiquidAI/LFM3-Omni-2B (config.json, generation_config.json,
 * tokenizer.json).
 */
export const TOKENS = {
  imEnd: 124900,
  textEnd: 125014,
  audioStart: 125012,
  mixedStart: 125015,
  audioOut: 125032,
  video: 125029,
  image: 125030,
  audio: 125031,
} as const;

export const NUM_CODEBOOKS = 12;
export const CODEBOOK_SIZE = 2017;
export const AUDIO_EOS_CODE = 2016;
export const MASKGIT_SCHEDULE = [4, 4, 4] as const;
export const INTERLEAVED_N_TEXT = 6;
export const INTERLEAVED_N_AUDIO = 12;
export const HIDDEN_SIZE = 2048;
export const VOCAB_SIZE = 128000;

export const SPEECH_SAMPLING = { temperature: 0.4, repetitionPenalty: 1.2, repetitionWindow: 64 } as const;

/** The official ONNX release, pinned to the commit act-it-out verified against. */
export const REPO = 'https://huggingface.co/LiquidAI/LFM3-Omni-2B-ONNX/resolve/7d6bd3fd59a0622e5ce7fefc141145a8bba1435a';
export const CACHE_NAME = 'agent-body-lfm3-omni-2b-onnx-7d6bd3f';

/** The WebGPU bundle the model card prescribes: decoder_q4f16 with the float32 side graphs of the q4 bundle. */
export const GRAPHS = {
  decoder: 'decoder_q4f16',
  vision: 'vision_encoder_q8',
  depth: 'depth_decoder',
  codec: 'codec_decoder',
  audio: 'audio_encoder',
} as const;
export type GraphKey = keyof typeof GRAPHS;

/** Every file the omni tier downloads: one .onnx plus its external .onnx_data per graph, then the configs. */
export const MODEL_FILES = [
  ...Object.values(GRAPHS).flatMap((graph) => [`onnx/${graph}.onnx`, `onnx/${graph}.onnx_data`]),
  'tokenizer.json',
  'tokenizer_config.json',
  'preprocessor_config.json',
] as const;
