/**
 * WEATHER//ROOM shared wind vector: both WindSystem (ribbon advection) and
 * RainSystem (fall tilt) derive the same world-space flow from the frame.
 * Meteorological convention: `windDirectionDeg` is where wind comes FROM,
 * so flow points the opposite way. Base heading is fixed to world -Z (scene
 * forward); this is NOT true-north alignment — Quest MR has no compass.
 */

import type { WeatherFrame } from './weather-state.js';
import { Vector3 } from '@iwsdk/core';

const DEG_TO_RAD = Math.PI / 180;

/** Write the horizontal flow vector (m/s, scaled by `speedScale`) into `out`. */
export function windVectorFromFrame(frame: WeatherFrame, speedScale: number, out: Vector3): Vector3 {
  // FROM direction -> TO flow: add 180 deg. Heading measured from -Z.
  // Missing speed/direction must yield a zero vector: NaN would permanently
  // poison particle position buffers.
  if (!frame.available.windSpeedKmh || !frame.available.windDirectionDeg) {
    out.set(0, 0, 0);
    return out;
  }
  const headingRad = (frame.windDirectionDeg + 180) * DEG_TO_RAD;
  const speed = (frame.windSpeedKmh / 3.6) * speedScale;
  out.set(Math.sin(headingRad) * speed, 0, -Math.cos(headingRad) * speed);
  return out;
}
