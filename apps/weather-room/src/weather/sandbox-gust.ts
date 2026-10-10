/**
 * Sandbox gust channel: one transient, decaying wind boost that hand sweeps
 * (and nothing else) can raise while the gesture sandbox is on.
 *
 * The envelope is stepped once per frame by GestureSandboxSystem and read by
 * the weather layers as a multiplier on the shared wind vector, so a wave of
 * a hand visibly bends the rain, drives the wind streaks and hurries the
 * cloud deck without touching the fetched dataset. Framework-neutral by
 * design: plain numbers, no ECS or three.js imports.
 */

/** Decay time constant: a gust is felt for roughly a second. */
export const SANDBOX_GUST_TAU_S = 0.9;
/** Sweep speed (m/s) that counts as a deliberate wave, not incidental motion. */
export const SANDBOX_GUST_MIN_SPEED_M_S = 1.1;
/** Sweep speed that maps to a full-strength gust. */
export const SANDBOX_GUST_FULL_SPEED_M_S = 2.4;
/** Per-hand re-fire cooldown; gusts may chain faster than thunder. */
export const SANDBOX_GUST_COOLDOWN_S = 0.8;

const state = { factor: 0 };

/** Raise the envelope; returns true when this sweep actually strengthened it. */
export function triggerSandboxGust(strength: number): boolean {
  const clamped = Math.min(1, Math.max(0, strength));
  if (clamped <= state.factor) return false;
  state.factor = clamped;
  return true;
}

/** Exponential decay toward calm; call once per frame with the frame delta. */
export function stepSandboxGust(delta: number): void {
  if (state.factor <= 0) return;
  const dt = Number.isFinite(delta) ? Math.min(Math.max(delta, 0), 0.1) : 0.016;
  state.factor *= Math.exp(-dt / SANDBOX_GUST_TAU_S);
  if (state.factor < 1e-3) state.factor = 0;
}

/** Current gust strength, 0 (calm) .. 1 (full sweep). */
export function sandboxGustFactor(): number {
  return state.factor;
}
