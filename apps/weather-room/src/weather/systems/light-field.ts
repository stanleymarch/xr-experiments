/**
 * Light field: the single additive light shaft (god-ray cone) the whole room
 * is lit by. It owns the visible carrier of `lightSharedUniforms` — one open
 * cone from the modelled sun toward the room, depth-occluded by the real room
 * through the same injection the weather layers use — and it is the only place
 * the beam values are written, once per frame, before the layers render
 * (registered at priority 30.5, ahead of puddles/rain/wind).
 *
 * Cost: one draw call, 64 triangles, no per-frame allocations.
 */

import {
  AdditiveBlending,
  Color,
  ConeGeometry,
  createSystem,
  DoubleSide,
  Mesh,
  ShaderMaterial,
  Vector3,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import { enableDepthOcclusion } from '../depth-occlusion.js';
import {
  BEAM_HALF_ANGLE_RAD,
  BEAM_COS,
  lightSharedUniforms,
  SUN_DAY_COLOR,
  SUN_NIGHT_COLOR,
  SUN_WORLD_POSITION,
} from '../light-shared.js';
import { roomModel } from '../room.js';
import { weatherStore } from '../weather-state.js';

const UP = new Vector3(0, 1, 0);

const CONE_VERTEX = /* glsl */ `
varying vec2 vUv;
varying vec3 vConeWorld;
varying vec3 vConeNormal;
void main() {
  vUv = uv;
  vConeWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  vConeNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const CONE_FRAGMENT = /* glsl */ `
uniform vec3 uBeamColor;
uniform float uBeamIntensity;
uniform float uTime;
varying vec2 vUv;
varying vec3 vConeWorld;
varying vec3 vConeNormal;
void main() {
  // Rim-weighted so the shaft reads as a cone of air: bright along its
  // silhouette and where the viewer looks across it, faint straight through.
  vec3 viewDir = normalize(cameraPosition - vConeWorld);
  float rim = 1.0 - abs(dot(normalize(vConeNormal), viewDir));
  // Soft at the apex (v = 1) and dissolved before the far base (v = 0).
  float axial = smoothstep(0.0, 0.20, vUv.y) * (1.0 - smoothstep(0.60, 1.0, vUv.y));
  float grain = 0.82 + 0.18 *
    sin(vConeWorld.x * 6.3 + vConeWorld.y * 3.7 + uTime * 0.5) *
    sin(vConeWorld.z * 5.1 - uTime * 0.35);
  float alpha = axial * (0.18 + 0.82 * rim) * grain * uBeamIntensity * 0.55;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(uBeamColor, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class LightFieldSystem extends createSystem({}) {
  private entity!: Entity;
  private mesh!: Mesh;
  private material!: ShaderMaterial;
  private daylightEase = 0.5;

  init(): void {
    // One open cone: 32 radial segments the long way round, no base cap.
    const geometry = new ConeGeometry(1, 1, 32, 1, true);
    this.material = new ShaderMaterial({
      vertexShader: CONE_VERTEX,
      fragmentShader: CONE_FRAGMENT,
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
    });
    Object.assign(this.material.uniforms, lightSharedUniforms);
    // The shaft is cut by real furniture and walls exactly like the layers.
    enableDepthOcclusion(this.material);
    this.mesh = new Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.entity = this.world.createTransformEntity(this.mesh);
    this.cleanupFuncs.push(() => {
      this.entity.dispose();
      geometry.dispose();
      this.material.dispose();
    });
  }

  update(delta: number): void {
    const current = weatherStore.current();
    const cloud = current?.drivers.cloud ?? 0.3;
    const daylight = current?.drivers.daylight ?? 0.5;
    const ease = Math.min(1, Math.min(delta, 0.05) * 2);
    this.daylightEase += (daylight - this.daylightEase) * ease;

    // Through-breaks shaft strength: none at night, strongest with the sun
    // escaping a light cover. Same rule the cloud crowns brighten by.
    const intensity = (0.35 + 0.65 * this.daylightEase) * (1 - cloud * 0.45);
    lightSharedUniforms.uBeamIntensity.value = intensity;
    lightSharedUniforms.uBeamCos.value = BEAM_COS;
    (lightSharedUniforms.uBeamColor.value as Color)
      .copy(SUN_NIGHT_COLOR)
      .lerp(SUN_DAY_COLOR, this.daylightEase);

    const { min, max } = roomModel;
    const spanY = Math.max(0.5, max.y - min.y);
    const height = Math.max(4, spanY * 1.8);
    const radius = height * Math.tan(BEAM_HALF_ANGLE_RAD);
    this.mesh.scale.set(radius, height, radius);
    // Apex pinned to the sun, axis along the light's travel toward the room.
    const dir = lightSharedUniforms.uBeamDir.value;
    this.mesh.quaternion.setFromUnitVectors(UP, dir);
    this.mesh.position.copy(SUN_WORLD_POSITION).addScaledVector(dir, -height * 0.5);
    this.material.uniforms.uTime.value = performance.now() / 1000;
  }
}
