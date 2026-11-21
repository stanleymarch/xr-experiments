/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, VisibilityState } from '@iwsdk/core';

const RADIANS_PER_PIXEL = 0.0025;
const PITCH_LIMIT = Math.PI / 2 - 0.01;
const RIGHT_BUTTON = 2;

/**
 * App-owned mouse look for the browser (non-immersive) side of the
 * dual-runtime app, following the official IWSDK pattern: the locomotion
 * feature's `browserControls` own WASD/arrows/gamepad movement, while camera
 * look is app-owned.
 *
 * Hold the right mouse button to pointer-lock and look around; yaw rotates
 * the player rig (`this.player`, the XR origin) and pitch tilts the camera,
 * so the exact same rig drives the headset in immersive mode. Active only
 * while the world is non-immersive; entering XR releases the lock and the
 * tracked head pose takes over.
 */
export class BrowserMouseLookSystem extends createSystem({}) {
  private locked = false;
  private pitch = 0;

  init(): void {
    this.camera.rotation.reorder('YXZ');
    this.pitch = this.camera.rotation.x;

    const canvas = this.renderer.domElement as HTMLCanvasElement;

    const isBrowserMode = (): boolean =>
      this.world.visibilityState.value === VisibilityState.NonImmersive;

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== RIGHT_BUTTON || !isBrowserMode()) {
        return;
      }
      event.preventDefault();
      void canvas.requestPointerLock();
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (event.button !== RIGHT_BUTTON || !this.locked) {
        return;
      }
      document.exitPointerLock();
    };

    const onContextMenu = (event: MouseEvent): void => {
      if (this.locked) {
        event.preventDefault();
      }
    };

    const onPointerLockChange = (): void => {
      this.locked = document.pointerLockElement === canvas;
    };

    const onMouseMove = (event: MouseEvent): void => {
      if (!this.locked || !isBrowserMode()) {
        return;
      }
      this.player.rotateY(-event.movementX * RADIANS_PER_PIXEL);
      const nextPitch = this.pitch - event.movementY * RADIANS_PER_PIXEL;
      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, nextPitch));
      this.camera.rotation.x = this.pitch;
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    document.addEventListener('mousemove', onMouseMove);

    this.cleanupFuncs.push(
      () => canvas.removeEventListener('pointerdown', onPointerDown),
      () => canvas.removeEventListener('pointerup', onPointerUp),
      () => canvas.removeEventListener('contextmenu', onContextMenu),
      () =>
        document.removeEventListener('pointerlockchange', onPointerLockChange),
      () => document.removeEventListener('mousemove', onMouseMove),
      () => {
        if (document.pointerLockElement === canvas) {
          document.exitPointerLock();
        }
      },
      // An immersive session owns the camera; never keep the browser lock.
      this.world.visibilityState.subscribe((visibilityState) => {
        if (
          visibilityState !== VisibilityState.NonImmersive &&
          document.pointerLockElement === canvas
        ) {
          document.exitPointerLock();
        }
      }),
    );
  }

}
