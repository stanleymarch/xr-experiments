/**
 * REALITY//FIELD — the elastic field.
 *
 * A single bounded ring of impulses drives every surface in the room. Each
 * impulse is a point in space, a direction, an amplitude and a birth time;
 * the shaders turn that into a travelling wave front:
 *
 *   displacement(p) = sum_i dir_i * amp_i * ring(dist(p, origin_i) - front_i)
 *
 * The ring is a Gaussian around the travelling front, attenuated by distance
 * and by age. The result is a dent that spreads outward from the contact
 * point at a readable speed and fades out — the room answers a touch.
 *
 * The buffer is deliberately small (8 slots). A room can be struck many
 * times per minute, and eight simultaneous wave fronts already fill the
 * frame; older slots are recycled instead of growing.
 */

import { Vector3 } from '@iwsdk/core';

/** Simultaneous wave fronts kept alive. */
export const MAX_IMPULSES = 8;

/** One wave front. */
export interface WaveImpulse {
  readonly origin: Vector3;
  readonly direction: Vector3;
  startTime: number;
  amplitude: number;
  speed: number;
}

/**
 * GLSL shared by the membrane and the debug skin. `waveDisplace` returns the
 * world-space displacement of a surface point and reports the local energy
 * (used for the glow and for the debug readout).
 */
export const WAVE_GLSL = /* glsl */ `
#define WAVE_MAX_IMPULSES ${MAX_IMPULSES}
uniform vec3 uImpulseOrigin[WAVE_MAX_IMPULSES];
uniform vec3 uImpulseDir[WAVE_MAX_IMPULSES];
uniform float uImpulseAmp[WAVE_MAX_IMPULSES];
uniform float uImpulseStart[WAVE_MAX_IMPULSES];
uniform float uImpulseSpeed[WAVE_MAX_IMPULSES];
uniform float uWaveTime;
uniform float uWaveWidth;

vec3 waveDisplace(vec3 worldPos, out float energy) {
  vec3 disp = vec3(0.0);
  energy = 0.0;
  for (int i = 0; i < WAVE_MAX_IMPULSES; i++) {
    float amp = uImpulseAmp[i];
    if (amp <= 0.0001) continue;
    float age = uWaveTime - uImpulseStart[i];
    if (age < 0.0 || age > 6.0) continue;
    vec3 delta = worldPos - uImpulseOrigin[i];
    float dist = length(delta);
    float front = age * uImpulseSpeed[i];
    float x = (dist - front) / max(uWaveWidth, 0.05);
    float ring = exp(-x * x);
    float falloff = 1.0 / (1.0 + 0.35 * dist * dist);
    float decay = exp(-age * 0.45);
    float a = amp * ring * falloff * decay;
    disp += uImpulseDir[i] * a;
    energy += abs(a);
  }
  return disp;
}
`;

/** Uniform payload shared by every wave-aware material. */
export interface WaveUniforms {
  uImpulseOrigin: { value: Vector3[] };
  uImpulseDir: { value: Vector3[] };
  uImpulseAmp: { value: number[] };
  uImpulseStart: { value: number[] };
  uImpulseSpeed: { value: number[] };
  uWaveTime: { value: number };
  uWaveWidth: { value: number };
}

/** Live wave field: the impulse ring plus the uniform payload it feeds. */
export class WaveField {
  readonly uniforms: WaveUniforms;
  private readonly impulses: WaveImpulse[] = [];
  private cursor = 0;

  constructor() {
    const origins: Vector3[] = [];
    const directions: Vector3[] = [];
    const amplitudes: number[] = [];
    const starts: number[] = [];
    const speeds: number[] = [];
    for (let i = 0; i < MAX_IMPULSES; i += 1) {
      origins.push(new Vector3());
      directions.push(new Vector3(0, 1, 0));
      amplitudes.push(0);
      starts.push(-1000);
      speeds.push(1);
      this.impulses.push({
        origin: new Vector3(),
        direction: new Vector3(0, 1, 0),
        startTime: -1000,
        amplitude: 0,
        speed: 1,
      });
    }
    this.uniforms = {
      uImpulseOrigin: { value: origins },
      uImpulseDir: { value: directions },
      uImpulseAmp: { value: amplitudes },
      uImpulseStart: { value: starts },
      uImpulseSpeed: { value: speeds },
      uWaveTime: { value: 0 },
      uWaveWidth: { value: 0.34 },
    };
  }

  /** Strike the field at a point, pushing along `direction`. */
  emit(
    origin: Vector3,
    direction: Vector3,
    amplitude: number,
    speed: number,
    time: number,
  ): void {
    const slot = this.impulses[this.cursor];
    this.cursor = (this.cursor + 1) % MAX_IMPULSES;
    slot.origin.copy(origin);
    slot.direction.copy(direction);
    if (slot.direction.lengthSq() < 1e-8) slot.direction.set(0, 1, 0);
    else slot.direction.normalize();
    slot.startTime = time;
    slot.amplitude = amplitude;
    slot.speed = speed;
  }

  /** Push the current state into the uniform payload. */
  update(time: number, width: number): void {
    this.uniforms.uWaveTime.value = time;
    this.uniforms.uWaveWidth.value = width;
    for (let i = 0; i < MAX_IMPULSES; i += 1) {
      const impulse = this.impulses[i];
      const origin = this.uniforms.uImpulseOrigin.value[i];
      const direction = this.uniforms.uImpulseDir.value[i];
      origin.copy(impulse.origin);
      direction.copy(impulse.direction);
      this.uniforms.uImpulseAmp.value[i] = impulse.amplitude;
      this.uniforms.uImpulseStart.value[i] = impulse.startTime;
      this.uniforms.uImpulseSpeed.value[i] = impulse.speed;
    }
  }

  /** Number of wave fronts that are still alive. */
  activeCount(time: number): number {
    let count = 0;
    for (const impulse of this.impulses) {
      const age = time - impulse.startTime;
      if (impulse.amplitude > 0.0001 && age >= 0 && age <= 6) count += 1;
    }
    return count;
  }

  /** Drop every wave front (used by the reset action). */
  clear(): void {
    for (let i = 0; i < MAX_IMPULSES; i += 1) {
      this.impulses[i].amplitude = 0;
      this.impulses[i].startTime = -1000;
      this.uniforms.uImpulseAmp.value[i] = 0;
      this.uniforms.uImpulseStart.value[i] = -1000;
    }
    this.cursor = 0;
  }
}
