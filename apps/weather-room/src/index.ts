/**
 * WEATHER//ROOM entry: creates the IWSDK world from the project manifest and
 * registers the weather systems in dependency order (loader -> sensing ->
 * visuals -> timeline -> panel).
 */

import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { AtmosphereSystem } from './weather/systems/atmosphere.js';
import { PanelSystem } from './weather/systems/panel.js';
import { RainSystem } from './weather/systems/rain.js';
import { RoomSensingSystem } from './weather/systems/room-sensing.js';
import { TemperatureSystem } from './weather/systems/temperature.js';
import { TimelineSystem } from './weather/systems/timeline.js';
import { WeatherLoaderSystem } from './weather/systems/weather-loader.js';
import { WindSystem } from './weather/systems/wind.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  world.registerSystem(WeatherLoaderSystem, { priority: 1 });
  world.registerSystem(RoomSensingSystem, { priority: 2 });
  world.registerSystem(RainSystem, { priority: 30 });
  world.registerSystem(WindSystem, { priority: 31 });
  world.registerSystem(AtmosphereSystem, { priority: 32 });
  world.registerSystem(TemperatureSystem, { priority: 33 });
  world.registerSystem(TimelineSystem, { priority: 34 });
  world.registerSystem(PanelSystem, { priority: 35 });
});
