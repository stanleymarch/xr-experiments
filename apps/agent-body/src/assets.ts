/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { AssetType, defineAssets } from '@iwsdk/core';
import { createLocomotionFloor } from './scene-assets/locomotion-floor.scene-asset.js';
import { createReadingRoom } from './scene-assets/reading-room.scene-asset.js';
import {
  createBook,
  createBrassSphere,
  createCushion,
  createKeepsakeBox,
  createMug,
  createRoomFloorCollider,
  createSideboardCollider,
  createSofaCollider,
  createTableCollider,
  createVase,
} from './scene-assets/props.scene-asset.js';

const publicAssetUrl = (filePath: string): string =>
  `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;

/**
 * The panel document is edited together with the code: new element ids, new
 * classes. GitHub Pages caches `public/` for ten minutes, so a browser that
 * loaded the previous deploy can pair an old agent.uikitml with a new bundle.
 * The build stamp makes that impossible.
 */
const versionedAssetUrl = (filePath: string): string =>
  `${publicAssetUrl(filePath)}?v=${typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'}`;

export default defineAssets({
  'plant-sansevieria': {
    // Bundled: a failed third-party CDN fetch aborts the whole level in IWSDK
    // and leaves a blank page. MIT, see public/assets/plant-sansevieria/.
    url: publicAssetUrl('assets/plant-sansevieria/plantSansevieria.gltf'),
    type: AssetType.GLTF,
    name: 'Plant Sansevieria',
    priority: 'lazy',
  },
  'agent-panel': {
    url: versionedAssetUrl('ui/agent.uikitml'),
    type: AssetType.UIKitML,
    name: 'Agent Panel',
  },
  'locomotion-floor': createLocomotionFloor(),
  'vr-space': createReadingRoom(),

  // Static surfaces the grabbable props rest on. Invisible, physics only.
  'collider-room-floor': createRoomFloorCollider(),
  'collider-table': createTableCollider(),
  'collider-sideboard': createSideboardCollider(),
  'collider-sofa': createSofaCollider(),

  // Grabbable props. Every one of them is a rigid body, so it can be picked
  // up, thrown and knocked onto the floor.
  'prop-book-rust': createBook(0xb44a3a, 0.24, 0.036, 0.17),
  'prop-book-mustard': createBook(0xd08b3c, 0.22, 0.032, 0.16),
  'prop-book-teal': createBook(0x3f6b64, 0.26, 0.042, 0.18),
  'prop-book-navy': createBook(0x2f3e5c, 0.21, 0.03, 0.15),
  'prop-cushion-cream': createCushion(0xd9cdb8),
  'prop-cushion-sage': createCushion(0x8a9a7b),
  'prop-mug': createMug(),
  'prop-vase': createVase(),
  'prop-brass-sphere': createBrassSphere(),
  'prop-keepsake-box': createKeepsakeBox(),
});
