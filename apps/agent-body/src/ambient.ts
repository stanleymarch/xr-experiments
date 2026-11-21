/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root of this source tree.
 */

import { createSystem } from '@iwsdk/core';
import { avatarBody } from './avatar-body.js';
import {
  AMBIENT_MAX_INTERVAL_SEC,
  AMBIENT_MAX_WEIGHT,
  AMBIENT_MIN_INTERVAL_SEC,
  AMBIENT_PULSE_SEC,
} from './avatar-config.js';
import type { AvatarExpressionName } from './agent/contracts.js';

/** Expressions randomly pulsed while idle (kept subtle, weight <= 0.25). */
const AMBIENT_EXPRESSIONS: AvatarExpressionName[] = [
  'happy',
  'relaxed',
  'surprised',
];

/**
 * Ambient idle life: every 12-30 s (randomized) pulse one subtle expression
 * for ~1.2 s so the avatar does not feel inert between conversations.
 *
 * Two-state machine (`phase === 0` waiting, `phase > 0` pulsing) with all
 * state preallocated on fields; `Math.random()` is drawn only on state
 * transitions (timer firing), never per frame. Skips entirely while the
 * avatar body is unavailable or a reply-driven cue is performing, so the
 * two never fight over the same expression weights. Blink reinforcement
 * is intentionally absent — `AvatarSystem` owns blinking.
 *
 * Not self-registered: the integrator adds an `AmbientSystem` instance to
 * the world alongside `AvatarSystem`.
 */
export class AmbientSystem extends createSystem({}) {
  private timer = AMBIENT_MIN_INTERVAL_SEC;
  /** 0 = waiting for the next pulse; > 0 = seconds left in the pulse. */
  private phase = 0;
  private index = 0;

  init(): void {
    this.timer = this.nextInterval();
  }

  update(delta: number): void {
    if (!avatarBody.available) return;
    if (avatarBody.performing) {
      if (this.phase > 0) {
        avatarBody.setExpression(AMBIENT_EXPRESSIONS[this.index], 0);
        this.phase = 0;
        this.timer = this.nextInterval();
      }
      return;
    }
    if (this.phase === 0) {
      this.timer -= delta;
      if (this.timer <= 0) {
        // State transition: random draws allowed here only.
        this.index = Math.floor(Math.random() * AMBIENT_EXPRESSIONS.length);
        this.timer = this.nextInterval();
        this.phase = AMBIENT_PULSE_SEC;
      }
      return;
    }
    this.phase -= delta;
    const expression = AMBIENT_EXPRESSIONS[this.index];
    if (this.phase <= 0) {
      this.phase = 0;
      avatarBody.setExpression(expression, 0);
      return;
    }
    // 0 -> 1 -> 0 triangle envelope over the pulse.
    const t = 1 - this.phase / AMBIENT_PULSE_SEC;
    avatarBody.setExpression(
      expression,
      AMBIENT_MAX_WEIGHT * (1 - Math.abs(1 - 2 * t)),
    );
  }

  private nextInterval(): number {
    return (
      AMBIENT_MIN_INTERVAL_SEC +
      Math.random() * (AMBIENT_MAX_INTERVAL_SEC - AMBIENT_MIN_INTERVAL_SEC)
    );
  }
}
