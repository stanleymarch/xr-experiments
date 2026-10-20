/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { ImpulseSystem } from './systems/impulse.js';
import { MoteFieldSystem } from './systems/motes.js';
import { PanelSystem } from './systems/panel.js';
import { RoomFieldSystem } from './systems/room-field.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  world.registerSystem(RoomFieldSystem);
  world.registerSystem(ImpulseSystem);
  world.registerSystem(MoteFieldSystem);
  world.registerSystem(PanelSystem);
});
