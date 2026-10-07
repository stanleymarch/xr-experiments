/**
 * Snow: soft instanced flakes with slow fall and wind-driven sway. Density and
 * fall speed follow Open-Meteo snowfall; flakes recycle at sensed surfaces.
 */

import {
  AdditiveBlending,
  createSystem,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Object3D,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from '@iwsdk/core';
import type { Entity, ReadonlySignal } from '@iwsdk/core';
import { capabilityProfile } from '../capabilities.js';
import type { CapabilityProfile } from '../capabilities.js';
import { roomModel } from '../room.js';
import { weatherStore } from '../weather-state.js';
import { windVectorFromFrame } from '../wind-shared.js';

const MAX_FLAKES = 900;
const REDUCED_FLAKES = 400;
const VERTEX = /* glsl */ `
attribute float aAlpha;
varying float vAlpha;
varying vec2 vUv;
void main() {
  vAlpha = aAlpha;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;
const FRAGMENT = /* glsl */ `
varying float vAlpha;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);
  float a = atan(p.y, p.x);
  float arms = abs(cos(a * 3.0));
  float star = 0.26 + 0.24 * arms;
  float body = 1.0 - smoothstep(star - 0.04, star + 0.08, r);
  float core = 1.0 - smoothstep(0.04, 0.22, r);
  float alpha = max(body * 0.65, core) * vAlpha;
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(0.78, 0.9, 1.0, alpha * 0.85);
}
`;

export class SnowSystem extends createSystem({}) {
  private entity!: Entity;
  private flakes!: InstancedMesh;
  private profile!: ReadonlySignal<CapabilityProfile>;
  private readonly positions = new Float32Array(MAX_FLAKES * 3);
  private readonly speeds = new Float32Array(MAX_FLAKES);
  private readonly sizes = new Float32Array(MAX_FLAKES);
  private readonly alphas = new Float32Array(MAX_FLAKES);
  private readonly seeds = new Float32Array(MAX_FLAKES);
  private readonly dummy = new Object3D();
  private readonly wind = new Vector3();
  private readonly cameraPos = new Vector3();
  private cursor = 0;

  init(): void {
    this.profile = capabilityProfile(this.world);
    const geo = new PlaneGeometry(1, 1);
    const alpha = new InstancedBufferAttribute(this.alphas, 1);
    alpha.setUsage(DynamicDrawUsage);
    geo.setAttribute('aAlpha', alpha);
    this.flakes = new InstancedMesh(
      geo,
      new ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        blending: AdditiveBlending,
      }),
      MAX_FLAKES,
    );
    this.flakes.frustumCulled = false;
    this.flakes.instanceMatrix.setUsage(DynamicDrawUsage);
    this.dummy.position.set(0, -10, 0);
    this.dummy.scale.setScalar(0.001);
    this.dummy.updateMatrix();
    for (let i = 0; i < MAX_FLAKES; i += 1) this.flakes.setMatrixAt(i, this.dummy.matrix);
    this.flakes.instanceMatrix.needsUpdate = true;
    this.flakes.count = 0;
    this.entity = this.world.createTransformEntity(this.flakes);
    this.cleanupFuncs.push(() => this.entity.dispose());
  }

  update(delta: number): void {
    const current = weatherStore.current();
    const snow = current?.drivers.snow ?? 0;
    const budget = this.profile.peek().particleBudget === 'full' ? MAX_FLAKES : REDUCED_FLAKES;
    const live = Math.floor(snow * budget);
    this.flakes.count = live;
    if (current == null || live === 0) return;

    const dt = Math.min(delta, 0.05);
    const { min, max } = roomModel;
    const spanX = Math.max(0.5, max.x - min.x);
    const spanZ = Math.max(0.5, max.z - min.z);
    const height = Math.max(0.5, max.y - min.y);
    windVectorFromFrame(current.frame, 0.12, this.wind);
    const time = performance.now() / 1000;
    this.world.camera.getWorldPosition(this.cameraPos);
    const yaw = Math.atan2(this.cameraPos.x - (min.x + max.x) * 0.5, this.cameraPos.z - (min.z + max.z) * 0.5);

    for (let i = 0; i < live; i += 1) {
      const ix = i * 3;
      if (this.alphas[i] <= 0) this.seed(i, min.x, min.y, min.z, spanX, spanZ, height, snow);
      const seed = this.seeds[i];
      this.positions[ix] += (this.wind.x + Math.sin(time * 0.7 + seed * 6.28) * 0.08) * dt;
      this.positions[ix + 1] -= this.speeds[i] * dt;
      this.positions[ix + 2] += (this.wind.z + Math.cos(time * 0.6 + seed * 8.1) * 0.08) * dt;
      if (this.positions[ix] < min.x) this.positions[ix] += spanX;
      else if (this.positions[ix] > max.x) this.positions[ix] -= spanX;
      if (this.positions[ix + 2] < min.z) this.positions[ix + 2] += spanZ;
      else if (this.positions[ix + 2] > max.z) this.positions[ix + 2] -= spanZ;
      const surface = roomModel.surfaceHeightAt(this.positions[ix], this.positions[ix + 2], this.positions[ix + 1] + this.speeds[i] * dt);
      if (this.positions[ix + 1] <= min.y || (surface != null && this.positions[ix + 1] <= surface)) {
        this.seed(i, min.x, min.y, min.z, spanX, spanZ, height, snow);
      }
      this.dummy.position.set(this.positions[ix], this.positions[ix + 1], this.positions[ix + 2]);
      this.dummy.rotation.set(0, yaw, Math.sin(time + seed * 6.28) * 0.2);
      this.dummy.scale.setScalar(this.sizes[i]);
      this.dummy.updateMatrix();
      this.flakes.setMatrixAt(i, this.dummy.matrix);
    }
    this.flakes.instanceMatrix.needsUpdate = true;
    (this.flakes.geometry.getAttribute('aAlpha') as InstancedBufferAttribute).needsUpdate = true;
  }

  private seed(i: number, minX: number, minY: number, minZ: number, spanX: number, spanZ: number, height: number, intensity: number): void {
    this.cursor += 1;
    const seed = ((this.cursor * 2654435761) % 10000) / 10000;
    const ix = i * 3;
    this.seeds[i] = seed;
    this.positions[ix] = minX + ((seed * 7.13) % 1) * spanX;
    this.positions[ix + 1] = minY + height * (0.65 + 0.35 * ((seed * 17.3) % 1));
    this.positions[ix + 2] = minZ + ((seed * 31.7) % 1) * spanZ;
    this.speeds[i] = 0.25 + 0.55 * intensity + 0.25 * ((seed * 13.1) % 1);
    this.sizes[i] = 0.035 + 0.055 * ((seed * 19.9) % 1);
    this.alphas[i] = 0.35 + 0.55 * intensity;
  }

  override destroy(): void {
    super.destroy();
    this.positions.fill(0);
    this.speeds.fill(0);
    this.alphas.fill(0);
    this.cursor = 0;
  }
}
