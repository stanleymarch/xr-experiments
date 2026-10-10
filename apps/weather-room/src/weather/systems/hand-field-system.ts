/**
 * WEATHER//ROOM hand field system: feeds the shared hand-push capsule
 * uniforms (`../hand-field.ts`) from the tracked hand joints every frame.
 *
 * The joints are read exactly the way `hand-occluder.ts` reads them —
 * `input.xr.visualAdapters.hand[h].visual.model` is the framework's own hand
 * rig, whose child nodes carry the WebXR joint names, so `getObjectByName`
 * binds once per source change and only `matrixWorld` positions are read per
 * frame (allocation-free, into preallocated vectors). The model's world
 * matrices are refreshed here because the renderer has not updated them yet
 * at this point in the frame — the same reasoning as the occluder's `place`.
 *
 * Capsule layout (2 per hand, capacity 4):
 * - Palm: wrist -> middle-finger-metacarpal, radius 6 cm: the segment that
 *   covers the palm plate a moving hand actually sweeps through the weather.
 * - Forearm: wrist -> wrist + (wrist - knuckle) * 18 cm, radius 5 cm. WebXR
 *   hands have no elbow joint, so the forearm axis is estimated as the palm
 *   axis extended back through the wrist — with tracked hands that direction
 *   is stable and the capsule only has to be approximate anyway.
 * Controllers have no joints at all; a connected controller contributes one
 * degenerate capsule (A = B = grip position, radius 7 cm), mirroring the
 * occluder's controller fallback on `player.gripSpaces`.
 *
 * Zero-cost contract: outside an XR session, with no live source, or with
 * joints missing, `uWrHandCount` is 0 and nothing else runs — no matrix
 * updates, no joint reads, and the injected shaders take their early-out
 * branch (see `hand-field.ts`).
 *
 * The system also drives the audible half of the push: hand speed (smoothed,
 * dead-banded) feeds `playPushWhoosh` from control-placement.ts, so parting
 * the weather answers with a quiet whistle that tracks how fast the hand
 * sweeps. The cue is self-guarding and silent without a running audio
 * context or a live hand.
 */

import { createSystem, Vector3 } from '@iwsdk/core';
import type { Object3D } from '@iwsdk/core';
import { handFieldUniforms } from '../hand-field.js';
import { playPushWhoosh } from '../control-placement.js';
import { trackedInputKind } from '../capabilities.js';

/** Palm capsule radius, meters (~6 cm per the hand-field spec). */
const PALM_RADIUS = 0.06;
/** Forearm capsule radius, meters. */
const FOREARM_RADIUS = 0.05;
/** Estimated forearm length beyond the wrist, meters. */
const FOREARM_LENGTH = 0.18;
/** Controller capsule radius, meters. */
const CONTROLLER_RADIUS = 0.07;
/** Hand speed below this (m/s) is not a push; the whoosh stays silent. */
const PUSH_DEAD_M_S = 0.6;
/** Hand speed that maps to the whoosh's full brightness (m/s). */
const PUSH_FULL_M_S = 3;
/** Per-hand refractory between whooshes, seconds. */
const PUSH_WHOOSH_COOLDOWN_S = 0.28;

type Handedness = 'left' | 'right';

/** One live capsule source: hand rig joints, or a controller grip space. */
interface HandBinding {
  readonly mode: 'hand' | 'controller';
  /** Object whose subtree is refreshed before joint matrices are read. */
  readonly source: Object3D;
  readonly wrist: Object3D | null;
  readonly knuckle: Object3D | null;
  readonly anchor: Object3D | null;
}

export class HandFieldSystem extends createSystem({}) {
  private readonly bindings: Record<Handedness, HandBinding | null> = {
    left: null,
    right: null,
  };
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly dir = new Vector3();
  /** Anchor this frame's capsules were built from; valid flag per hand. */
  private readonly anchorOut = new Vector3();
  private readonly anchorValid: Record<Handedness, boolean> = { left: false, right: false };
  private readonly pushPrev: Record<Handedness, Vector3> = {
    left: new Vector3(),
    right: new Vector3(),
  };
  private readonly pushHasPrev: Record<Handedness, boolean> = { left: false, right: false };
  private readonly pushCooldown: Record<Handedness, number> = { left: 0, right: 0 };
  private readonly pushSpeed: Record<Handedness, number> = { left: 0, right: 0 };

  init(): void {
    this.cleanupFuncs.push(() => {
      this.bindings.left = null;
      this.bindings.right = null;
      handFieldUniforms.uWrHandCount.value = 0;
    });
  }

  /**
   * A stopped system must not leave the last frame's capsules live: paused
   * has to mean "no push", not "frozen at the last hand pose" — the same rule
   * the depth system's stop() enforces for its own singleton. update()
   * rewrites the count on the first frame after play().
   */
  stop(): void {
    super.stop();
    handFieldUniforms.uWrHandCount.value = 0;
  }

  update(delta: number): void {
    // No immersive session: no tracked sources, and anything left over from a
    // previous session would push weather at a stale pose — clear it.
    if (this.world.xrSession == null) {
      this.bindings.left = null;
      this.bindings.right = null;
      handFieldUniforms.uWrHandCount.value = 0;
      this.resetPushFeedback('left');
      this.resetPushFeedback('right');
      return;
    }
    this.sync('left');
    this.sync('right');
    const data = handFieldUniforms.uWrHandCapsules.value;
    let count = this.writeCapsules('left', data, 0);
    this.updatePushFeedback('left', delta);
    count += this.writeCapsules('right', data, count);
    this.updatePushFeedback('right', delta);
    handFieldUniforms.uWrHandCount.value = count;
  }

