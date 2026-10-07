/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { AssetType, defineAssets } from '@iwsdk/core';
import { timelineControl } from './scene-assets/timeline-control.scene-asset.js';

const publicAssetUrl = (filePath: string): string =>
  `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;

export default defineAssets({
  'timeline-control': timelineControl,
  'weather-panel': {
    url: publicAssetUrl('ui/weather.uikitml'),
    type: AssetType.UIKitML,
    name: 'Weather Panel',
  },
});
