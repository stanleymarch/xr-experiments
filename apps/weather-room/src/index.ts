/**
 * WEATHER//ROOM entry: creates the IWSDK world from the project manifest and
 * registers the weather systems in dependency order (loader -> sensing ->
 * visuals -> timeline -> panel).
 */

import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { AtmosphereSystem } from './weather/systems/atmosphere.js';
import { WeatherAudioSystem } from './weather/systems/audio.js';
import { BrowserPanelSystem } from './weather/systems/browser-panel.js';
import { ScreenInputSystem } from './weather/systems/screen-input.js';
import { PanelSystem } from './weather/systems/panel.js';
import { PuddlesSystem } from './weather/systems/puddles.js';
import { SnowSystem } from './weather/systems/snow.js';
import { RainSystem } from './weather/systems/rain.js';
import { RoomSensingSystem } from './weather/systems/room-sensing.js';
import { TemperatureSystem } from './weather/systems/temperature.js';
import { TimelineSystem } from './weather/systems/timeline.js';
import { WeatherLoaderSystem } from './weather/systems/weather-loader.js';
import { WindSystem } from './weather/systems/wind.js';

const boot = (world: World): void => {
  world.registerSystem(ScreenInputSystem, { priority: -3.9 });
  world.registerSystem(WeatherLoaderSystem, { priority: 1 });
  world.registerSystem(RoomSensingSystem, { priority: 2 });
  world.registerSystem(RainSystem, { priority: 30 });
  world.registerSystem(PuddlesSystem, { priority: 31 });
  world.registerSystem(SnowSystem, { priority: 32 });
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
