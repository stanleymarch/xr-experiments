/**
 * REALITY//FIELD — pointer tracking.
 *
 * Hand and controller poses come from the live XR session, not from the
 * rendered hand rig: `session.inputSources` is the authoritative list, and
 * `frame.getJointPose` gives the joint positions in the reference space.
 *
 * That choice matters for two reasons:
 * - a hand model can outlive its tracking (the rig stays in the scene after
 *   the source disappears), so a visual rig would keep reporting a hand that
 *   is no longer there;
 * - joint poses are what the impulse actually needs — the pointing ray and
 *   the pinch distance, not the skinning result.
 *
 * Outside an immersive session there is no pointer at all. The experience
 * stays alive and honest: it reports "no pointer" instead of pretending.
 *
 * Every vector here is preallocated: tracking runs every frame and must not
 * allocate.
 */

import { Vector3 } from '@iwsdk/core';
import type { World } from '@iwsdk/core';
import type { GestureKind, Handedness } from './state.js';

/** Joints read from a tracked hand. */
const WRIST = 'wrist';
const THUMB_TIP = 'thumb-tip';
const INDEX_TIP = 'index-finger-tip';
const MIDDLE_TIP = 'middle-finger-tip';
const RING_TIP = 'ring-finger-tip';
const PINKY_TIP = 'pinky-finger-tip';
const MIDDLE_METACARPAL = 'middle-finger-metacarpal';

/** Joint name type taken from the DOM lib, without naming it directly:
 * `XRJointName` is not declared in the TypeScript DOM library version this
 * project compiles against. */
type JointName = Parameters<XRHand['get']>[0];

/** Pinch distance (meters) at which a pinch reads as fully closed. */
const PINCH_CLOSED_M = 0.018;/** Pinch distance (meters) at which a pinch reads as fully open. */
const PINCH_OPEN_M = 0.075;
/** Average tip-to-wrist distance below which the hand reads as a fist. */
const FIST_MAX_M = 0.105;
/** Average tip-to-wrist distance above which the hand reads as an open palm. */
const OPEN_MIN_M = 0.16;

/** One tracked pointer for one hand. */
export interface PointerPose {
  present: boolean;
  kind: 'hand' | 'controller' | null;
  /** Continuous pinch progress, 0 (open) .. 1 (closed). */
  pinch: number;
  rayOrigin: Vector3;
  rayDirection: Vector3;
  palm: Vector3;
  /** True when the hand shape reads as a closed fist. */
  fist: boolean;
  /** True when the hand shape reads as an open palm. */
  open: boolean;
}

/** Preallocated joint slots for one hand. */
class JointSlots {
  readonly wrist = new Vector3();
  readonly thumbTip = new Vector3();
  readonly indexTip = new Vector3();
  readonly middleTip = new Vector3();
  readonly ringTip = new Vector3();
  readonly pinkyTip = new Vector3();
  readonly palm = new Vector3();
}

const makePose = (): PointerPose => ({
  present: false,
  kind: null,
  pinch: 0,
  rayOrigin: new Vector3(),
  rayDirection: new Vector3(0, 0, -1),
  palm: new Vector3(),
  fist: false,
  open: false,
});

/** Scratch vectors: tracking runs every frame and must not allocate. */
const scratchA = new Vector3();
const scratchB = new Vector3();

/**
 * Read the live pointer state for one hand.
 *
 * `pose(hand)` returns a shared, mutable pose object — read it, do not keep
 * it.
 */
export class PointerTracker {
  private readonly poses: Record<Handedness, PointerPose> = {
    left: makePose(),
    right: makePose(),
  };
  private readonly slots: Record<Handedness, JointSlots> = {
    left: new JointSlots(),
    right: new JointSlots(),
  };

  /** Latest pose for one hand. */
  pose(hand: Handedness): PointerPose {
    return this.poses[hand];
  }

  /**
   * Refresh both hands from the active session.
   * `world.xrFrame` and `world.xrReferenceSpace` are the same handles the
   * rest of the SDK reads; outside XR they are undefined and every pose is
   * reported as absent.
   */
  update(world: World): void {
    const session = world.xrSession;
    const frame = world.xrFrame;
    const reference = world.xrReferenceSpace;
    if (session == null || frame == null || reference == null) {
      this.poses.left.present = false;
      this.poses.left.kind = null;
      this.poses.right.present = false;
      this.poses.right.kind = null;
      return;
    }
    this.poses.left.present = false;
    this.poses.left.kind = null;
    this.poses.right.present = false;
    this.poses.right.kind = null;

    for (const source of session.inputSources) {
      const handedness = source.handedness;
      if (handedness !== 'left' && handedness !== 'right') continue;
      if (source.targetRayMode !== 'tracked-pointer') continue;
      if (source.hand != null && this.readHand(handedness, source, frame, reference)) {
        continue;
      }
      this.readController(handedness, source, frame, reference);
    }
  }

