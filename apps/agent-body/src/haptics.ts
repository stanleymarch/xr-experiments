/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root of this source tree.
 */

/**
 * Haptic feedback for the workspace UI.
 *
 * The convention in VR interfaces: a short, low amplitude tick confirms a
 * discrete press (a button, a toggle, a tab), a slightly stronger and longer
 * pulse marks "picked up", and a softer one marks "put down". Nothing pulses
 * on hover, and there is no continuous rumble - sustained vibration is tiring
 * and says nothing the tick does not.
 */

import type { World } from '@iwsdk/core';

export interface HapticProfile {
  readonly intensity: number;
  readonly durationMs: number;
}

/** A discrete UI press. */
export const HAPTIC_TICK: HapticProfile = { intensity: 0.22, durationMs: 16 };
/** Something was picked up. */
export const HAPTIC_GRAB: HapticProfile = { intensity: 0.45, durationMs: 32 };
/** Something was put down. */
export const HAPTIC_RELEASE: HapticProfile = { intensity: 0.18, durationMs: 16 };

interface HapticActuator {
  pulse(intensity: number, durationMs: number): Promise<void>;
}

interface HapticGamepad {
  gamepad?: { hapticActuators?: HapticActuator[] };
}

/**
 * Fire one pulse on a controller. Haptics are optional hardware, so a device
 * without actuators (or without a gamepad) is silently ignored.
 */
export function pulseHaptics(
  world: World,
  handedness: 'left' | 'right',
  profile: HapticProfile,
): void {
  const pad = world.input.xr?.gamepads?.[handedness] as unknown as
    | HapticGamepad
    | undefined;
  const actuator = pad?.gamepad?.hapticActuators?.[0];
  if (!actuator) return;
  try {
    void actuator.pulse(profile.intensity, profile.durationMs).catch(() => undefined);
  } catch {
    // A device may refuse the pulse; haptics are never critical.
  }
}
