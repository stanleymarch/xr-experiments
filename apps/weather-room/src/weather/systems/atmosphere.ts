/**
 * Atmosphere: cloud cover -> FogExp2 density + a single thick cloud slab
 * hugging the ceiling whose fragment ray-marches the shared noise atlas
 * vertically (volumetric billows, 4 samples with a measured 2-sample
 * fallback) + directional light dimming with a day/night palette. The slab
 * advects with the shared wind so overcast wind hours read as moving sky.
 * A 400-instance mote field lives only inside the light shaft (see
 * light-shared.ts): motes outside the beam are invisible, which is the
 * physical reason they are there at all; snowfall is the one hour that lets
 * them read as sparks in the snow. Thunderstorm hours add one soft light
 * flash every few seconds, never a strobe.
 */

import {
  NormalBlending,
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
import { enableDepthOcclusion } from '../depth-occlusion.js';
import { enableHandField, HAND_FIELD_LAYERS } from '../hand-field.js';
import { beamGateAt, SUN_DAY_COLOR, SUN_NIGHT_COLOR } from '../light-shared.js';
import { roomModel } from '../room.js';
import { WeatherEvent, weatherEvents, weatherStore } from '../weather-state.js';
import type { HourCrossedDetail } from '../weather-state.js';
import { Haptics, pulseHaptics } from '../feedback.js';
import { windVectorFromFrame } from '../wind-shared.js';
import { createCloudNoise } from '../cloud-noise.js';
 
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
uniform sampler2D uNoise;
uniform float uTime;
uniform float uFlash;
uniform float uSeed;
uniform float uSun;
uniform vec3 uTint;
uniform int uCloudSteps;
varying vec2 vUv;
void main() {
  // Volumetric billows inside one thick slab: a few samples marched up through
  // the shared 128x128 RG atlas along the vertical, integrated into density, so
  // the deck reads as a body with dark bases and lit crowns instead of three
  // flat plates. uCloudSteps is 4 only while the measured frame time proves
  // 72 Hz headroom and drops to 2 when it slips; the loop bound stays constant
  // and only the break moves.
  vec2 p = vUv * vec2(3.1, 2.4) + uSeed * 19.7 + vec2(uTime * 0.016, uTime * -0.005);
  float cover = 0.66 - uCloud * 0.36;
  float density = 0.0;
  float lit = 0.0;
  for (int k = 0; k < 4; k += 1) {
    if (k >= uCloudSteps) break;
    float fk = float(k);
    vec2 billows = texture2D(uNoise, (p + vec2(fk * 0.11, fk * 0.19)) * 0.25).rg;
    density += smoothstep(cover, cover + 0.4, billows.r);
    lit += billows.g;
  }
  float steps = max(float(uCloudSteps), 1.0);
  density /= steps;
  lit /= steps;
  // Organic elliptical footprint perturbed by noise: never a rectangle.
  float rad = length((vUv - 0.5) * vec2(2.0, 2.35)) + (density - 0.5) * 0.4;
  float edge = 1.0 - smoothstep(0.5, 0.95, rad);
  // Vertical integration: opaque bases, sunlight opening the crowns.
  float light = exp(-density * 2.0) + uSun * clamp(density, 0.0, 1.0);
  float shade = clamp(light, 0.16, 1.7) * mix(0.72, 1.12, vUv.y) * (0.9 + 0.2 * lit);
  // The deck is a body, not a lid: overcast needs a real presence, and a
  // genuinely open sky gets a cool luminous rift instead of a flat gray cap.
  float alpha = edge * (1.0 - exp(-density * 1.7)) * min(0.72, 0.1 + uCloud * 0.62);
  if (alpha < 0.008) discard;
  // F5/F6: saturated storm slate with darker bases; crowns open warm only
  // through real sun breaks (uSun), so overcast reads heavy, not pale gray.
  vec3 slate = vec3(0.22, 0.27, 0.36) * shade;
  float rim = clamp(shade - 0.55, 0.0, 0.63) * 1.6;
  vec3 col = mix(slate, uTint * (0.65 + 0.55 * shade), clamp(uSun * rim, 0.0, 1.0));
  col = mix(col, vec3(0.9, 0.95, 1.0), uFlash * 0.85);
  // Zenith break: where the cover genuinely opens, a cool luminous rift
  // instead of a flat gray lid (overcast never gets one — uSun stays low).
  col = mix(col, vec3(0.82, 0.88, 1.0), smoothstep(0.5, 1.0, uSun) * smoothstep(0.2, 0.6, shade) * 0.5);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
const FOG_OVERCAST = 0.028;
const FOG_HUMID = 0.008;
const DUST_COUNT = 400;
/** One thick slab now holds the whole deck; the fragment ray-marches it. */
const PLATE_COUNT = 1;
const SUN_DIM = 0.2;
const SUN_BRIGHT = 0.75;
const SKY_CLEAR = new Color(0x1e2f45);
const SKY_CLOUDY = new Color(0x3d4752);
const HORIZON_CLEAR = new Color(0x76685f);
const HORIZON_CLOUDY = new Color(0x525b66);
const FLASH_MIN_INTERVAL_S = 4;
const FLASH_MAX_INTERVAL_S = 11;
/** Gaussian sigma and life of one lightning flash: a single ~0.35 s pulse. */
const FLASH_SIGMA_S = 0.09;
const FLASH_LIFE_S = 0.55;
/** Pale electric tint the fog breathes toward during a flash. */
const FLASH_TINT = new Color(0xcfe0ff);
/** Cloud ray-march sample counts and the frame time that justifies 4. */
const CLOUD_STEPS_FULL = 4;
const CLOUD_STEPS_FALLBACK = 2;
const CLOUD_STEP_BUDGET_S = 1 / 72;
/** Frames to ignore before the cloud step count trusts the measured frame time. */
const CLOUD_WARMUP_FRAMES = 90;

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
  private readonly dustAlphas = new Float32Array(DUST_COUNT);
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
  /** Fog colour before the lightning lift, so the flash never fights the ramp. */
  private readonly fogBase = new Color(0x9fb4cc);
  private nextFlashAt = 0;
  private flashT = -1; // -1 = idle; otherwise seconds since flash start
  private flashPeak = 0;
  /** Set by the Thunder bus event; consumed once by the next update. */
  private flashPending = false;
  /** Measured frame time EMA: what decides the cloud sample count. */
  private frameEma = 1 / 72;
  private framesSeen = 0;
  private cloudSteps = CLOUD_STEPS_FULL;
  /** Room-wide hour pulse: 0 = idle, otherwise seconds since the crossing. */
  private hourPulseT = -1;
  /** NOW snaps pulse slightly stronger than plain hour detents. */
  private hourPulsePeak = 1.0;
  init(): void {
    this.fog = new FogExp2(0x9fb4cc, FOG_CLEAR);
    this.world.scene.fog = this.fog;

    const plateGeo = new PlaneGeometry(1, 1);
    const cloudNoise = createCloudNoise();
    this.cleanupFuncs.push(() => {
      cloudNoise.dispose();
      plateGeo.dispose();
      for (const material of this.plateMats) material.dispose();
    });
    for (let i = 0; i < PLATE_COUNT; i += 1) {
      const mat = new ShaderMaterial({
        vertexShader: CLOUD_VERTEX,
        fragmentShader: CLOUD_FRAGMENT,
        uniforms: {
          uNoise: { value: cloudNoise },
          uCloud: { value: 0.3 },
          uTime: { value: 0 },
          uFlash: { value: 0 },
          uSeed: { value: i * 0.618033 },
          uSun: { value: 0 },
          uCloudSteps: { value: CLOUD_STEPS_FULL },
          uTint: { value: new Color(0xa7b8cf) },
        },
        transparent: true,
        depthWrite: false,
      });
      const plate = new Mesh(plateGeo, mat);
      plate.rotation.x = Math.PI / 2;
      plate.renderOrder = 5;
      plate.name = 'Weather Cloud Slab';
      // Cloud sheets hang over the room; real walls and tall furniture must
      // cut them instead of being painted over.
      enableDepthOcclusion(mat);
      this.plates.push(plate);
      this.plateMats.push(mat);
      this.plateEntities.push(this.world.createTransformEntity(plate));
    }

    // Dust: instanced soft round sprites (points render as squares on some GPUs).
    const dustGeo = new PlaneGeometry(1, 1);
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
      this.dustAlphas[i] = this.dustParts[i].alpha;
    }
    const alphaAttr = new InstancedBufferAttribute(this.dustAlphas, 1);
    alphaAttr.setUsage(DynamicDrawUsage);
    const dustMaterial = new ShaderMaterial({
      vertexShader: DUST_VERTEX,
      fragmentShader: DUST_FRAGMENT,
      uniforms: { uColor: { value: new Color(0x8b98ab) } },
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
    });
    enableDepthOcclusion(dustMaterial);
    // Staged rollout flag: dust motes sweep around a tracked hand. The cloud
    // slab is room-scale and never wired — a 6 cm push would be meaningless.
    if (HAND_FIELD_LAYERS.dust) enableHandField(dustMaterial);
    this.dust = new InstancedMesh(
      dustGeo,
      dustMaterial,
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
    this.dust.name = 'Weather Dust Motes';
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
    // Same shared hour moment as the guide fill, panels, detent haptic, and
    // tick audio: a brief room pulse (light + fog + particles below). A NOW
    // snap carries the same pulse at a slightly stronger peak so the room
    // acknowledges the snap without a second channel.
    this.cleanupFuncs.push(
      weatherEvents.on(WeatherEvent.HourCrossed, (detail: unknown) => {
        const crossed = detail as HourCrossedDetail | undefined;
        this.hourPulseT = 0;
        this.hourPulsePeak = crossed?.isLive === true ? 1.6 : 1.0;
      }),
      // The flash wire exists for whoever emits Thunder next (the hand-clap
      // sandbox slice). This module only listens; the storm hours below give
      // the branch its own schedule in the meantime.
      weatherEvents.on(WeatherEvent.Thunder, () => {
        this.flashPending = true;
      }),
    );
  }

  update(delta: number): void {
    const current = weatherStore.current();
    const cloud = current?.drivers.cloud ?? 0.3;
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
      this.fogBase.copy(this.horizonColor);
      this.lastSkyCloud = cloud;
      this.lastSkyDay = this.daylightEase;
    }

    // Room-wide hour pulse: a brief (~0.6 s) coordinated lift of the room
    // light, fog density, and particle shimmer on the same shared hour
    // moment as the guide fill, panels, detent haptic, and tick audio.
    // Passthrough-safe by construction: no strobe (single soft Gaussian
    // envelope, peak +18% sun / +12% fill / +10% fog), no geometry or
    // placement changes, and the particle layer only brightens in place —
    // the real room behind passthrough stays dominant and readable.
    let hourPulse = 0;
    if (this.hourPulseT >= 0) {
      this.hourPulseT += dt;
      hourPulse = this.hourPulsePeak * Math.exp(-((this.hourPulseT - 0.18) ** 2) * 60);
      if (this.hourPulseT > 0.7) {
        this.hourPulseT = -1;
        hourPulse = 0;
      }
    }
    const baseSun =
      (SUN_BRIGHT - (SUN_BRIGHT - SUN_DIM) * cloud) * (0.22 + 0.78 * this.daylightEase);
    const baseFill = 0.1 + 0.18 * this.daylightEase;

    // Lightning: one soft Gaussian flash (~0.35 s visible), never a strobe.
    // Storm hours schedule it 4-11 s apart; a Thunder bus event (the hand-clap
    // sandbox slice) fires one immediately through the same envelope. It lifts
    // the sun and fill, lifts the fog density and breathes the fog tint pale.
    if (this.flashPending) {
      this.flashPending = false;
      this.startFlash(time);
    }
    if (thunder) {
      if (this.nextFlashAt <= 0 || (this.flashT < 0 && time >= this.nextFlashAt)) this.startFlash(time);
    } else {
      this.nextFlashAt = 0;
    }
    let flash = 0;
    if (this.flashT >= 0) {
      this.flashT += dt;
      flash =
        this.flashPeak *
        Math.exp(-((this.flashT - 0.12) ** 2) / (2 * FLASH_SIGMA_S * FLASH_SIGMA_S));
      if (this.flashT > FLASH_LIFE_S) {
        this.flashT = -1;
        flash = 0;
      }
    }
    this.fog.density =
      (FOG_CLEAR + (FOG_OVERCAST - FOG_CLEAR) * cloud + FOG_HUMID * humidity + (fogCode ? 0.025 : 0)) *
      (1 + hourPulse * 0.1) *
      (1 + flash * 0.22);
    // Fog colour is composed here every frame so the lightning lift can never
    // fight the day/night ramp: the base comes from the ramp, the pulse is a
    // lerp on top of it.
    this.fog.color.copy(this.fogBase).lerp(FLASH_TINT, Math.min(0.6, flash * 0.5));

    let sunIntensity = baseSun * (1 + hourPulse * 0.18) * (1 + flash * 0.9);
    let fillIntensity = baseFill * (1 + hourPulse * 0.12) * (1 + flash * 0.7);
    let plateFlash = hourPulse * 0.25 + flash;
    // The computed ramp must reach the real lights: day/night, cloud dimming,
    // the hour pulse and lightning all flow through these two entities.
    this.sunEntity.setValue(DirectionalLightComponent, 'intensity', sunIntensity);
    this.fillEntity.setValue(AmbientLightComponent, 'intensity', fillIntensity);
    // The SEM/project environment map is the biggest radiance source; without
    // this it holds the room at a flat full-white wash that no light ramp can
    // cut through. Scale it with the same day/cloud envelope as the lights.
    const env = this.world.scene;
    if ('environmentIntensity' in env) {
      env.environmentIntensity = Math.max(
        0.12,
        (0.85 - 0.5 * cloud) * (0.2 + 0.8 * this.daylightEase) * (1 + flash * 0.6),
      );
    }

    // Cloud sample count follows the measured frame time: 4 samples only while
    // a 72 Hz budget is actually held, 2 the moment it slips. The warmup skips
    // the first frames, where shader compiles and asset decode distort it.
    this.framesSeen += 1;
    if (this.framesSeen > CLOUD_WARMUP_FRAMES) {
      // Seed from the first post-warmup frame instead of decaying out of the
      // optimistic 72 Hz default, so the very first decision is already based
      // on a measured frame time.
      const sample = Math.min(delta, 0.2);
      if (this.framesSeen === CLOUD_WARMUP_FRAMES + 1) this.frameEma = sample;
      else this.frameEma += (sample - this.frameEma) * 0.05;
      // Dead band: 4 samples are only adopted with real headroom, and kept
      // until the frame time clearly slips past the budget, so the count never
      // flaps around the threshold.
      if (this.cloudSteps === CLOUD_STEPS_FULL) {
        if (this.frameEma > CLOUD_STEP_BUDGET_S * 1.05) this.setCloudSteps(CLOUD_STEPS_FALLBACK);
      } else if (this.frameEma < CLOUD_STEP_BUDGET_S * 0.85) {
        this.setCloudSteps(CLOUD_STEPS_FULL);
      }
    }

    // Cloud deck: one thick slab hugging the ceiling (or the fallback volume
    // top) whose fragment integrates density vertically, so it reads as a
    // body rather than as stacked plates. It advects with the shared wind,
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
      uniforms.uCloudSteps.value = this.cloudSteps;
      (uniforms.uTint.value as Color).copy(this.sunColor);
    }

    // Dust reprofiled as light-shaft motes. Pressure no longer shapes the
    // field — that coupling was not readable to anyone standing in the room.
    // What remains is one cause: a mote is only visible inside the shaft, so
    // the gate multiplies both its alpha and its size. Snowfall is the one
    // context where motes live outside the shaft, as sparks in the snow.
    const colH = Math.max(0.5, max.y - min.y);
    const snowing = (current?.drivers.snow ?? 0) > 0.02;
    const gateFloor = snowing ? 0.5 : 0;
    // Normalized wind phase so the mote field slides with the shared flow.
    this.dustPhaseX += (this.wind.x * dt * 0.04) / spanX;
    this.dustPhaseZ += (this.wind.z * dt * 0.04) / spanZ;
    const camPos = (this.xrManager.isPresenting ? this.world.player.head : this.world.camera).getWorldPosition(this.cameraPosition);
    for (let i = 0; i < DUST_COUNT; i += 1) {
      const p = this.dustParts[i];
      const s = p.seed;
      const ix = i * 3;
      const yBase = min.y + colH * (0.12 + p.ySeed * 0.62);
      this.dustPos[ix] =
        min.x + (((p.xSeed + time * 0.008 + this.dustPhaseX) % 1 + 1) % 1) * spanX;
      this.dustPos[ix + 1] = yBase + Math.sin(time * 0.25 + s * 6.28) * 0.08;
      this.dustPos[ix + 2] =
        min.z + (((p.zSeed + time * 0.006 + this.dustPhaseZ) % 1 + 1) % 1) * spanZ;
      const gate = Math.max(
        gateFloor,
        beamGateAt(this.dustPos[ix], this.dustPos[ix + 1], this.dustPos[ix + 2]),
      );
      this.dustAlphas[i] = p.alpha * gate;
      // Cylindrical billboard toward the camera. The hour pulse briefly
      // swells mote size in place (no new drift, no geometry changes).
      this.dustDummy.position.set(this.dustPos[ix], this.dustPos[ix + 1], this.dustPos[ix + 2]);
      this.dustDummy.rotation.set(
        0,
        Math.atan2(camPos.x - this.dustPos[ix], camPos.z - this.dustPos[ix + 2]),
        0,
      );
      this.dustDummy.scale.setScalar(p.size * (0.5 + 0.5 * gate) * (1 + hourPulse * 0.35));
      this.dustDummy.updateMatrix();
      this.dust.setMatrixAt(i, this.dustDummy.matrix);
    }
    this.dust.instanceMatrix.needsUpdate = true;
    (this.dust.geometry.getAttribute('aAlpha') as InstancedBufferAttribute).needsUpdate = true;
  }

  /**
   * Adopt a cloud sample count and announce it once, with the frame time that
   * justified it, so a reviewer can see the 4-vs-2 decision in the console.
   */
  private setCloudSteps(steps: number): void {
    this.cloudSteps = steps;
    console.info(
      `[weather-room] cloud ray-march ${steps} samples (measured frame ${(this.frameEma * 1000).toFixed(1)} ms)`,
    );
  }

  /**
   * Arm one lightning flash: a single Gaussian pulse with a randomized peak
   * and the next storm-hour slot 4-11 s out. Deterministic time-hashed jitter
   * keeps the schedule free of `Math.random` like the rest of the app.
   */
  private startFlash(time: number): void {
    this.flashT = 0;
    this.flashPeak = 0.5 + 0.4 * ((time * 0.11) % 1);
    this.nextFlashAt =
      time + FLASH_MIN_INTERVAL_S + (FLASH_MAX_INTERVAL_S - FLASH_MIN_INTERVAL_S) * ((time * 0.53) % 1);
  }
}
