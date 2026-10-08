/**
 * Shared XR haptic feedback for WEATHER//ROOM: the single guarded entry point
 * every interaction (panel buttons, XR enter/exit, timeline grab/snap,
 * thunder flash) pulses through. Framework-neutral like weather-state: the
 * world is only touched through optional chaining inside try/catch, so calls
 * are silent no-ops on flat desktop, in smoke pages, or with hands-only input
 * (no actuators) — and never throw.
 *
 * Brand: calm instrument, not arcade. Short single taps (10-60 ms, 0.2-0.7
 * intensity); only the thunder flash runs deep and long.
 */

/** One pulse: WebXR `hapticActuators[].pulse(intensity, ms)` envelope. */
export interface HapticPulse {
  readonly intensity: number;
  readonly durationMs: number;
}

/**
 * Haptic vocabulary. Distinct taps per interaction so each moment feels
 * different: light taps for panel buttons, grabs, and hour detents, a firm
 * tap for XR enter/exit, a double tap for snap-to-live, a subtle settle for
 * out-of-zone releases, one deep pulse for thunder.
 */
export const Haptics = {
  /** Panel buttons (-6h, +6h, NOW, Reload): light tick. */
  lightTap: { intensity: 0.3, durationMs: 20 },
  /** XR Enter / Exit: firm single pulse. */
  firmTap: { intensity: 0.6, durationMs: 50 },
  /** Timeline grab: light pulse. */
  grab: { intensity: 0.5, durationMs: 40 },
  /** Hour-crossing detent while scrubbing: short light tick. */
  hourTick: { intensity: 0.25, durationMs: 15 },
  /** Release outside the snap zone: subtle single settle tap. */
  settle: { intensity: 0.2, durationMs: 20 },
  /** Snap-to-live, first tap of the double pulse. */
  snapFirst: { intensity: 0.3, durationMs: 25 },
  /** Snap-to-live, second tap of the double pulse. */
  snapSecond: { intensity: 0.6, durationMs: 60 },
  /** Thunder flash: deep longer pulse, felt not only seen. */
  thunder: { intensity: 0.75, durationMs: 140 },
} as const satisfies Record<string, HapticPulse>;

interface HapticActuatorLike {
  pulse?: (intensity: number, durationMs: number) => unknown;
}

interface HapticWorldLike {
  renderer?: {
    xr?: {
      getSession?: () => unknown;
    };
  };
}

/**
 * Pulse every connected XR controller once. Envelopes the raw WebXR
 * `gamepad.hapticActuators[].pulse()` call so no caller touches it
 * unguarded. Silent no-op when there is no session, no actuators, or
 * anything unexpected — never throws, so UI click paths stay safe without
 * an XR session.
 */
export function pulseHaptics(world: unknown, intensity: number, durationMs: number): void {
  try {
    if (!Number.isFinite(intensity) || !Number.isFinite(durationMs)) return;
    const getSession = (world as HapticWorldLike | null | undefined)?.renderer?.xr?.getSession;
    if (typeof getSession !== 'function') return;
    const session = getSession() as { inputSources?: unknown } | null | undefined;
    const inputSources = session?.inputSources as
      | Iterable<{ gamepad?: { hapticActuators?: unknown } | null } | null>
      | null
      | undefined;
    if (inputSources == null || typeof inputSources[Symbol.iterator] !== 'function') return;
    for (const source of inputSources) {
      const actuators = source?.gamepad?.hapticActuators as
        | Iterable<HapticActuatorLike | null>
        | null
        | undefined;
      if (actuators == null || typeof actuators[Symbol.iterator] !== 'function') continue;
      for (const actuator of actuators) {
        try {
          // Promise.resolve assimilates native and foreign thenables alike;
          // a missing pulse yields undefined and resolves silently.
          void Promise.resolve(actuator?.pulse?.(intensity, durationMs)).catch(() => undefined);
        } catch {
          // One bad actuator must not block the rest.
        }
      }
    }
  } catch {
    // Haptics are best-effort: never break the interaction path.
  }
}
