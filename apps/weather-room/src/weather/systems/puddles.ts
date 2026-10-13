/**
 * Rain-fed water patches anchored to measured floor: mesh floor cells when
 * mapped, distinct hit-test hits on the probe-only path. They accumulate
 * during rain, dry slowly, and use a soft-edge shader with a restrained
 * moving sky sheen instead of pretending to run rigid-body fluid.
 * Unmeasured columns hide the patch: no random floor, no head-height guess.
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
import { enableDepthOcclusion } from '../depth-occlusion.js';
import { enableBeamLighting } from '../light-shared.js';
import { FLOOR_CELL_COPY_MAX, PROBE_HIT_CAPACITY, roomModel } from '../room.js';
import { weatherStore } from '../weather-state.js';

// F5/F6: saturated slate mirror — clear day carries steel blue, overcast a
// darker storm slate, so puddles read as water rather than pale haze.
const SKY_DAY_CLEAR = new Color(0x4a7a9e);
const SKY_OVERCAST = new Color(0x4c5a68);

const PATCH_COUNT = 14;
/** Visible fast enough to read during active rain; ~2 min dry-out. */
const WET_RATE_PER_S = 0.12;
const DRY_RATE_PER_S = 0.008;
/** Hide patches below this wetness (first visible water within ~a second). */
const WET_VISIBLE = 0.06;
/**
 * How far below the viewer's head ground may still be. A column whose lowest
 * measured layer is higher than this (chest-height wall plates on real
 * headsets, tall furniture) is not ground: the decal would float in the air.
 * Knee-to-waist height for a standing viewer, chair height for a seated one.
 */
