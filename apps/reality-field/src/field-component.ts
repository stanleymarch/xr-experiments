/**
 * REALITY//FIELD — component declaration.
 *
 * System-free module: the editor imports this manifest to build its
 * inspector, so the component must stay free of system, DOM and renderer
 * imports. Only scalar/enum fields live here — elics 3.4.x throws when
 * `setValue` is used on vector fields, so per-frame vector state (last
 * impact point, hand poses) lives in `src/field/state.ts` instead.
 */

import { createComponent, Types } from '@iwsdk/core';

export const FieldModes = {
  Dream: 'dream',
  Debug: 'debug',
} as const;

export type FieldMode = (typeof FieldModes)[keyof typeof FieldModes];

export const Field = createComponent('Field', {
  /** DREAM = poetic reconstruction, DEBUG = the technical view of the room. */
  mode: { type: Types.Enum, default: FieldModes.Dream, enum: FieldModes },
  /** Speed of the elastic wave front, meters per second. */
  waveSpeed: { type: Types.Float32, default: 1.7 },
  /** Width of the wave front, meters. */
  waveWidth: { type: Types.Float32, default: 0.34 },
  /** Live motes (particles suspended in the room air). */
  moteCount: { type: Types.Int32, default: 1400 },
});