  /**
   * Whoosh feedback for one pushing hand: the anchor speed (smoothed) drives
   * the shared cue from control-placement.ts — the audible half of the push,
   * next to the visual parting in the shaders. Self-guarding: silent unless a
   * hand is tracked and moving faster than the dead band.
   */
  private updatePushFeedback(hand: Handedness, delta: number): void {
    this.pushCooldown[hand] = Math.max(0, this.pushCooldown[hand] - delta);
    if (!this.anchorValid[hand]) {
      this.pushHasPrev[hand] = false;
      this.pushSpeed[hand] = 0;
      return;
    }
    const anchor = this.anchorOut;
    const prev = this.pushPrev[hand];
    if (!this.pushHasPrev[hand]) {
      prev.copy(anchor);
      this.pushHasPrev[hand] = true;
      return;
    }
    const raw = prev.distanceTo(anchor) / Math.max(delta, 1e-4);
    prev.copy(anchor);
    this.pushSpeed[hand] += (raw - this.pushSpeed[hand]) * 0.35;
    const speed01 = Math.min(
      1,
      Math.max(0, (this.pushSpeed[hand] - PUSH_DEAD_M_S) / (PUSH_FULL_M_S - PUSH_DEAD_M_S)),
    );
    if (speed01 > 0.05 && this.pushCooldown[hand] <= 0) {
      playPushWhoosh(speed01);
      this.pushCooldown[hand] = PUSH_WHOOSH_COOLDOWN_S;
    }
  }

  private resetPushFeedback(hand: Handedness): void {
    this.pushHasPrev[hand] = false;
    this.pushCooldown[hand] = 0;
    this.pushSpeed[hand] = 0;
  }

  /** Match one hand to whichever input source is live for it. */
  private sync(hand: Handedness): void {
    const adapters = this.input.xr.visualAdapters;
    const kind = trackedInputKind(this.world, hand);
    const model = adapters.hand[hand].visual?.model;
    if (kind === 'hand' && model != null) {
      this.bindHand(hand, model);
      return;
    }
    if (kind === 'controller') {
      this.bindController(hand);
      return;
    }
    this.bindings[hand] = null;
  }

  private bindHand(hand: Handedness, model: Object3D): void {
    const current = this.bindings[hand];
    if (current != null && current.mode === 'hand' && current.source === model) return;
    const wrist = model.getObjectByName('wrist');
    const knuckle = model.getObjectByName('middle-finger-metacarpal');
    if (wrist == null || knuckle == null) {
      console.warn(
        `[weather-room] hand field (${hand}): hand model has no wrist / middle-finger-metacarpal joint node`,
      );
      this.bindings[hand] = null;
      return;
    }
    this.bindings[hand] = { mode: 'hand', source: model, wrist, knuckle, anchor: null };
  }

  private bindController(hand: Handedness): void {
    const current = this.bindings[hand];
    if (current != null && current.mode === 'controller') return;
    const grip = this.player.gripSpaces[hand];
    this.bindings[hand] = { mode: 'controller', source: grip, wrist: null, knuckle: null, anchor: grip };
  }

  /**
   * Write this hand's capsules into the shared block starting at slot `base`.
   * Returns how many capsules were written (0-2). Allocation-free: only the
   * preallocated vectors are touched.
   */
  private writeCapsules(hand: Handedness, data: Float32Array, base: number): number {
    const binding = this.bindings[hand];
    if (binding == null) return 0;
    // The joints' local transforms were set by the input layer earlier this
    // frame; their world matrices are still the previous frame's until the
    // renderer updates them, so refresh the subtree here.
    binding.source.updateWorldMatrix(true, true);
    let o = base * 8;
    this.anchorValid[hand] = false;
    if (binding.mode === 'controller') {
      const anchor = binding.anchor;
      if (anchor == null) return 0;
      this.a.setFromMatrixPosition(anchor.matrixWorld);
      this.anchorOut.copy(this.a);
      this.anchorValid[hand] = true;
      data[o] = this.a.x;
      data[o + 1] = this.a.y;
      data[o + 2] = this.a.z;
      data[o + 3] = CONTROLLER_RADIUS;
      data[o + 4] = this.a.x;
      data[o + 5] = this.a.y;
      data[o + 6] = this.a.z;
      data[o + 7] = CONTROLLER_RADIUS;
      return 1;
    }
    const wrist = binding.wrist;
    const knuckle = binding.knuckle;
    if (wrist == null || knuckle == null) return 0;
    this.a.setFromMatrixPosition(wrist.matrixWorld);
    this.b.setFromMatrixPosition(knuckle.matrixWorld);
    this.anchorOut.copy(this.a);
    this.anchorValid[hand] = true;
    // Palm capsule: wrist -> middle-finger-metacarpal.
    data[o] = this.a.x;
    data[o + 1] = this.a.y;
    data[o + 2] = this.a.z;
    data[o + 3] = PALM_RADIUS;
    data[o + 4] = this.b.x;
    data[o + 5] = this.b.y;
    data[o + 6] = this.b.z;
    data[o + 7] = PALM_RADIUS;
    // Forearm capsule: extend the palm axis back through the wrist. A
    // degenerate palm axis (knuckle coincident with wrist) drops the forearm
    // capsule rather than emitting NaNs.
    this.dir.subVectors(this.a, this.b);
    if (this.dir.lengthSq() < 1e-8) return 1;
    this.dir.normalize();
    this.b.copy(this.a).addScaledVector(this.dir, FOREARM_LENGTH);
    o += 8;
    data[o] = this.a.x;
    data[o + 1] = this.a.y;
    data[o + 2] = this.a.z;
    data[o + 3] = FOREARM_RADIUS;
    data[o + 4] = this.b.x;
    data[o + 5] = this.b.y;
    data[o + 6] = this.b.z;
    data[o + 7] = FOREARM_RADIUS;
    return 2;
  }
}