const PUDDLE_GROUND_CLEARANCE_M = 0.6;
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
  float edge0 = 0.82 + wob * 0.12;
  float body = 1.0 - smoothstep(edge0 - 0.18, edge0, r);
  float inner = 1.0 - smoothstep(0.0, edge0, r);
  // Expanding rain rings, only while it is actually raining.
  float rings = 0.0;
  if (uRain > 0.01) {
    float ph = fract(r * 2.2 - uTime * (0.6 + uRain * 1.8) + wob * 0.35);
    rings = smoothstep(0.0, 0.1, ph) * (1.0 - smoothstep(0.1, 0.32, ph)) * uRain;
  }
  // A puddle is a mirror of the sky, not a grey plate. Two world-space noise
  // taps build the water normal, the view vector reflects off it, and the
  // reflection is graded from the horizon tone to the zenith tone. This is
  // analytic — one noise field, no render target and no SSR pass.
  vec2 w = vBeamWorld.xz * 3.0 + vec2(uTime * 0.05, uTime * -0.03);
  float h0 = snoise(w);
  float dhx = snoise(w + vec2(0.035, 0.0)) - h0;
  float dhz = snoise(w + vec2(0.0, 0.035)) - h0;
  vec3 n = normalize(vec3(-dhx * 42.0, 1.0, -dhz * 42.0));
  vec3 viewDir = normalize(cameraPosition - vBeamWorld);
  vec3 reflected = reflect(-viewDir, n);
  vec3 reflection = mix(uSky * 0.4, uSky, clamp(reflected.y, 0.0, 1.0));
  // One narrow sun specular from the same shared shaft the rain is lit by.
  float spec = pow(max(dot(reflected, -uBeamDir), 0.0), 80.0) * uBeamIntensity;
  float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);
  vec3 col = reflection * (0.45 + 0.55 * fres + 0.25 * inner) + uSky * spec * 2.4;
  float alpha = body * vWetness * clamp(0.2 + 0.45 * fres + rings * 0.3 + spec, 0.0, 0.6);
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
  private readonly patchY = new Float32Array(PATCH_COUNT);
  private readonly lastBounds = new Float32Array(6);
  private readonly cellXZ = new Float32Array(FLOOR_CELL_COPY_MAX * 2);
  private readonly cellH = new Float32Array(FLOOR_CELL_COPY_MAX);
  private readonly hitXYZ = new Float32Array(PROBE_HIT_CAPACITY * 3);
  private readonly dummy = new Object3D();
  private readonly skyColor = new Color();
  private daylightEase = 0.5;
  private material!: ShaderMaterial;
  private lastMeshRevision = -1;
  private lastProbeRevision = -1;
  private lastStatus: string | null = null;
  private lastWetnessLoggedAt = 0;
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
    // Puddles are mirrors of the same shaft the sun specular comes from.
    enableBeamLighting(this.material);
    // Floor decals must hide behind real furniture like rain contacts do.
    enableDepthOcclusion(this.material);
    // Patches sit only on measured columns (flat decals at their height),
    // so water never covers walls or floats past the real floor.
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
    this.patches.name = 'Weather Puddle Patches';
    this.entity = this.world.createTransformEntity(this.patches);
    this.cleanupFuncs.push(() => this.entity.dispose());
  }

  update(delta: number): void {
    const current = weatherStore.current();
    const rain = current?.drivers.rain ?? 0;
    const { min, max } = roomModel;
    const moved =
      Math.abs(min.x - this.lastBounds[0]) > 0.25 ||
      Math.abs(min.y - this.lastBounds[1]) > 0.25 ||
      Math.abs(min.z - this.lastBounds[2]) > 0.25 ||
      Math.abs(max.x - this.lastBounds[3]) > 0.25 ||
      Math.abs(max.y - this.lastBounds[4]) > 0.25 ||
      Math.abs(max.z - this.lastBounds[5]) > 0.25;
    const status = roomModel.roomSurfaceStatus();
    // Reseed only on new measured knowledge (mesh revision, probe hits, or
    // a volume move) — never on a clock — and never clear wetness: mapping
    // updates only move the patch columns, evaporation is the only drain.
    if (
      !roomModel.building &&
      (roomModel.meshRevision !== this.lastMeshRevision ||
        roomModel.probeRevision !== this.lastProbeRevision ||
        status !== this.lastStatus ||
        moved)
    ) {
      this.reseedPatches();
      this.lastBounds[0] = min.x;
      this.lastBounds[1] = min.y;
      this.lastBounds[2] = min.z;
      this.lastBounds[3] = max.x;
      this.lastBounds[4] = max.y;
      this.lastBounds[5] = max.z;
      this.lastMeshRevision = roomModel.meshRevision;
      this.lastProbeRevision = roomModel.probeRevision;
      this.lastStatus = status;
    }
    const dt = Math.min(delta, 0.05);
    const time = performance.now() / 1000;
    (this.material.uniforms.uTime as { value: number }).value = time;
    (this.material.uniforms.uRain as { value: number }).value = rain;
    // Wet sheen mirrors the actual sky: slate when overcast, warmer and
    // brighter when daylight escapes the cover, dim at night.
    const daylight = current?.drivers.daylight ?? 0.5;
    const cloud = current?.drivers.cloud ?? 0.3;
    this.daylightEase += (daylight - this.daylightEase) * Math.min(1, dt * 2);
    this.skyColor
      .copy(SKY_DAY_CLEAR)
      .lerp(SKY_OVERCAST, cloud)
      .multiplyScalar(0.2 + 0.8 * this.daylightEase);
    (this.material.uniforms.uSky as { value: Color }).value.copy(this.skyColor);
    // Water pools on ground, not on chest-high support: a column whose lowest
    // measured layer is above knee-to-waist height is furniture or a bad
    // measurement, and a puddle decal floating there reads as a defect.
    const head = this.world.player.head;
    head.updateWorldMatrix(true, false);
    const groundCeilingY = head.position.y - PUDDLE_GROUND_CLEARANCE_M;
    let visible = 0;
    for (let i = 0; i < PATCH_COUNT; i += 1) {
      this.wetness[i] = Math.max(0, Math.min(1, this.wetness[i] + rain * WET_RATE_PER_S * dt - (1 - rain) * DRY_RATE_PER_S * dt));
      const x = this.xz[i * 2];
      const z = this.xz[i * 2 + 1];
      // Water sits on the lowest measured layer in this column. An incomplete
      // scan can contain only furniture, so this is not a semantic floor label.
      // Unmeasured columns hide the patch: no random floor, no head-height
      // guess, no-capability fallback is explicitly not ground.
      const surfaceY = Number.isFinite(this.patchY[i]) && roomModel.hasSurfaces ? roomModel.floorHeightAt(x, z) : null;
      const placedY = surfaceY ?? this.patchY[i];
      if (surfaceY != null && surfaceY <= groundCeilingY) this.patchY[i] = surfaceY;
      if (placedY == null || !Number.isFinite(placedY) || placedY > groundCeilingY || this.wetness[i] < WET_VISIBLE) {
        this.dummy.position.set(0, -10, 0);
        this.dummy.scale.set(0.001, 0.001, 1);
      } else {
        // +0.03 matches the real-depth bias so the patch rests on its own
        // sampled level instead of clipping into it.
        this.dummy.position.set(x, placedY + 0.03, z);
        this.dummy.rotation.set(-Math.PI / 2, 0, this.seedAngle(i));
        const radius = 0.14 + this.wetness[i] * 0.4;
        this.dummy.scale.set(radius * (0.8 + (i % 4) * 0.08), radius, 1);
        visible += 1;
      }
      this.dummy.updateMatrix();
      this.patches.setMatrixAt(i, this.dummy.matrix);
    }
    this.patches.instanceMatrix.needsUpdate = true;
    (this.patches.geometry.getAttribute('aWetness') as unknown as { needsUpdate: boolean }).needsUpdate = true;
    if (rain > 0.05 && time - this.lastWetnessLoggedAt > 5) {
      this.lastWetnessLoggedAt = time;
      let peak = 0;
      for (let i = 0; i < PATCH_COUNT; i += 1) peak = Math.max(peak, this.wetness[i]);
      console.info(`[weather-room] puddles: status=${status} visible=${visible}/${PATCH_COUNT} peakWet=${peak.toFixed(2)}`);
    }
  }

  /**
   * Place every patch on measured support: mapped floor cells first, then
   * distinct probe hits on the probe-only path (a bounded patch around the
   * viewer, never a whole room). Anything unplaced hides (NaN height).
   * Wetness is never touched here.
   */
  private reseedPatches(): void {
    for (let i = 0; i < PATCH_COUNT; i += 1) this.patchY[i] = Number.NaN;
    // Mesh path: mapped floor cells. Probe-only path: the hit ring directly
    // (the probe grid cells ARE those hits quantized — using both would
    // stack two patches per hit). Anything unplaced hides (NaN height).
    const probeOnly = roomModel.roomSurfaceStatus() === 'probe';
    const cells = probeOnly ? 0 : roomModel.copyMappedFloorCells(this.cellXZ, this.cellH);
    const hits = roomModel.copyProbeHits(this.hitXYZ);
    for (let i = 0; i < PATCH_COUNT; i += 1) {
      if (i < cells) {
        const cell = Math.floor(i * cells / Math.min(cells, PATCH_COUNT));
        this.xz[i * 2] = this.cellXZ[cell * 2];
        this.xz[i * 2 + 1] = this.cellXZ[cell * 2 + 1];
        this.patchY[i] = this.cellH[cell];
      } else if (i - cells < hits) {
        const h = i - cells;
        this.xz[i * 2] = this.hitXYZ[h * 3];
        this.xz[i * 2 + 1] = this.hitXYZ[h * 3 + 2];
        this.patchY[i] = this.hitXYZ[h * 3 + 1];
      } else {
        this.xz[i * 2] = 0;
        this.xz[i * 2 + 1] = 0;
      }
    }
  }

  private seedAngle(index: number): number {
    return ((index * 2654435761) % 6283) / 1000;
  }

  override destroy(): void {
    super.destroy();
    this.wetness.fill(0);
    this.xz.fill(0);
    this.patchY.fill(Number.NaN);
    this.lastMeshRevision = -1;
    this.lastProbeRevision = -1;
    this.lastStatus = null;
  }
}
