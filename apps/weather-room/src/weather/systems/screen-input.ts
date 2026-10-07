import { createSystem, Matrix4, RayPointer, XROrigin } from '@iwsdk/core';

/** IWSDK 1.0.1 routes left/right controllers, but not unhanded phone screen rays. */
export class ScreenInputSystem extends createSystem({}) {
  private readonly origin = new XROrigin();
  private readonly poseMatrix = new Matrix4();
  private ray!: RayPointer;
  private session: XRSession | null = null;
  private source: XRInputSource | null = null;
  private readonly pointerEvent = { timeStamp: 0, button: 0 };

  init(): void {
    this.ray = new RayPointer(this.world.camera, this.origin, 'right');
    this.ray.ray.visible = false;
    const attach = () => {
      this.detach();
      // Three emits sessionstart before IWSDK assigns world.xrSession.
      this.session = this.xrManager.getSession();
      this.session?.addEventListener('selectstart', this.onStart);
      this.session?.addEventListener('selectend', this.onEnd);
    };
    this.xrManager.addEventListener('sessionstart', attach);
    this.xrManager.addEventListener('sessionend', this.detach);
    this.cleanupFuncs.push(
      () => this.xrManager.removeEventListener('sessionstart', attach),
      () => this.xrManager.removeEventListener('sessionend', this.detach),
      this.detach,
      () => this.ray.dispose(),
    );
    if (this.xrManager.getSession() != null) attach();
  }

  private move(event: XRInputSourceEvent): boolean {
    const referenceSpace = this.xrManager.getReferenceSpace();
    if (referenceSpace == null) return false;
    const pose = event.frame.getPose(event.inputSource.targetRaySpace, referenceSpace);
    if (pose == null) return false;
    this.world.player.updateWorldMatrix(true, false);
    this.world.player.matrixWorld.decompose(this.origin.position, this.origin.quaternion, this.origin.scale);
    const raySpace = this.origin.raySpaces.right;
    this.poseMatrix.fromArray(pose.transform.matrix).decompose(raySpace.position, raySpace.quaternion, raySpace.scale);
    this.origin.updateMatrixWorld(true);
    this.pointerEvent.timeStamp = event.timeStamp;
    this.ray.pointer.setEnabled(true, this.pointerEvent);
    this.ray.pointer.move(this.world.scene, this.pointerEvent);
    return true;
  }

  private readonly onStart = (event: XRInputSourceEvent): void => {
    const mode = event.inputSource.targetRayMode;
    if ((mode !== 'screen' && mode !== 'transient-pointer') || this.source != null) return;
    if (!this.move(event)) return;
    this.source = event.inputSource;
    this.ray.pointer.down(this.pointerEvent);
  };

  private readonly onEnd = (event: XRInputSourceEvent): void => {
    if (event.inputSource !== this.source) return;
    // Some runtimes retire the transient pose before selectend; keep the last hit.
    this.move(event);
    this.pointerEvent.timeStamp = event.timeStamp;
    this.ray.pointer.up(this.pointerEvent);
    this.ray.pointer.exit(this.pointerEvent);
    this.source = null;
  };

  private readonly detach = (): void => {
    this.session?.removeEventListener('selectstart', this.onStart);
    this.session?.removeEventListener('selectend', this.onEnd);
    this.session = null;
    this.source = null;
    if (this.ray == null) return;
    this.pointerEvent.timeStamp = performance.now();
    this.ray.pointer.cancel(this.pointerEvent);
    this.ray.pointer.exit(this.pointerEvent);
    this.ray.pointer.setEnabled(false, this.pointerEvent);
  };
}
