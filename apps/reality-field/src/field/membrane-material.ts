/**
 * REALITY//FIELD — the material of the room.
 *
 * The skin is deliberately invisible at rest: the room is only lit by its own
 * wave. When a wave passes, the skin lights up along the front, so the wave is
 * readable as light travelling across a real wall rather than as a glowing
 * blob.
 *
 * Two different shaders do two different jobs:
 *
 * - the vertex shader *displaces* the surface, so the room physically dents as
 *   the front passes. The skin's vertices are ~0.2 m apart, which is fine for
 *   a slow, soft dent;
 * - the fragment shader *lights* the surface. Doing this per pixel rather than
 *   per vertex is what makes the front a crisp travelling contour instead of a
 *   blurred patch smeared across the mesh resolution.
 */

import { AdditiveBlending, Color, DoubleSide, ShaderMaterial } from '@iwsdk/core';
import { WAVE_GLSL } from './wave.js';
import type { WaveUniforms } from './wave.js';

const VERTEX_SHADER = /* glsl */ `
${WAVE_GLSL}
varying vec3 vWorldPos;

void main() {
  float energy = 0.0;
  vec3 displaced = position + waveDisplace(position, energy);
  vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
  vec4 worldPos = modelMatrix * vec4(displaced, 1.0);
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
${WAVE_GLSL}
varying vec3 vWorldPos;
uniform vec3 uBaseColor;
uniform vec3 uHotColor;

void main() {
  // Only the energy matters here; the displacement is the vertex shader's job.
  float energy = 0.0;
  waveDisplace(vWorldPos, energy);
  energy = clamp(energy, 0.0, 2.0);
  vec3 color = mix(uBaseColor, uHotColor, clamp(energy * 3.0, 0.0, 1.0));
  // Additive blending: alpha scales how much light is added. The skin is
  // layered (a plane and a mesh can cover the same pixel), so the resting
  // value must be exactly zero; only the crest adds light.
  float alpha = 1.0 - exp(-energy * 8.0);
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(color, alpha);
}
`;

/** Build the skin material, sharing the wave field's uniform objects. */
export function createSkinMaterial(waveUniforms: WaveUniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uImpulseOrigin: waveUniforms.uImpulseOrigin,
      uImpulseDir: waveUniforms.uImpulseDir,
      uImpulseAmp: waveUniforms.uImpulseAmp,
      uImpulseStart: waveUniforms.uImpulseStart,
      uImpulseSpeed: waveUniforms.uImpulseSpeed,
      uWaveTime: waveUniforms.uWaveTime,
      uWaveWidth: waveUniforms.uWaveWidth,
      uBaseColor: { value: new Color(0.26, 0.55, 1.0) },
      uHotColor: { value: new Color(0.94, 0.98, 1.0) },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
  });
}
