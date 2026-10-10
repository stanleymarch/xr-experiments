import {
  createComponent,
  createSystem,
  Grabbed,
  GrabSystem,
  Matrix4,
  Mesh,
  OneHandGrabbable,
  Vector3,
} from '@iwsdk/core';
import type { Object3D } from '@iwsdk/core';
import { trackedInputKind } from '../capabilities.js';

/** Near weather controls whose explicit squeeze/pinch must outrank UI hover. */
export const WeatherControlGrip = createComponent('WeatherControlGrip', {});

const HANDS = ['left', 'right'] as const;
type Hand = (typeof HANDS)[number];
// IWSDK GrabPointer's documented sphere radius; match its bounding-box test.
const GRAB_RADIUS_SQ = 0.07 * 0.07;

/**
 * IWSDK gives poke hover priority over grab, up to 20 cm from a panel. A
 * squeeze on the panel's move bar can therefore be ignored despite a valid
 * grab intersection. Suppress only that hand's poke pointer for an explicit
 * near-control grab; restore its registration on release/loss/session end.
 * Ordinary pokes, far selects and the other hand remain unchanged.
 */
export class ControlGrabIntentSystem extends createSystem({
  controls: { required: [WeatherControlGrip, OneHandGrabbable] },
  held: { required: [Grabbed] },
}) {
  private session: XRSession | null = null;
  private readonly locked: Record<Hand, XRInputSource | null> = { left: null, right: null };
  private readonly gripPosition = new Vector3();
  private readonly localPosition = new Vector3();
  private readonly nearestPosition = new Vector3();
  private readonly inverse = new Matrix4();
  private hit = false;

  init(): void {
    this.xrManager.addEventListener('sessionstart', this.attach);
    this.xrManager.addEventListener('sessionend', this.detach);
    this.cleanupFuncs.push(
      () => this.xrManager.removeEventListener('sessionstart', this.attach),
      () => this.xrManager.removeEventListener('sessionend', this.detach),
      this.detach,
    );
    if (this.xrManager.getSession() != null) this.attach();
  }

  update(): void {
    for (const hand of HANDS) {
      const source = this.locked[hand];
      if (source != null && (!this.hasSource(source) ||
          trackedInputKind(this.world, hand) == null)) this.release(hand);
    }
  }

  private hasSource(source: XRInputSource): boolean {
    if (this.session == null) return false;
    for (const current of this.session.inputSources) {
      if (current === source) return true;
    }
    return false;
  }

  private readonly attach = (): void => {
    this.detach();
    // Three emits sessionstart before IWSDK assigns world.xrSession.
    this.session = this.xrManager.getSession();
    this.session?.addEventListener('squeezestart', this.onStart);
    this.session?.addEventListener('selectstart', this.onStart);
    this.session?.addEventListener('squeezeend', this.onEnd);
    this.session?.addEventListener('selectend', this.onEnd);
    this.session?.addEventListener('inputsourceschange', this.onSourcesChange);
    this.session?.addEventListener('visibilitychange', this.onVisibilityChange);
  };

  private readonly detach = (): void => {
    this.session?.removeEventListener('squeezestart', this.onStart);
    this.session?.removeEventListener('selectstart', this.onStart);
    this.session?.removeEventListener('squeezeend', this.onEnd);
    this.session?.removeEventListener('selectend', this.onEnd);
    this.session?.removeEventListener('inputsourceschange', this.onSourcesChange);
    this.session?.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.session = null;
    for (const hand of HANDS) this.release(hand);
  };

  private readonly onStart = (event: XRInputSourceEvent): void => {
    const source = event.inputSource;
    const hand = source.handedness;
    if ((hand !== 'left' && hand !== 'right') || source.targetRayMode !== 'tracked-pointer' ||
        this.locked[hand] != null) return;
    // Controllers squeeze; hands pinch. A controller trigger is still a ray select.
    if (event.type !== (source.hand == null ? 'squeezestart' : 'selectstart')) return;
    const pointers = this.input.xr.multiPointers[hand];
    if (!pointers.getSubPointerState('touch').registered) return;
    const grab = this.world.getSystem(GrabSystem);
    for (const entity of this.queries.held.entities) {
      if (grab?.getHolderHand(entity) === hand) return;
    }
    if (!this.readGrip(event.frame, source) || !this.hitsControl()) return;
    this.locked[hand] = source;
    pointers.toggleSubPointer('touch', false);
  };

  private readonly onEnd = (event: XRInputSourceEvent): void => {
    const source = event.inputSource;
    const hand = source.handedness;
    if ((hand === 'left' || hand === 'right') && this.locked[hand] === source &&
        event.type === (source.hand == null ? 'squeezeend' : 'selectend')) this.release(hand);
  };

  private readonly onSourcesChange = (event: XRInputSourcesChangeEvent): void => {
    for (const hand of HANDS) {
      const source = this.locked[hand];
      if (source != null && event.removed.includes(source)) this.release(hand);
    }
  };

  private readonly onVisibilityChange = (): void => {
    if (this.session?.visibilityState === 'hidden') {
      for (const hand of HANDS) this.release(hand);
    }
  };

  private release(hand: Hand): void {
    if (this.locked[hand] == null) return;
    this.locked[hand] = null;
    // We only lock pointers that were registered, never enable a user's disabled pointer.
    this.input.xr.multiPointers[hand].toggleSubPointer('touch', true);
  }

  private readGrip(frame: XRFrame, source: XRInputSource): boolean {
    const reference = this.xrManager.getReferenceSpace();
    if (reference == null) return false;
    const palm = source.hand?.get('middle-finger-metacarpal');
    const palmPose = palm != null ? frame.getJointPose?.(palm, reference) : null;
    if (source.hand != null) {
      const wrist = source.hand.get('wrist');
      if (palmPose == null || wrist == null ||
          frame.getJointPose?.(wrist, reference) == null) return false;
    }
    const pose = source.gripSpace != null
      ? frame.getPose(source.gripSpace, reference)
      : palmPose;
    if (pose == null) return false;
    const p = pose.transform.position;
    this.world.player.updateWorldMatrix(true, false);
    this.gripPosition.set(p.x, p.y, p.z).applyMatrix4(this.world.player.matrixWorld);
    return true;
  }

  private hitsControl(): boolean {
    this.hit = false;
    for (const entity of this.queries.controls.entities) {
      entity.object3D?.traverse(this.testMesh);
      if (this.hit) return true;
    }
    return false;
  }

  private readonly testMesh = (object: Object3D): void => {
    if (this.hit || !(object instanceof Mesh)) return;
    for (let node: Object3D | null = object; node != null; node = node.parent) {
      if (!node.visible) return;
    }
    object.updateWorldMatrix(true, false);
    if (object.geometry.boundingBox == null) object.geometry.computeBoundingBox();
    this.inverse.copy(object.matrixWorld).invert();
    this.localPosition.copy(this.gripPosition).applyMatrix4(this.inverse);
    object.geometry.boundingBox!.clampPoint(this.localPosition, this.nearestPosition);
    this.nearestPosition.applyMatrix4(object.matrixWorld);
    this.hit = this.gripPosition.distanceToSquared(this.nearestPosition) <= GRAB_RADIUS_SQ;
  };
}
