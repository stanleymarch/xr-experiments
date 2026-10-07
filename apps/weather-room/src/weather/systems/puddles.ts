/**
 * Rain-fed water patches anchored to mapped upward-facing floor cells.
 * They accumulate during rain, dry slowly, and use a soft-edge shader with
 * a restrained moving sky sheen instead of pretending to run rigid-body fluid.
 */

import {
  Color,
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

const SKY_DAY_CLEAR = new Color(0x86a2b8);
const SKY_OVERCAST = new Color(0x8e969e);

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
// MIT 2D simplex noise: https://github.com/stegu/webgl-noise.
// Copyright (C) 2011 Ashima Arts; 2011-2016 Stefan Gustavson.
// Full notice is shipped in public/licenses/webgl-noise.txt.
const FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uRain;
uniform vec3 uSky;
varying float vWetness;
varying vec2 vUv;
vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                      -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
void main() {
  vec2 p = vUv - vec2(0.5);
  float r = length(p) * 2.0;
  float ang = atan(p.y, p.x);
  // Organic boundary: radius wobbles around the rim and breathes slowly.
  vec2 rim = vec2(cos(ang), sin(ang));
  float wob = snoise(rim * 1.6 + uTime * 0.02) * 0.6 + snoise(rim * 3.3 - uTime * 0.015) * 0.4;
  float edge0 = 0.52 + wob * 0.3;
  float body = 1.0 - smoothstep(edge0 - 0.26, edge0, r);
  float inner = 1.0 - smoothstep(0.0, edge0, r);
  // Expanding rain rings, only while it is actually raining.
  float rings = 0.0;
  if (uRain > 0.01) {
    float ph = fract(r * 2.2 - uTime * (0.6 + uRain * 1.8) + wob * 0.35);
    rings = smoothstep(0.0, 0.1, ph) * (1.0 - smoothstep(0.1, 0.32, ph)) * uRain;
  }
  // Restrained moving sky sheen, brighter toward the middle.
  float sheen = pow(max(0.0, sin(vUv.x * 5.0 + vUv.y * 8.0 + uTime * 0.12)), 8.0) *
                (0.3 + 0.45 * inner);
  vec3 col = mix(uSky * 0.18, uSky * 0.95, clamp(sheen + rings * 0.8, 0.0, 1.0));
  float alpha = body * vWetness * min(0.55, 0.16 + sheen * 0.3 + rings * 0.4);
  if (alpha < 0.008) discard;
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class PuddlesSystem extends createSystem({}) {
  private entity!: Entity;
  private patches!: InstancedMesh;
  private readonly wetness = new Float32Array(PATCH_COUNT);
  private readonly xz = new Float32Array(PATCH_COUNT * 2);
  private readonly lastBounds = new Float32Array(6);
  private readonly dummy = new Object3D();
  private readonly skyColor = new Color();
  private daylightEase = 0.5;
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
      uniforms: { uTime: { value: 0 }, uRain: { value: 0 }, uSky: { value: new Color(0x5a6a78) } },
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
    // Wet sheen mirrors the actual sky: slate when overcast, warmer and
    // brighter when daylight escapes the cover, dim at night.
    const daylight = current?.drivers.daylight ?? 0.5;
    const cloud = current?.drivers.cloud ?? 0.3;
    this.daylightEase += (daylight - this.daylightEase) * Math.min(1, dt * 2);
    this.skyColor
      .copy(SKY_DAY_CLEAR)
      .lerp(SKY_OVERCAST, cloud)
      .multiplyScalar(0.2 + 0.8 * this.daylightEase);
    (this.material.uniforms.uSky.value as Color).copy(this.skyColor);
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
