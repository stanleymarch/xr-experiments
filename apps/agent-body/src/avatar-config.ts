/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { CueGesture } from './agent/contracts.js';

/** User avatar file (VRM 1.0, VRoid). Served from public/. */
export const AVATAR_URL = `${import.meta.env.BASE_URL}vrm/user.vrm`.replace(
  /\/+/gu,
  '/',
);

/** Shared world placement, unchanged between desktop, MR and VR. */
export const AVATAR_POSITION = [-0.45, 0, -2] as const;
/** Arms rest near the torso rather than in the model's authored T-pose. */
export const REST_ARM_DROP = 1.18;
/** Slight forward elbow bend, in radians. */
export const REST_ELBOW_BEND = 0.12;

/** Seconds between blink pulses (plus the blink itself). */
export const BLINK_INTERVAL_SEC = 3.7;
/** One blink pulse duration (close → open). */
export const BLINK_PHASE_SEC = 0.16;
/** Chest rotation amplitude for breathing, radians. */
export const BREATH_AMPLITUDE = 0.022;
/** Breathing angular rate, rad/s (~4.1 s cycle). */
export const BREATH_RATE = 1.5;
/** Hips roll amplitude for idle sway, radians. */
export const SWAY_AMPLITUDE = 0.008;
/** Idle sway angular rate, rad/s. */
export const SWAY_RATE = 0.6;

/** Peak mouth-open weight for the talking oscillator (0..1). */
export const TALK_AMPLITUDE = 0.35;
/** Talking mouth cycle angular rate, rad/s. */
export const TALK_RATE = 9;

// --- Text-driven visemes (speakChunk) ---
/** Streamed-text consumption rate for text-driven visemes, chars/sec. */
export const SPEAK_CHARS_PER_SEC = 14;
/** Viseme weight attack/decay time constant, milliseconds. */
export const VISEME_SWITCH_MS = 60;
/** Eased rest weight for consonant/space runs so the mouth is not frozen open. */
export const VISEME_LOW_WEIGHT = 0.15;
/** Pending-character ring buffer capacity for `speakChunk` text. */
export const SPEAK_BUFFER_CHARS = 256;

/** Minimum idle seconds between ambient expression pulses. */
export const AMBIENT_MIN_INTERVAL_SEC = 12;
/** Maximum idle seconds between ambient expression pulses. */
export const AMBIENT_MAX_INTERVAL_SEC = 30;
/** Duration of one ambient expression pulse. */
export const AMBIENT_PULSE_SEC = 1.2;
/** Peak weight of an ambient expression pulse (kept subtle). */
export const AMBIENT_MAX_WEIGHT = 0.25;

// --- Reply-driven performance cues ([[emotion|gesture]] tags) ---
/** Peak weight of a cued emotion expression (0..1). */
export const CUE_EMOTION_WEIGHT = 0.65;
/** Seconds a cued emotion takes to reach full weight. */
export const CUE_EMOTION_ATTACK_SEC = 0.35;
/** Seconds a cued emotion holds at full weight. */
export const CUE_EMOTION_HOLD_SEC = 2.4;
/** Seconds a cued emotion takes to fade back to zero. */
export const CUE_EMOTION_DECAY_SEC = 1.6;

/** Procedural fallback durations only; loaded VRMA cues use file duration. */
export const GESTURE_DURATIONS_SEC: Record<CueGesture, number> = {
  none: 0,
  wave: 2.6,
  nod: 1.4,
  shake: 1.6,
  think: 2.8,
  bow: 2.2,
};
/** Upper-arm lift (rad) away from the rest drop during a wave. */
export const GESTURE_WAVE_ARM_LIFT = 0.55;
/** Forearm swing amplitude (rad) oscillated during a wave. */
export const GESTURE_WAVE_HAND_SWING = 0.4;
/** Head pitch amplitude (rad) for each nod cycle. */
export const GESTURE_NOD_AMPLITUDE = 0.22;
/** Head yaw amplitude (rad) for each head-shake cycle. */
export const GESTURE_SHAKE_AMPLITUDE = 0.3;
/** Head roll tilt (rad) while thinking. */
export const GESTURE_THINK_TILT = 0.14;
/** Forearm raise (rad) bringing the hand toward the chin while thinking. */
export const GESTURE_THINK_HAND_RAISE = 1.05;
/** Spine pitch (rad) at the deepest point of a bow. */
export const GESTURE_BOW_SPINE = 0.4;
/** Extra head pitch (rad) added on top of the bow's spine pitch. */
export const GESTURE_BOW_HEAD = 0.2;
