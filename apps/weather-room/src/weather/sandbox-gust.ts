/**
 * Sandbox gust channel: one transient, decaying *directional* wind boost
 * that accepted hand sweeps (and nothing else, plus the explicit UI
 * controller path through `trySandboxGust`) can raise while the gesture
 * sandbox is on.
 *
 * The envelope is stepped once per frame by GestureSandboxSystem and read by
 * the weather layers as an *additive vector* on top of the shared forecast
 * wind, so a wave of a hand visibly bends the rain, drives the wind streaks
 * and hurries the cloud deck even when the fetched dataset is calm — no
 * nonzero current-weather wind is required, and the sweep's own direction is
 * what the room answers with. Outside the sandbox (or after decay) the
 * weather-driven direction/speed are untouched.
 *
 * Emission contract (shared with UI owner): `triggerSandboxGust` stores the
 * vector and raises the envelope but never emits; the caller (`trySandboxGust`
 * for UI/buttons, GestureSandboxSystem for sweeps) emits `WeatherEvent.Gust`
 * on acceptance. Audio whoosh + haptics are owned by the Gust listener, so
 * gesture and button paths can never double-answer.
 *
 * Framework-neutral by design: plain numbers, no ECS or three.js imports.
 */

/** Decay time constant: a gust is felt for roughly a second. */
export const SANDBOX_GUST_TAU_S = 0.9;
/** Sweep speed (m/s) that counts as a deliberate wave, not incidental motion. */
export const SANDBOX_GUST_MIN_SPEED_M_S = 1.1;
/** Sweep speed that maps to a full-strength gust. */
export const SANDBOX_GUST_FULL_SPEED_M_S = 2.4;
/** Per-hand re-fire cooldown; gusts may chain faster than thunder. */
export const SANDBOX_GUST_COOLDOWN_S = 0.8;
/** Peak horizontal flow the gust vector contributes at full strength (m/s). */
export const SANDBOX_GUST_PEAK_FLOW_M_S = 4.5;

import { WeatherEvent, weatherEvents, weatherStore } from './weather-state.js';
import type { GustDetail, ThunderDetail } from './weather-state.js';

const state = {
  factor: 0,
  dirX: 0,
  dirZ: -1,
  originX: 0,
  originZ: 0,
  hasOrigin: false,
  lastTriggerMs: Number.NEGATIVE_INFINITY,
};

/**
 * Raise the envelope and store the gust direction; returns true when this
 * sweep actually strengthened it. Direction defaults to scene forward (-Z)
 * when the caller passes a degenerate vector. Never emits — the caller owns
 * the `WeatherEvent.Gust` announcement (see `trySandboxGust`).
 */
export function triggerSandboxGust(
  strength: number,
  directionX = 0,
  directionZ = -1,
): boolean {
  const clamped = Math.min(1, Math.max(0, strength));
  if (!(clamped > 0)) return false;
  let dx = directionX;
  let dz = directionZ;
  const len = Math.hypot(dx, dz);
  if (!Number.isFinite(len) || len < 1e-6) {
    dx = 0;
    dz = -1;
  } else {
    dx /= len;
    dz /= len;
  }
  if (clamped <= state.factor) return false;
  state.factor = clamped;
  state.dirX = dx;
  state.dirZ = dz;
  state.hasOrigin = false;
  state.lastTriggerMs = performance.now();
  return true;
}

/** Wake origin for the travelling gust front (world XZ); gesture palms set it. */
export function sandboxGustSetOrigin(x: number, z: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return;
  state.originX = x;
  state.originZ = z;
  state.hasOrigin = true;
}

/** Exponential decay toward calm; call once per frame with the frame delta. */
export function stepSandboxGust(delta: number): void {
  if (state.factor <= 0) return;
  const dt = Number.isFinite(delta) ? Math.min(Math.max(delta, 0), 0.1) : 0.016;
  state.factor *= Math.exp(-dt / SANDBOX_GUST_TAU_S);
  if (state.factor < 1e-3) {
    state.factor = 0;
    state.hasOrigin = false;
  }
}

/** Current gust strength, 0 (calm) .. 1 (full sweep). */
export function sandboxGustFactor(): number {
  return state.factor;
}

/** Normalized stored gust direction, world X. */
export function sandboxGustDirX(): number {
  return state.dirX;
}

/** Normalized stored gust direction, world Z. */
export function sandboxGustDirZ(): number {
  return state.dirZ;
}

/** Stored wake origin, world X (0 until the first located sweep). */
export function sandboxGustOriginX(): number {
  return state.originX;
}

/** Stored wake origin, world Z (0 until the first located sweep). */
export function sandboxGustOriginZ(): number {
  return state.originZ;
}

/** True while a located sweep origin is live (cleared on full decay). */
export function sandboxGustHasOrigin(): boolean {
  return state.hasOrigin;
}

/** Seconds since the last accepted sweep; Infinity when none yet. */
export function sandboxGustAgeS(): number {
  if (!Number.isFinite(state.lastTriggerMs) || state.lastTriggerMs < 0) {
    return Number.POSITIVE_INFINITY;
  }
  return (performance.now() - state.lastTriggerMs) / 1000;
}

/**
 * Explicit thunder path for UI buttons and controller strikes: sandbox-gated,
 * emits the canonical Thunder event, returns true on acceptance. No audio or
 * haptic here — subscribers (rumble, flash, panel feedback) answer.
 */
export function trySandboxThunder(source: string): boolean {
  if (!weatherStore.state.peek().sandbox) return false;
  const detail: ThunderDetail = { source };
  weatherEvents.emit(WeatherEvent.Thunder, detail);
  return true;
}

/**
 * Explicit gust path for UI buttons: sandbox-gated, stores the vector via
 * `triggerSandboxGust`, emits the canonical Gust event on acceptance.
 * `dirX`/`dirZ` is the UI-supplied head-forward projected onto XZ.
 */
export function trySandboxGust(
  strength: number,
  dirX: number,
  dirZ: number,
  source: string,
): boolean {
  if (!weatherStore.state.peek().sandbox) return false;
  if (!triggerSandboxGust(strength, dirX, dirZ)) return false;
  const detail: GustDetail = {
    strength: Math.min(1, Math.max(0, strength)),
    dirX: state.dirX,
    dirZ: state.dirZ,
    source,
  };
  weatherEvents.emit(WeatherEvent.Gust, detail);
  return true;
}
