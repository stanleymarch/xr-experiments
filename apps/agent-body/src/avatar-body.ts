/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { Object3D } from '@iwsdk/core';
import type { AvatarBody, AvatarCue, AvatarExpressionName } from './agent/contracts.js';

/**
 * Live driver bound by `AvatarSystem` before loading starts. The driver retains
 * attention/idle commands while a model loads; availability reflects the actual
 * loaded VRM, not just whether the facade has a driver.
 */
let impl: AvatarBody | null = null;

/**
 * Binds one system-owned driver. Teardown only unbinds that same driver, so an
 * obsolete system cannot disconnect a newer system during hot replacement.
 */
export function bindAvatarBody(body: AvatarBody): () => void {
  impl = body;
  return () => {
    if (impl === body) impl = null;
  };
}

/**
 * Singleton facade implementing {@link AvatarBody} from the agent contracts.
 * Every method is a no-op and `available === false` until the avatar system
 * binds a live impl via {@link bindAvatarBody}.
 */
export const avatarBody: AvatarBody = {
  get available(): boolean {
    return impl?.available ?? false;
  },
  setExpression(name: AvatarExpressionName, weight: number): void {
    impl?.setExpression(name, weight);
  },
  get performing(): boolean {
    return impl?.performing ?? false;
  },
  playCue(cue: AvatarCue | null): void {
    impl?.playCue(cue);
  },
  setTalking(active: boolean): void {
    impl?.setTalking(active);
  },
  speakChunk(text: string): void {
    impl?.speakChunk(text);
  },
  setAttentionTarget(target: Object3D | null): void {
    impl?.setAttentionTarget(target);
  },
  setIdleMotion(enabled: boolean): void {
    impl?.setIdleMotion(enabled);
  },
};
