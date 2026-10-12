/**
 * WEATHER//ROOM shared wind vector: WindSystem (ribbon advection), RainSystem
 * (fall tilt), SnowSystem (flake drift) and AtmosphereSystem (cloud/dust
 * drift) all derive the same world-space flow from the frame — plus the
 * sandbox gust, which folds in additively.
 *
 * Meteorological convention: `windDirectionDeg` is where wind comes FROM,
 * so flow points the opposite way. Base heading is fixed to world -Z (scene
 * forward); this is NOT true-north alignment — Quest MR has no compass.
 *
 * Sandbox gust folding: the gust is a genuine directional vector (stored
 * direction × factor × peak flow), added AFTER the per-layer speedScale, so
 * every layer bends toward the sweep even when the fetched dataset is calm
 * or missing wind. Outside the sandbox the factor is 0 and the result is
 * byte-identical to the old weather-only vector — weather-driven
 * direction/speed are untouched.
 */

import type { WeatherFrame } from './weather-state.js';
import {
  SANDBOX_GUST_PEAK_FLOW_M_S,
  sandboxGustDirX,
  sandboxGustDirZ,
  sandboxGustFactor,
} from './sandbox-gust.js';
import { Vector3 } from '@iwsdk/core';

const DEG_TO_RAD = Math.PI / 180;

/** Write the stored sandbox gust flow vector (m/s, unscaled) into `out`. */
export function sandboxGustVector(out: Vector3): Vector3 {
  const factor = sandboxGustFactor();
  if (!(factor > 0)) {
    out.set(0, 0, 0);
    return out;
  }
  const flow = factor * SANDBOX_GUST_PEAK_FLOW_M_S;
  out.set(sandboxGustDirX() * flow, 0, sandboxGustDirZ() * flow);
  return out;
}

/**
 * Write the horizontal flow vector (m/s, scaled by `speedScale`) into `out`:
 * forecast base plus the additive sandbox gust vector. Missing
 * speed/direction yields a zero base (NaN would permanently poison particle
 * position buffers) but the gust still applies on top.
 */
export function windVectorFromFrame(frame: WeatherFrame, speedScale: number, out: Vector3): Vector3 {
  if (!frame.available.windSpeedKmh || !frame.available.windDirectionDeg) {
    out.set(0, 0, 0);
  } else {
    // FROM direction -> TO flow: add 180 deg. Heading measured from -Z.
    const headingRad = (frame.windDirectionDeg + 180) * DEG_TO_RAD;
    const speed = (frame.windSpeedKmh / 3.6) * speedScale;
    out.set(Math.sin(headingRad) * speed, 0, -Math.cos(headingRad) * speed);
  }
  const gust = sandboxGustFactor();
  if (gust > 0) {
    const flow = gust * SANDBOX_GUST_PEAK_FLOW_M_S * speedScale;
    out.x += sandboxGustDirX() * flow;
    out.z += sandboxGustDirZ() * flow;
  }
  return out;
}
