/**
 * Atmosphere: cloud cover -> FogExp2 density + a seven-layer sculpted cloud
 * deck hugging the ceiling (fbm billows with organic elliptical footprints,
 * fake thickness shading, opacity capped so passthrough stays comfortable)
 * + directional light dimming with a day/night palette. The deck advects
 * with the shared wind vector so overcast wind hours read as moving sky.
 * Pressure -> 400-instance soft dust field (instanced round sprites, never
 * square points): high pressure sinks low and slow, low pressure expands
 * with a gentle upward swirl; dust also drifts with the wind. Thunderstorm
 * hours add safe short light pulses.
 */

import {
  AdditiveBlending,
  AmbientLightComponent,
  InstancedBufferAttribute,
  Color,
  createSystem,
  DirectionalLightComponent,
  DynamicDrawUsage,
  DomeGradient,
  FogExp2,
  InstancedMesh,
  Mesh,
  Object3D,
  PlaneGeometry,
  ShaderMaterial,
} from '@iwsdk/core';
import { Vector3 } from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import { roomModel } from '../room.js';
import { weatherEvents, weatherStore } from '../weather-state.js';
import { windVectorFromFrame } from '../wind-shared.js';
 
const FOG_CLEAR = 0.006;
const CLOUD_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
// MIT 2D simplex noise: https://github.com/stegu/webgl-noise.
// Copyright (C) 2011 Ashima Arts; 2011-2016 Stefan Gustavson.
// Full notice is shipped in public/licenses/webgl-noise.txt.
const CLOUD_FRAGMENT = /* glsl */ `
uniform float uCloud;
uniform float uTime;
uniform float uFlash;
uniform float uSeed;
uniform float uSun;
uniform vec3 uTint;
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
float fbm(vec2 p) {
  return snoise(p) * 0.5 + snoise(p * 2.13 + 11.3) * 0.27 +
         snoise(p * 4.41 + 27.1) * 0.15 + snoise(p * 8.7 + 43.7) * 0.08;
}
void main() {
  // Sculpted billows: drifting fbm domain, coverage threshold <- cloud cover.
  vec2 p = vUv * vec2(3.1, 2.4) + uSeed * 19.7 + vec2(uTime * 0.016, uTime * -0.005);
  float n = fbm(p) * 0.5 + 0.5;
  float cover = 0.66 - uCloud * 0.36;
  float density = smoothstep(cover, cover + 0.4, n);
  // Organic elliptical footprint perturbed by noise: never a rectangle.
  float rad = length((vUv - 0.5) * vec2(2.0, 2.35)) + snoise(vUv * 5.0 + uSeed * 31.0) * 0.2;
  float edge = 1.0 - smoothstep(0.5, 0.95, rad);
  float body = density * edge;
  // Fake thickness shading from a second offset sample: lit crowns, dark bases.
  float lit = fbm(p + vec2(0.24, 0.16)) * 0.5 + 0.5;
  float shade = clamp((n - lit) * 2.4 + 0.66, 0.34, 1.18);
  shade *= mix(0.72, 1.1, vUv.y);
  float alpha = body * min(0.5, 0.05 + uCloud * 0.42);
  if (alpha < 0.008) discard;
  // Slate storm gray; sun breakthrough warms the lit crowns only.
  vec3 slate = vec3(0.34, 0.38, 0.45) * shade;
  float rim = clamp(shade - 0.55, 0.0, 0.63) * 1.6;
  vec3 col = mix(slate, uTint * (0.65 + 0.55 * shade), clamp(uSun * rim, 0.0, 1.0));
  col = mix(col, vec3(0.9, 0.95, 1.0), uFlash * 0.85);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
const FOG_OVERCAST = 0.028;
const FOG_HUMID = 0.008;
const DUST_COUNT = 400;
const PLATE_COUNT = 7;
const SUN_BRIGHT = 1.0;
const SUN_DIM = 0.35;
const SUN_DAY_COLOR = new Color(0xffe8c4);
const SUN_NIGHT_COLOR = new Color(0x8fa8d8);
const SKY_CLEAR = new Color(0x27374a);
const SKY_CLOUDY = new Color(0x5c6672);
const HORIZON_CLEAR = new Color(0xa89a90);
const HORIZON_CLOUDY = new Color(0x8b939c);
const FLASH_MIN_INTERVAL_S = 4;
const FLASH_MAX_INTERVAL_S = 11;

const DUST_VERTEX = /* glsl */ `
attribute float aAlpha;
varying float vAlpha;
varying vec2 vUv;
void main() {
  vAlpha = aAlpha;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;
const DUST_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;
varying vec2 vUv;
void main() {
  float d = length(vUv - vec2(0.5, 0.5));
  float a = (1.0 - smoothstep(0.05, 0.5, d)) * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a * 0.55);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

interface DustParticle {
  seed: number;
  alpha: number;
  size: number;
  xSeed: number;
  ySeed: number;
  zSeed: number;
}

export class AtmosphereSystem extends createSystem({}) {
  private fog!: FogExp2;
  private plates: Mesh[] = [];
  private plateEntities: Entity[] = [];
  private plateMats: ShaderMaterial[] = [];
  private dust!: InstancedMesh;
  private dustEntity!: Entity;
  private dustParts: DustParticle[] = [];
  private readonly dustDummy = new Object3D();
  private readonly dustPos = new Float32Array(DUST_COUNT * 3);
  private sunEntity!: Entity;
  private fillEntity!: Entity;
  private readonly sunColor = SUN_DAY_COLOR.clone();
  private readonly cameraPosition = new Vector3();
  private readonly wind = new Vector3();
  private cloudDriftX = 0;
  private cloudDriftZ = 0;
  private dustPhaseX = 0;
  private dustPhaseZ = 0;
  private readonly skyColor = new Color();
  private readonly horizonColor = new Color();
  private lastSkyCloud = -1;
  private lastSkyDay = -1;
  private daylightEase = 0.5;
  private nextFlashAt = 0;
  private flashT = -1; // -1 = idle; otherwise seconds since flash start
  private flashPeak = 0;

  init(): void {
    this.fog = new FogExp2(0x9fb4cc, FOG_CLEAR);
    this.world.scene.fog = this.fog;

    const plateGeo = new PlaneGeometry(1, 1);
    for (let i = 0; i < PLATE_COUNT; i += 1) {
      const mat = new ShaderMaterial({
        vertexShader: CLOUD_VERTEX,
        fragmentShader: CLOUD_FRAGMENT,
        uniforms: {
          uCloud: { value: 0.3 },
          uTime: { value: 0 },
          uFlash: { value: 0 },
          uSeed: { value: i * 0.618033 },
          uSun: { value: 0 },
          uTint: { value: new Color(0xdfe8f2) },
        },
        transparent: true,
        depthWrite: false,
      });
      const plate = new Mesh(plateGeo, mat);
      plate.rotation.x = Math.PI / 2;
      plate.renderOrder = 5;
      this.plates.push(plate);
      this.plateMats.push(mat);
      this.plateEntities.push(this.world.createTransformEntity(plate));
    }

    // Dust: instanced soft round sprites (points render as squares on some GPUs).
    const dustGeo = new PlaneGeometry(1, 1);
    const dustAlphas = new Float32Array(DUST_COUNT);
    const seedAxis = (index: number, axis: number): number => {
      const value = Math.sin((index + 1) * (12.9898 + axis * 38.233)) * 43758.5453;
      return value - Math.floor(value);
    };
    for (let i = 0; i < DUST_COUNT; i += 1) {
      const seed = ((i * 2654435761) % 1000) / 1000;
      this.dustParts.push({
        seed, alpha: 0.25 + 0.5 * ((seed * 17) % 1), size: 0.01 + 0.018 * ((seed * 7) % 1),
        xSeed: seedAxis(i, 0), ySeed: seedAxis(i, 1), zSeed: seedAxis(i, 2),
      });
      dustAlphas[i] = this.dustParts[i].alpha;
    }
    const alphaAttr = new InstancedBufferAttribute(dustAlphas, 1);
    alphaAttr.setUsage(DynamicDrawUsage);
    this.dust = new InstancedMesh(
      dustGeo,
      new ShaderMaterial({
        vertexShader: DUST_VERTEX,
        fragmentShader: DUST_FRAGMENT,
        uniforms: { uColor: { value: new Color(0xcfd8e6) } },
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
      DUST_COUNT,
    );
    this.dust.frustumCulled = false;
    this.dust.instanceMatrix.setUsage(DynamicDrawUsage);
    dustGeo.setAttribute('aAlpha', alphaAttr);
    this.dustDummy.position.set(0, -10, 0);
    this.dustDummy.scale.setScalar(0.001);
    this.dustDummy.updateMatrix();
    for (let i = 0; i < DUST_COUNT; i += 1) this.dust.setMatrixAt(i, this.dustDummy.matrix);
    this.dust.instanceMatrix.needsUpdate = true;
    this.dustEntity = this.world.createTransformEntity(this.dust);

    // Procedural lights are tuned with the current cloud cover and daylight.
    this.sunEntity = this.world.createTransformEntity();
    this.sunEntity.addComponent(DirectionalLightComponent, { intensity: SUN_BRIGHT });
    this.sunEntity.object3D?.position.set(-4, 6, 2);
    this.sunEntity.object3D?.lookAt(0, 0, 0);
    this.fillEntity = this.world.createTransformEntity();
    this.fillEntity.addComponent(AmbientLightComponent, { intensity: 0.45 });

    this.cleanupFuncs.push(() => {
      for (const entity of this.plateEntities) entity.dispose();
      this.dustEntity.dispose();
      this.sunEntity.dispose();
      this.fillEntity.dispose();
      if (this.world.scene.fog === this.fog) this.world.scene.fog = null;
    });
  }

  update(delta: number): void {
    const current = weatherStore.current();
    const cloud = current?.drivers.cloud ?? 0.3;
    const pressure = current?.drivers.pressure ?? 0.5;
    const humidity = current?.drivers.humidity ?? 0.5;
    const fogCode = current?.drivers.fog === true;
    const thunder = current?.drivers.thunder === true;
    const daylight = current?.drivers.daylight ?? 0.5;
    const time = performance.now() / 1000;
    const dt = Math.min(delta, 0.05);
    const { min, max } = roomModel;
    // Shared horizontal flow drives the cloud deck and the dust drift; no
    // data means no invented wind.
    if (current != null) windVectorFromFrame(current.frame, 1, this.wind);
    else this.wind.set(0, 0, 0);

    // Day/night palette eases so timeline scrubbing never pops.
    const ease = Math.min(1, Math.min(delta, 0.05) * 2);
    this.daylightEase += (daylight - this.daylightEase) * ease;
    this.sunColor.copy(SUN_NIGHT_COLOR).lerp(SUN_DAY_COLOR, this.daylightEase);
    const level = this.world.activeLevel.value;
    if (level?.hasComponent(DomeGradient) &&
        (Math.abs(cloud - this.lastSkyCloud) > 0.04 || Math.abs(this.daylightEase - this.lastSkyDay) > 0.04)) {
      const brightness = 0.2 + this.daylightEase * 0.8;
      this.skyColor.copy(SKY_CLEAR).lerp(SKY_CLOUDY, cloud).multiplyScalar(brightness);
      this.horizonColor.copy(HORIZON_CLEAR).lerp(HORIZON_CLOUDY, cloud).multiplyScalar(brightness);
      level.setValue(DomeGradient, 'sky', this.skyColor);
      level.setValue(DomeGradient, 'equator', this.horizonColor);
      level.setValue(DomeGradient, '_needsUpdate', true);
      this.fog.color.copy(this.horizonColor);
      this.lastSkyCloud = cloud;
      this.lastSkyDay = this.daylightEase;
    }

    this.fog.density =
      FOG_CLEAR + (FOG_OVERCAST - FOG_CLEAR) * cloud + FOG_HUMID * humidity + (fogCode ? 0.025 : 0);
    const baseSun =
      (SUN_BRIGHT - (SUN_BRIGHT - SUN_DIM) * cloud) * (0.22 + 0.78 * this.daylightEase);
    const baseFill = 0.18 + 0.3 * this.daylightEase;

    // Thunder: occasional short safe light pulses instead of strobe.
    let sunIntensity = baseSun;
    let fillIntensity = baseFill;
    let plateFlash = 0;
    if (thunder) {
      if (this.flashT < 0 && time >= this.nextFlashAt) {
        this.flashT = 0;
        this.flashPeak = 0.9 + Math.random() * 0.5;
        weatherEvents.emit('thunder');
      }
      if (this.flashT >= 0) {
        this.flashT += delta;
        // Double-pulse envelope over ~0.5 s.
        const envelope =
          Math.exp(-this.flashT * 9) * 0.8 + Math.exp(-((this.flashT - 0.22) ** 2) * 160) * 0.6;
        sunIntensity += this.flashPeak * envelope * 1.2;
        fillIntensity += this.flashPeak * envelope * 0.5;
        plateFlash = Math.min(1, this.flashPeak * envelope);
        if (this.flashT > 0.7) {
          this.flashT = -1;
          this.nextFlashAt = time + FLASH_MIN_INTERVAL_S + Math.random() * (FLASH_MAX_INTERVAL_S - FLASH_MIN_INTERVAL_S);
        }
      }
    } else {
      this.flashT = -1;
    }
    this.sunEntity.setValue(DirectionalLightComponent, 'intensity', sunIntensity);
    this.sunEntity.setValue(DirectionalLightComponent, 'color', this.sunColor);
    this.fillEntity.setValue(AmbientLightComponent, 'intensity', fillIntensity);

    // Cloud deck: overlapping translucent layers hugging the ceiling (or the
    // fallback volume top). The whole deck advects with the shared wind,
    // wrapped inside the room footprint; a slow wander keeps edges alive.
    const spanX = Math.max(0.5, max.x - min.x);
    const spanZ = Math.max(0.5, max.z - min.z);
    this.cloudDriftX += this.wind.x * dt * 0.05;
    this.cloudDriftZ += this.wind.z * dt * 0.05;
    // Sun breakthrough: warm rims only when daylight actually escapes the cover.
    const sunBreak = this.daylightEase * Math.max(0, 1 - cloud * 1.15);
    const cx = (min.x + max.x) / 2;
    const cz = (min.z + max.z) / 2;
    const plateTop = Math.max(min.y + 0.9, max.y - 0.12);
    for (let i = 0; i < this.plates.length; i += 1) {
      const plate = this.plates[i];
      const wander = 0.02 + cloud * 0.06;
      const offX = Math.sin(time * wander + i * 2.1) * spanX * 0.22 + this.cloudDriftX;
      const offZ = Math.cos(time * wander * 0.7 + i * 1.4) * spanZ * 0.22 + this.cloudDriftZ;
      plate.position.set(
        cx + (((offX + spanX * 0.5) % spanX) + spanX) % spanX - spanX * 0.5,
        plateTop - i * 0.055,
        cz + (((offZ + spanZ * 0.5) % spanZ) + spanZ) % spanZ - spanZ * 0.5,
      );
      plate.scale.set(
        spanX * (0.55 + 0.1 * ((i * 2) % 3)),
        spanZ * (0.45 + 0.09 * (((i + 1) * 2) % 3)),
        1,
      );
      const uniforms = this.plateMats[i].uniforms;
      uniforms.uCloud.value = Math.min(1, cloud);
      uniforms.uTime.value = time;
      uniforms.uFlash.value = plateFlash;
      uniforms.uSun.value = sunBreak;
      (uniforms.uTint.value as Color).copy(this.sunColor);
    }

    // Dust: high pressure -> compressed toward the floor and slow;
    // low pressure -> expanded column with a gentle upward swirl.
    const colH = Math.max(0.5, max.y - min.y);
    const floorBias = pressure; // 1 = hug the floor, 0 = fill the column
    const swirl = (1 - pressure) * 0.35;
    // Normalized wind phase so the mote field slides with the shared flow.
    this.dustPhaseX += (this.wind.x * dt * 0.04) / spanX;
    this.dustPhaseZ += (this.wind.z * dt * 0.04) / spanZ;
    const camPos = this.world.camera.getWorldPosition(this.cameraPosition);
    for (let i = 0; i < DUST_COUNT; i += 1) {
      const p = this.dustParts[i];
      const s = p.seed;
      const ix = i * 3;
      const yBase = min.y + colH * (0.1 + p.ySeed * (0.8 - floorBias * 0.7));
      this.dustPos[ix] =
        min.x + (((p.xSeed + time * 0.008 * (1 + swirl) + this.dustPhaseX) % 1 + 1) % 1) * spanX;
      this.dustPos[ix + 1] =
        yBase + Math.sin(time * (0.25 + swirl) + s * 6.28) * 0.08 * (1 + (1 - pressure));
      this.dustPos[ix + 2] =
        min.z + (((p.zSeed + time * 0.006 + this.dustPhaseZ) % 1 + 1) % 1) * spanZ;
      if (swirl > 0.05) {
        this.dustPos[ix + 1] += (((time * swirl * 0.05 + s) % 0.3) * colH) % (colH * 0.3);
        if (this.dustPos[ix + 1] > max.y) this.dustPos[ix + 1] = min.y + 0.1;
      }
      // Cylindrical billboard toward the camera.
      this.dustDummy.position.set(this.dustPos[ix], this.dustPos[ix + 1], this.dustPos[ix + 2]);
      this.dustDummy.rotation.set(
        0,
        Math.atan2(camPos.x - this.dustPos[ix], camPos.z - this.dustPos[ix + 2]),
        0,
      );
      this.dustDummy.scale.setScalar(p.size);
      this.dustDummy.updateMatrix();
      this.dust.setMatrixAt(i, this.dustDummy.matrix);
    }
    this.dust.instanceMatrix.needsUpdate = true;
  }
}
