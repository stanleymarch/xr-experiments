/**
 * Rain-fed water patches anchored to mapped upward-facing floor cells.
 * They accumulate during rain, dry slowly, and use a soft-edge shader with
 * a restrained moving sky sheen instead of pretending to run rigid-body fluid.
 */

import {
  createSystem,
  DynamicDrawUsage,
  CircleGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Object3D,
  ShaderMaterial,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import { roomModel } from '../room.js';
import { weatherStore } from '../weather-state.js';

const PATCH_COUNT = 14;
const VERTEX = /* glsl */ `
attribute float aWetness;
varying float vWetness;
varying vec2 vUv;
void main() {
  vWetness = aWetness;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;
const FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uRain;
varying float vWetness;
varying vec2 vUv;
void main() {
  vec2 p = vUv - vec2(0.5);
  float r = length(p);
  float edgeNoise = sin(vUv.x * 19.0 + sin(vUv.y * 13.0)) * cos(vUv.y * 17.0) * 0.025;
  float edge = 1.0 - smoothstep(0.43 + edgeNoise, 0.5 + edgeNoise, r);
  float ripple = 0.5 + 0.5 * sin(r * 74.0 - uTime * (1.0 + uRain * 2.0) + sin(vUv.x * 11.0) * 1.2);
  float sheen = pow(max(0.0, sin(vUv.x * 8.0 + vUv.y * 11.0 + uTime * 0.15)), 12.0);
  float alpha = edge * vWetness * (0.12 + 0.07 * ripple + 0.12 * sheen);
  if (alpha < 0.008) discard;
  vec3 water = mix(vec3(0.018, 0.055, 0.09), vec3(0.16, 0.43, 0.58), sheen * 0.7 + ripple * uRain * 0.12);
  gl_FragColor = vec4(water, alpha);
}
`;

export class PuddlesSystem extends createSystem({}) {
  private entity!: Entity;
  private patches!: InstancedMesh;
  private readonly wetness = new Float32Array(PATCH_COUNT);
  private readonly xz = new Float32Array(PATCH_COUNT * 2);
  private readonly lastBounds = new Float32Array(6);
  private readonly dummy = new Object3D();
  private material!: ShaderMaterial;
  private initialized = false;
  private lastHasSurfaces = false;
  init(): void {
    const geo = new CircleGeometry(1, 28);
    const wetnessAttr = new InstancedBufferAttribute(this.wetness, 1);
    wetnessAttr.setUsage(DynamicDrawUsage);
    geo.setAttribute('aWetness', wetnessAttr);
    this.material = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: { uTime: { value: 0 }, uRain: { value: 0 } },
      transparent: true,
      depthWrite: false,
    });
    this.patches = new InstancedMesh(geo, this.material, PATCH_COUNT);
    this.patches.frustumCulled = false;
    this.patches.instanceMatrix.setUsage(DynamicDrawUsage);
    this.patches.renderOrder = 3;
    this.dummy.position.set(0, -10, 0);
    this.dummy.rotation.x = -Math.PI / 2;
    this.dummy.scale.set(0.001, 0.001, 1);
    this.dummy.updateMatrix();
    for (let i = 0; i < PATCH_COUNT; i += 1) this.patches.setMatrixAt(i, this.dummy.matrix);
    this.patches.instanceMatrix.needsUpdate = true;
    this.entity = this.world.createTransformEntity(this.patches);
    this.cleanupFuncs.push(() => this.entity.dispose());
  }

  update(delta: number): void {
    const current = weatherStore.current();
    const rain = current?.drivers.rain ?? 0;
    const { min, max } = roomModel;
    const moved =
      !this.initialized ||
      roomModel.hasSurfaces !== this.lastHasSurfaces ||
      Math.abs(min.x - this.lastBounds[0]) > 0.25 ||
      Math.abs(min.y - this.lastBounds[1]) > 0.25 ||
      Math.abs(min.z - this.lastBounds[2]) > 0.25 ||
      Math.abs(max.x - this.lastBounds[3]) > 0.25 ||
      Math.abs(max.y - this.lastBounds[4]) > 0.25 ||
      Math.abs(max.z - this.lastBounds[5]) > 0.25;
    if (moved) {
      this.seedPatches(min.x, min.z, max.x - min.x, max.z - min.z);
      this.lastBounds[0] = min.x;
      this.lastBounds[1] = min.y;
      this.lastBounds[2] = min.z;
      this.lastBounds[3] = max.x;
      this.lastBounds[4] = max.y;
      this.lastBounds[5] = max.z;
      this.lastHasSurfaces = roomModel.hasSurfaces;
    }
    const dt = Math.min(delta, 0.05);
    const time = performance.now() / 1000;
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uRain.value = rain;
    for (let i = 0; i < PATCH_COUNT; i += 1) {
      this.wetness[i] = Math.max(0, Math.min(1, this.wetness[i] + rain * 0.08 * dt - (1 - rain) * 0.0025 * dt));
      const x = this.xz[i * 2];
      const z = this.xz[i * 2 + 1];
      const surfaceY = roomModel.hasSurfaces
        ? roomModel.surfaceHeightAt(x, z, min.y + 0.12)
        : min.y;
      if (surfaceY == null || this.wetness[i] < 0.015) {
        this.dummy.position.set(0, -10, 0);
        this.dummy.scale.set(0.001, 0.001, 1);
      } else {
        this.dummy.position.set(x, surfaceY + 0.012, z);
        this.dummy.rotation.set(-Math.PI / 2, 0, this.seedAngle(i));
        const radius = 0.11 + this.wetness[i] * 0.34;
        this.dummy.scale.set(radius * (0.8 + (i % 4) * 0.08), radius, 1);
      }
      this.dummy.updateMatrix();
      this.patches.setMatrixAt(i, this.dummy.matrix);
    }
    this.patches.instanceMatrix.needsUpdate = true;
    (this.patches.geometry.getAttribute('aWetness') as InstancedBufferAttribute).needsUpdate = true;
  }

  private seedPatches(minX: number, minZ: number, spanX: number, spanZ: number): void {
    this.initialized = true;
    for (let i = 0; i < PATCH_COUNT; i += 1) {
      const seed = ((i * 2654435761) % 1000) / 1000;
      this.xz[i * 2] = minX + (0.12 + ((seed * 7.13) % 0.76)) * Math.max(0.5, spanX);
      this.xz[i * 2 + 1] = minZ + (0.12 + ((seed * 17.7) % 0.76)) * Math.max(0.5, spanZ);
      this.wetness[i] = 0;
    }
  }

  private seedAngle(index: number): number {
    return ((index * 2654435761) % 6283) / 1000;
  }

  override destroy(): void {
    super.destroy();
    this.wetness.fill(0);
    this.xz.fill(0);
    this.initialized = false;
  }
}
