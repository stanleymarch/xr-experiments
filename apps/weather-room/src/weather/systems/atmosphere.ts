/**
 * Atmosphere: cloud cover -> FogExp2 density + three drifting ceiling plates
 * (opacity capped so passthrough stays comfortable) + directional light
 * dimming with a day/night palette. Pressure -> 400-instance soft dust
 * field (instanced round sprites, never square points): high pressure sinks
 * low and slow, low pressure expands with a gentle upward swirl. Thunderstorm
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
  FogExp2,
  InstancedMesh,
  Mesh,
  Object3D,
  PlaneGeometry,
  ShaderMaterial,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import { roomModel } from '../room.js';
import { weatherStore } from '../weather-state.js';
 
const FOG_CLEAR = 0.006;
const CLOUD_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const CLOUD_FRAGMENT = /* glsl */ `
uniform float uCloud;
uniform float uTime;
uniform float uFlash;
uniform vec3 uTint;
varying vec2 vUv;
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  vec2 p = vUv * vec2(5.0, 3.2) + vec2(uTime * 0.012, uTime * -0.004);
  float n = noise(p) * 0.52 + noise(p * 2.0) * 0.28 + noise(p * 4.0) * 0.14 + noise(p * 8.0) * 0.06;
  float center = 1.0 - smoothstep(0.22, 0.72, length((vUv - 0.5) * vec2(1.0, 1.35)));
  float body = smoothstep(0.35, 0.68, n * 0.62 + center * 0.55 + uCloud * 0.18);
  float alpha = body * (0.04 + uCloud * 0.34);
  if (alpha < 0.008) discard;
  vec3 tint = mix(uTint, vec3(0.88, 0.94, 1.0), uFlash);
  gl_FragColor = vec4(tint, alpha);
}
`;
const FOG_OVERCAST = 0.028;
const FOG_HUMID = 0.008;
const PLATE_MAX_OPACITY = 0.3;
const DUST_COUNT = 400;
const SUN_BRIGHT = 1.0;
const SUN_DIM = 0.35;
const SUN_DAY_COLOR = new Color(0xfff1dc);
const SUN_NIGHT_COLOR = new Color(0x8fa8d8);
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
}
`;

interface DustParticle {
  seed: number;
  alpha: number;
  size: number;
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
  private daylightEase = 0.5;
  private nextFlashAt = 0;
  private flashT = -1; // -1 = idle; otherwise seconds since flash start
  private flashPeak = 0;

  init(): void {
    this.fog = new FogExp2(0x9fb4cc, FOG_CLEAR);
    this.world.scene.fog = this.fog;

    for (let i = 0; i < 3; i += 1) {
      const mat = new ShaderMaterial({
        vertexShader: CLOUD_VERTEX,
        fragmentShader: CLOUD_FRAGMENT,
        uniforms: {
          uCloud: { value: 0.3 },
          uTime: { value: 0 },
          uFlash: { value: 0 },
          uTint: { value: new Color(0xdfe8f2) },
        },
        transparent: true,
        depthWrite: false,
      });
      const plate = new Mesh(new PlaneGeometry(2.4 - i * 0.4, 1.6 - i * 0.25), mat);
      plate.rotation.x = Math.PI / 2;
      plate.renderOrder = 5;
      this.plates.push(plate);
      this.plateMats.push(mat);
      this.plateEntities.push(this.world.createTransformEntity(plate));
    }

    // Dust: instanced soft round sprites (points render as squares on some GPUs).
    const dustGeo = new PlaneGeometry(1, 1);
    const dustAlphas = new Float32Array(DUST_COUNT);
    for (let i = 0; i < DUST_COUNT; i += 1) {
      const seed = ((i * 2654435761) % 1000) / 1000;
      this.dustParts.push({ seed, alpha: 0.25 + 0.5 * ((seed * 17) % 1), size: 0.016 + 0.014 * ((seed * 7) % 1) });
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
    const { min, max } = roomModel;

    // Day/night palette eases so timeline scrubbing never pops.
    const ease = Math.min(1, Math.min(delta, 0.05) * 2);
    this.daylightEase += (daylight - this.daylightEase) * ease;
    this.sunColor.copy(SUN_NIGHT_COLOR).lerp(SUN_DAY_COLOR, this.daylightEase);

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

    // Cloud plates drift near the ceiling (or the fallback volume top);
    // spread across the room width when surfaces are known.
    const spanX = Math.max(0.5, max.x - min.x);
    const spanZ = Math.max(0.5, max.z - min.z);
    const plateY = max.y - 0.2;
    for (let i = 0; i < this.plates.length; i += 1) {
      const plate = this.plates[i];
      const speed = 0.02 + cloud * 0.08;
      plate.position.set(
        (min.x + max.x) / 2 + Math.sin(time * speed + i * 2.1) * spanX * 0.3,
        plateY - i * 0.06,
        (min.z + max.z) / 2 - 0.2 + Math.cos(time * speed * 0.7 + i * 1.4) * spanZ * 0.3,
      );
      const uniforms = this.plateMats[i].uniforms;
      uniforms.uCloud.value = Math.min(1, cloud);
      uniforms.uTime.value = time;
      uniforms.uFlash.value = plateFlash;
      (uniforms.uTint.value as Color).copy(this.sunColor);
    }

    // Dust: high pressure -> compressed toward the floor and slow;
    // low pressure -> expanded column with a gentle upward swirl.
    const colH = Math.max(0.5, max.y - min.y);
    const floorBias = pressure; // 1 = hug the floor, 0 = fill the column
    const swirl = (1 - pressure) * 0.35;
    const camPos = this.world.camera.position;
    for (let i = 0; i < DUST_COUNT; i += 1) {
      const p = this.dustParts[i];
      const s = p.seed;
      const ix = i * 3;
      const yBase = min.y + colH * (1 - floorBias * (0.55 + 0.35 * ((s * 5) % 1)));
      this.dustPos[ix] = min.x + (((s * 3 + time * 0.008 * (1 + swirl)) % 1 + 1) % 1) * spanX;
      this.dustPos[ix + 1] =
        yBase + Math.sin(time * (0.25 + swirl) + s * 6.28) * 0.08 * (1 + (1 - pressure));
      this.dustPos[ix + 2] = min.z + (((s * 11 + time * 0.006) % 1 + 1) % 1) * spanZ;
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
