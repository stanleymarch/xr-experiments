/**
 * REALITY//FIELD — shared runtime handles.
 *
 * One world, one experience: the systems need to agree on the wave field,
 * the pointer state and the skin mesh without threading references through
 * every constructor. A module-level holder keeps that wiring small and
 * mirrors the sibling Weather Room's shared room model.
 */

import { Mesh, Vector3 } from '@iwsdk/core';
import { PointerTracker } from './hands.js';
import { SurfacePicker } from './picker.js';
import { WaveField } from './wave.js';

export const fieldRuntime = {
  /** The elastic field every surface reacts to. */
  wave: new WaveField(),
  /** Live hand/controller poses. */
  pointers: new PointerTracker(),
  /** Analytic picker over the sensed surfaces. */
  picker: new SurfacePicker(),
  /** The world-space skin over the sensed room (null until it is built). */
  skin: null as Mesh | null,
  /** Bumped whenever the skin geometry is replaced. */
  skinVersion: 0,
  /** Head position, refreshed by the sensing system. */
  head: new Vector3(),
};
