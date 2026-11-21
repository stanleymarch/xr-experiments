/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { World } from '@iwsdk/core';
import { ACESFilmicToneMapping, WebGLRenderTarget } from 'three';
import projectOptions from 'virtual:iwsdk-project';
// Must be imported before the UIKitML panel asset is loaded: it widens the
// MSDF atlas charset so Cyrillic and underscores render instead of boxes.
import './fonts.js';
import { reportBootIssue } from './boot-diagnostics.js';
import { BrowserMouseLookSystem } from './mouselook.js';
import { AvatarSystem } from './avatar.js';
import { AmbientSystem } from './ambient.js';
import { GrabPhysicsGuardSystem } from './grab-physics.js';
import { PanelGrabSystem } from './panel-grab.js';
import { GripGrabSystem } from './grip-grab.js';
import { consumePairingUrl, createPairingOffer } from './pairing.js';
import { agentState } from './agent/state.js';
import { agentBrain } from './agent/brain.js';
import { avatarBody } from './avatar-body.js';
import { WorkspaceSystem } from './workspace.js';
import { bindPerception } from './agent/perception.js';
import { describeLocalModel, resolveLocalModel, setLocalImmersiveSession } from './agent/local-model.js';
import { installDevHarness, warmOmniIfSelected } from './agent/omni/omni-client.js';

// The workspace palette is light and the custom text colors assume a light
// surface. The color scheme is pinned in iwsdk.config.json
// (world.features.spatialUI.preferredColorScheme) so a dark OS/browser scheme
// cannot paint dark text on a dark panel.

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  // IWSDK renders with NoToneMapping, so every value above 1.0 clips hard to
  // white - the pale VRM and the bright room ended up flat. ACES rolls the
  // highlights off instead of cutting them.
  world.renderer.toneMapping = ACESFilmicToneMapping;
  world.renderer.toneMappingExposure = 1.0;

  // One failing system must not take the whole interface down with it. Each
  // step is isolated and reported, because a throw here used to leave the room
  // and the avatar on screen with no panel, no keyboard bridge and no visible
  // reason for it.
  const boot = (label: string, run: () => void): void => {
    try {
      run();
    } catch (error) {
      reportBootIssue(`Boot step failed: ${label}`, error);
    }
  };

  boot('mouse look', () => world.registerSystem(BrowserMouseLookSystem));
  boot('avatar', () => world.registerSystem(AvatarSystem));
  boot('ambient idle', () => world.registerSystem(AmbientSystem));
  // Registered after the physics system so grabbed bodies can be re-pinned
  // with a zeroed velocity before the next simulation step.
  boot('grab guard', () => world.registerSystem(GrabPhysicsGuardSystem));
  // The panel is moved by its grab bar (grip button) and the props can be
  // taken with the grip as well.
  boot('panel grab bar', () => world.registerSystem(PanelGrabSystem));
  boot('grip grab', () => world.registerSystem(GripGrabSystem));
  boot('perception', () => world.addCleanup(bindPerception(world)));
  boot('workspace panel', () => world.registerSystem(WorkspaceSystem));
  // The omni graphs download after the panel is visible; the status line
  // carries the progress. A no-op outside the resolved omni pipeline.
  boot('omni warm', () => warmOmniIfSelected());
  boot('omni dev harness', () => installDevHarness());

  // Kept in production as well: the panel is a 3D surface, so without a handle
  // on the world a broken deploy can only be guessed at from the canvas.
  (window as unknown as Record<string, unknown>).__agentBody = {
    world,
    agentState,
    agentBrain,
    avatarBody,
    localModel: { resolveLocalModel, describeLocalModel, setLocalImmersiveSession },
    pairing: { createPairingOffer, consumePairingUrl },
    three: { WebGLRenderTarget },
  };
}).catch((error: unknown) => {
  // World bootstrap includes the blocking asset preload, so a single missing
  // file (a 404 on ui/agent.uikitml, a site served from the wrong base path)
  // rejects here and leaves an empty canvas. Say so instead.
  reportBootIssue('World failed to start', error);
});