  /** Read a tracked hand: joints for the pinch, the palm and the pointing ray. */
  private readHand(
    hand: Handedness,
    source: XRInputSource,
    frame: XRFrame,
    reference: XRReferenceSpace,
  ): boolean {
    const handSource = source.hand as XRHand;
    const slots = this.slots[hand];
    const hasWrist = this.readJoint(handSource, frame, reference, WRIST, slots.wrist);
    const hasThumb = this.readJoint(handSource, frame, reference, THUMB_TIP, slots.thumbTip);
    const hasIndex = this.readJoint(handSource, frame, reference, INDEX_TIP, slots.indexTip);
    if (!hasWrist || !hasThumb || !hasIndex) return false;

    const pose = this.poses[hand];
    pose.present = true;
    pose.kind = 'hand';

    // Pinch: the gap between the two tips, mapped from open to closed.
    const pinchDistance = scratchA.subVectors(slots.thumbTip, slots.indexTip).length();
    const span = PINCH_OPEN_M - PINCH_CLOSED_M;
    pose.pinch = span > 0 ? Math.min(1, Math.max(0, (PINCH_OPEN_M - pinchDistance) / span)) : 0;

    // Palm position: the middle-finger metacarpal when available.
    if (this.readJoint(handSource, frame, reference, MIDDLE_METACARPAL, slots.palm)) {
      pose.palm.copy(slots.palm);
    } else {
      pose.palm.copy(slots.wrist);
    }

    // Pointing ray: prefer the session's own target ray space (the runtime
    // knows the true pointing direction); fall back to the index finger.
    let rayResolved = false;
    if (source.targetRaySpace != null) {
      const rayPose = frame.getPose(source.targetRaySpace, reference);
      if (rayPose != null) {
        const matrix = rayPose.transform.matrix;
        pose.rayOrigin.set(matrix[12], matrix[13], matrix[14]);
        pose.rayDirection.set(-matrix[8], -matrix[9], -matrix[10]).normalize();
        rayResolved = true;
      }
    }
    if (!rayResolved) {
      scratchB.addVectors(slots.thumbTip, slots.indexTip).multiplyScalar(0.5);
      pose.rayOrigin.copy(scratchB);
      scratchA.subVectors(slots.indexTip, slots.wrist);
      if (scratchA.lengthSq() > 1e-8) {
        pose.rayDirection.copy(scratchA).normalize();
      } else {
        pose.rayDirection.set(0, 0, -1);
      }
    }

    // Fist / open palm from the spread of the fingertips around the wrist.
    let reach = 0;
    let counted = 0;
    if (this.readJoint(handSource, frame, reference, MIDDLE_TIP, slots.middleTip)) {
      reach += slots.middleTip.distanceTo(slots.wrist);
      counted += 1;
    }
    if (this.readJoint(handSource, frame, reference, RING_TIP, slots.ringTip)) {
      reach += slots.ringTip.distanceTo(slots.wrist);
      counted += 1;
    }
    if (this.readJoint(handSource, frame, reference, PINKY_TIP, slots.pinkyTip)) {
      reach += slots.pinkyTip.distanceTo(slots.wrist);
      counted += 1;
    }
    const averageReach = counted > 0 ? reach / counted : 0;
    pose.fist = averageReach > 0 && averageReach < FIST_MAX_M;
    pose.open = averageReach >= OPEN_MIN_M && pose.pinch < 0.3;
    return true;
  }

  /** Read a controller: the target ray for pointing, the grip as the palm. */
  private readController(
    hand: Handedness,
    source: XRInputSource,
    frame: XRFrame,
    reference: XRReferenceSpace,
  ): void {
    const pose = this.poses[hand];
    const raySpace = source.targetRaySpace;
    const gripSpace = source.gripSpace;
    if (raySpace != null) {
      const rayPose = frame.getPose(raySpace, reference);
      if (rayPose != null) {
        const matrix = rayPose.transform.matrix;
        pose.rayOrigin.set(matrix[12], matrix[13], matrix[14]);
        // The target ray points down local -Z.
        pose.rayDirection.set(-matrix[8], -matrix[9], -matrix[10]).normalize();
        pose.present = true;
        pose.kind = 'controller';
      }
    }
    if (gripSpace != null) {
      const gripPose = frame.getPose(gripSpace, reference);
      if (gripPose != null) {
        const matrix = gripPose.transform.matrix;
        pose.palm.set(matrix[12], matrix[13], matrix[14]);
        if (!pose.present) {
          pose.present = true;
          pose.kind = 'controller';
          pose.rayOrigin.copy(pose.palm);
          pose.rayDirection.set(0, 0, -1);
        }
      }
    }
  }

  /** World position of one joint into `target`; false when not tracked. */
  private readJoint(
    handSource: XRHand,
    frame: XRFrame,
    reference: XRReferenceSpace,
    name: string,
    target: Vector3,
  ): boolean {
    const space = handSource.get(name as JointName);
    if (space == null) return false;
    const pose = frame.getJointPose?.(space, reference);
    if (pose == null) return false;
    const position = pose.transform.position;
    target.set(position.x, position.y, position.z);
    return true;
  }
}

/** Read the gesture a pose expresses, with the pinch taking priority. */
export function gestureOf(pose: PointerPose, pinched: boolean): GestureKind {
  if (!pose.present) return 'none';
  if (pinched) return 'pinch';
  if (pose.fist) return 'fist';
  if (pose.open) return 'open';
  return 'none';
}
