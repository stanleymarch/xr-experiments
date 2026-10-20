/**
 * REALITY//FIELD — shared runtime state.
 *
 * A plain mutable object, deliberately not an ECS component: several
 * systems read the same per-frame facts (last impact, gesture labels,
 * measured counts) and vector fields cannot be written with `setValue`
 * in elics 3.4.x. The authored, user-facing values (mode, wave speed,
 * tension) live on the `Field` component instead.
 */

import { Vector3 } from '@iwsdk/core';

export type Handedness = 'left' | 'right';

/** What one hand is doing right now. */
export type GestureKind = 'none' | 'pinch' | 'open' | 'fist';

/** Per-hand snapshot, refreshed every frame by the gestures system. */
export interface HandSnapshot {
  /** A tracked pointer source is live for this hand. */
  present: boolean;
  /** 'hand' when joints are tracked, 'controller' otherwise. */
  kind: 'hand' | 'controller' | null;
  /** Continuous pinch progress, 0 (open) .. 1 (closed). */
  pinch: number;
  /** Discrete pinch state with hysteresis. */
  pinched: boolean;
  gesture: GestureKind;
  /** Pointing ray: origin and unit direction in world space. */
  rayOrigin: Vector3;
  rayDirection: Vector3;
  /** Palm (or grip) position, used to push and pull the motes. */
  palm: Vector3;
  /** True while this hand is charging an impulse (pinch held down). */
  charging: boolean;
}

const emptyHand = (): HandSnapshot => ({
  present: false,
  kind: null,
  pinch: 0,
  pinched: false,
  gesture: 'none',
  rayOrigin: new Vector3(),
  rayDirection: new Vector3(0, 0, -1),
  palm: new Vector3(),
  charging: false,
});

export const fieldState = {
  /** Current mode of the experience. */
  mode: 'dream' as 'dream' | 'debug',
  /** Two-hand stretch tension, 0..1. */
  tension: 0,
  /** Sensed surfaces backing the membrane. */
  surfaceCount: 0,
  /** Impulses emitted since the last reset. */
  impactCount: 0,
  /** Smoothed frames per second. */
  fps: 0,
  /** Last impact point and surface normal (normal points into the room). */
  impactPosition: new Vector3(),
  impactNormal: new Vector3(0, 1, 0),
  /** Time of the last impact, in the world's clock. */
  lastImpactAt: -1000,
  /** True while the pointing ray currently rests on a sensed surface. */
  touching: false,
  /** Human-readable gesture of the most recent hand, for the panel. */
  gestureLabel: 'idle',
  /** Reason the room has no surface knowledge yet, for the panel. */
  roomStatus: 'sensing',
  hands: {
    left: emptyHand(),
    right: emptyHand(),
  } as Record<Handedness, HandSnapshot>,
};

/** Reset every transient counter and gesture. */
export function resetFieldState(): void {
  fieldState.tension = 0;
  fieldState.impactCount = 0;
  fieldState.touching = false;
  fieldState.gestureLabel = 'idle';
  fieldState.hands.left = emptyHand();
  fieldState.hands.right = emptyHand();
}
