/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PlaneGeometry,
} from '@iwsdk/core';

const FLOOR_SIZE_M = 12;

/**
 * Invisible floor collider used as a `LocomotionEnvironment` surface.
 *
 * Dual-runtime requirement: browser locomotion (WASD) and XR slide/teleport
 * need a walkable surface or the player falls through the world. In
 * immersive-ar the local-floor reference space already puts y=0 at the real
 * floor, so a collider there matches both runtimes.
 *
 * `material.visible = false` skips the draw call while `mesh.visible` stays
 * true so raycasts (ground detection, pointer picking) still hit the surface.
 */
export function createLocomotionFloor(): Object3D {
  const geometry = new PlaneGeometry(FLOOR_SIZE_M, FLOOR_SIZE_M);
  geometry.rotateX(-Math.PI / 2);
  const material = new MeshBasicMaterial({
    color: 0xffffff,
    side: DoubleSide,
  });
  material.visible = false;
  const mesh = new Mesh(geometry, material);
  mesh.name = 'locomotion-floor';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}
