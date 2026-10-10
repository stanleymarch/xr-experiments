/**
 * WEATHER//ROOM entry: creates the IWSDK world from the project manifest and
 * registers the weather systems in dependency order (loader -> sensing ->
 * visuals -> timeline -> panel).
 */

import { DepthSensingSystem, World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { BrowserPanelSystem } from './weather/systems/browser-panel.js';
import { DepthOcclusionSystem } from './weather/systems/depth-occlusion.js';
import { HandOccluderSystem } from './weather/systems/hand-occluder.js';
import { HandFieldSystem } from './weather/systems/hand-field-system.js';
import { GestureSandboxSystem } from './weather/systems/gesture-sandbox.js';
import { LightFieldSystem } from './weather/systems/light-field.js';
import { DepthSamplingSystem } from './weather/systems/depth-sampling.js';
import { AtmosphereSystem } from './weather/systems/atmosphere.js';
import { WeatherAudioSystem } from './weather/systems/audio.js';
import { PanelSystem } from './weather/systems/panel.js';
import { RoomSensingSystem } from './weather/systems/room-sensing.js';
import { ControlGrabIntentSystem } from './weather/systems/control-grab-intent.js';
import { PuddlesSystem } from './weather/systems/puddles.js';
import { SnowSystem } from './weather/systems/snow.js';
import { RainSystem } from './weather/systems/rain.js';
import { TemperatureSystem } from './weather/systems/temperature.js';
import { TimelineSystem } from './weather/systems/timeline.js';
import { WeatherLoaderSystem } from './weather/systems/weather-loader.js';
import { WindSystem } from './weather/systems/wind.js';

const boot = (world: World): void => {
  world.registerSystem(ControlGrabIntentSystem, { priority: -3.9 });
  // Real-world depth image -> occlusion. The framework system stays registered
  // for the depth feature diagnostics only (its texture work is off: nothing
  // samples it), while DepthOcclusionSystem drives the app's own copy of the
  // depth texture for the custom weather shaders. No entity carries
  // `DepthOccludable`: the weather layers are occluded by the app's shader
  // injection, and the UI (panel, timeline rail) follows the Horizon OS rule of
  // never being hidden by real geometry. Both are no-ops without a depth grant.
  // Tracked hands are not in that depth image either, so HandOccluderSystem
  // adds invisible depth-only proxy spheres bound to the hand/controller
  // joints: they are virtual geometry, so they do cut the UI when a hand is in
  // front of it (which is the physically correct reading in passthrough).
  world.registerSystem(DepthSensingSystem, {
    configData: {
      enableOcclusion: false,
      enableDepthTexture: false,
      blurRadius: 20,
    },
  });
  world.registerSystem(DepthOcclusionSystem, { priority: 2.6 });
  // Depth-only hand/controller proxies: what the transparent weather layers can
  // fail their depth test against, since the room depth image never contains a
  // tracked hand. Runs after the input layer wrote this frame's joint
  // transforms and long before the weather visuals (31-36.5) draw.
  world.registerSystem(HandOccluderSystem, { priority: 2.7 });
  // Hand push field: feeds the shared capsule uniforms from the same hand-rig
  // joints the occluder reads, so both hand systems consume one input-layer
  // pass. The weather visuals read the uniforms at draw time, so any priority
  // between the occluder and the light shaft behaves identically.
  world.registerSystem(HandFieldSystem, { priority: 2.8 });
  // Clap detection: reads the same hand-model joints, so it sits next to the
  // two systems that refresh them. Thunder listeners fire synchronously on the
  // bus, so nothing depends on this exact number.
  world.registerSystem(GestureSandboxSystem, { priority: 2.9 });
  world.registerSystem(WeatherLoaderSystem, { priority: 1 });
  world.registerSystem(RoomSensingSystem, { priority: 2 });
  world.registerSystem(DepthSamplingSystem, { priority: 2.5 });
  // Light first: the shared shaft writes the beam uniforms every frame before
  // any layer that reads them (puddles, rain, wind, snow, dust).
  world.registerSystem(LightFieldSystem, { priority: 30.5 });
  world.registerSystem(PuddlesSystem, { priority: 31 });
  world.registerSystem(RainSystem, { priority: 32.5 });
  world.registerSystem(WindSystem, { priority: 33 });
  world.registerSystem(AtmosphereSystem, { priority: 34 });
  world.registerSystem(TemperatureSystem, { priority: 35 });
  world.registerSystem(TimelineSystem, { priority: 36 });
  world.registerSystem(WeatherAudioSystem, { priority: 36.5 });
  world.registerSystem(PanelSystem, { priority: 37 });
  world.registerSystem(BrowserPanelSystem, { priority: 38 });
};

const onBootError = (reason: unknown): void => {
  const err = reason instanceof Error ? (reason.stack ?? reason.message) : reason;
  window.__showBootError?.(err);
  console.error('[weather-room] boot failed', reason);
};

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  try {
    boot(world);
  } catch (error) {
    onBootError(error);
  }
}, onBootError);
