/**
 * REALITY//ROOM — the material of the room.
 *
 * The skin is deliberately almost invisible at rest: a thin fresnel sheen
 * that says "this room has a surface now" without hiding the real room
 * behind a coloured shell. When a wave passes, the same skin lights up along
 * the wave front, so the wave is readable as light travelling across a real
 * wall rather than as a glowing blob.
 */

import { AdditiveBlending, Color, DoubleSide, ShaderMaterial } from '@iwsdk/core';
import { WAVE_GLSL } from './wave.js';
import type { WaveUniforms } from './wave.js';

const VERTEX_SHADER = /* glsl */ `
${WAVE_GLSL}
varying float vEnergy;
varying vec3 vNormalW;
varying vec3 vViewDirW;

void main() {
  float energy = 0.0;
  vec3 displaced = position + waveDisplace(position, energy);
  vEnergy = energy;
  vec4 worldPos = modelMatrix * vec4(displaced, 1.0);
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vViewDirW = normalize(cameraPosition - worldPos.xyz);
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
varying float vEnergy;
varying vec3 vNormalW;
varying vec3 vViewDirW;
uniform vec3 uBaseColor;
uniform vec3 uHotColor;

void main() {
  float facing = abs(dot(normalize(vNormalW), normalize(vViewDirW)));
  float rim = pow(1.0 - facing, 2.5);
  float energy = clamp(vEnergy, 0.0, 2.0);
  vec3 color = mix(uBaseColor, uHotColor, clamp(energy * 1.7, 0.0, 1.0));
  // Additive blending: alpha scales how much light is added. The resting
  // skin is a faint sheen; the wave front is the light.
  float alpha = rim * 0.14 + clamp(energy * 3.4, 0.0, 1.0);
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
      uBaseColor: { value: new Color(0.32, 0.56, 0.95) },
      uHotColor: { value: new Color(0.86, 0.95, 1.0) },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
  });
}
