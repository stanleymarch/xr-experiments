/**
 * Wind: two coupled instanced fields advected along the shared world wind
 * vector inside the RoomModel bounds — soft ribbon streaks (camera-facing
 * quads rolled onto a slowly meandering flow line, so the air reads as
 * graceful curved currents) and granular sparkles riding the same flow.
 * Speed/length/opacity <- drivers.wind + gusts; calm air still drifts
 * slowly so zero-rain hours never look dead, but missing wind data yields
 * no invented flow. Instanced quads replace 1 px THREE.Line ribbons: line
 * primitives are nearly invisible on Quest displays. All buffers
 * preallocated; per-frame work touches only live instances.
 * All GLSL here is original (no Shadertoy/Book-of-Shaders copies).
 */

import {
  NormalBlending,
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
import { enableDepthOcclusion } from '../depth-occlusion.js';
import { enableHandField, HAND_FIELD_LAYERS } from '../hand-field.js';
import { enableBeamLighting } from '../light-shared.js';
import { roomModel } from '../room.js';
import { weatherStore } from '../weather-state.js';
import { windVectorFromFrame } from '../wind-shared.js';

const STREAK_FULL = 120;
const STREAK_REDUCED = 60;
const SPARK_FULL = 150;
const SPARK_REDUCED = 72;
const BASE_SPEED = 0.16;

const STREAK_VERTEX = /* glsl */ `
attribute float aAlpha;
attribute float aSeed;
attribute float aCurve;
uniform float uTime;
varying float vAlpha;
varying float vSeed;
varying vec2 vUv;
void main() {
  vAlpha = aAlpha;
  vSeed = aSeed;
  vUv = uv;
  vec3 p = position;
  p.y += sin(position.x * 6.283185 + aSeed * 6.283185 + uTime * 0.2) * aCurve;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
}
`;
const STREAK_FRAGMENT = /* glsl */ `
uniform float uTime;
varying float vAlpha;
varying float vSeed;
varying vec2 vUv;
void main() {
  // Luminous air filament: gaussian core across the width and a brightness
  // pulse travelling along the flow. The smooth end dissolve is replaced by
  // moving fract bands, so the fibre tears into ragged pieces the way visible
  // air does instead of reading as one drawn stroke.
  float across = (vUv.y - 0.5) * 2.0;
  float core = exp(-across * across * 7.0);
  float bands = fract(vUv.x * 3.2 - uTime * (0.25 + vSeed * 0.5) + vSeed * 10.0);
  float torn = smoothstep(0.0, 0.18, bands) * (1.0 - smoothstep(0.6, 0.92, bands));
  float tips = smoothstep(0.0, 0.08, vUv.x) * (1.0 - smoothstep(0.9, 1.0, vUv.x));
  float pulse = 0.55 + 0.45 * sin(vUv.x * 8.0 - uTime * (1.5 + vSeed * 2.0) + vSeed * 40.0);
  // Air is only visible where the light crosses it.
  float beam = rBeamFactor(vBeamWorld);
  float a = core * torn * tips * pulse * vAlpha * beam;
  if (a < 0.01) discard;
  float outA = a * 0.6;
  gl_FragColor = vec4(vec3(0.66, 0.86, 1.0) * outA, outA);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
const SPARK_VERTEX = /* glsl */ `
attribute float aAlpha;
attribute float aSeed;
varying float vAlpha;
varying float vSeed;
varying vec2 vUv;
void main() {
  vAlpha = aAlpha;
  vSeed = aSeed;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;
const SPARK_FRAGMENT = /* glsl */ `
uniform float uTime;
varying float vAlpha;
varying float vSeed;
varying vec2 vUv;
void main() {
  // Granular mote riding the flow: round soft dot with a slow twinkle, dimmed
  // outside the light and lifted inside it, so the field reads as seeds and
  // leaves carried by air rather than as a uniform sprinkle.
  float d = length((vUv - 0.5) * 2.0);
  float dot_ = exp(-d * d * 5.0);
  float twinkle = 0.55 + 0.45 * sin(uTime * (2.0 + vSeed * 3.0) + vSeed * 80.0);
  float beam = rBeamFactor(vBeamWorld);
  float a = dot_ * twinkle * vAlpha;
  if (a < 0.01) discard;
  float outA = a * 0.55 * beam;
  gl_FragColor = vec4(vec3(0.72, 0.88, 1.0) * outA, outA);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class WindSystem extends createSystem({}) {
  private streakEntity!: Entity;
  private sparkEntity!: Entity;
  private streaks!: InstancedMesh;
  private sparks!: InstancedMesh;
  private streakMat!: ShaderMaterial;
  private sparkMat!: ShaderMaterial;
  private readonly streakHeads = new Float32Array(STREAK_FULL * 3);
  private readonly streakSeeds = new Float32Array(STREAK_FULL);
  private readonly streakAlphas = new Float32Array(STREAK_FULL);
  private readonly streakCurves = new Float32Array(STREAK_FULL);
  private readonly sparkPos = new Float32Array(SPARK_FULL * 3);
  private readonly sparkSeeds = new Float32Array(SPARK_FULL);
  private readonly sparkAlphas = new Float32Array(SPARK_FULL);
  private readonly dummy = new Object3D();
  private readonly wind = new Vector3();
  private readonly cameraPos = new Vector3();
  private readonly lastBounds = new Float32Array(6);
  private profile!: ReadonlySignal<CapabilityProfile>;
  private seeded = false;

  init(): void {
    this.profile = capabilityProfile(this.world);
    for (let i = 0; i < STREAK_FULL; i += 1) {
      this.streakSeeds[i] = ((i * 2654435761) % 1000) / 1000;
    }
    for (let i = 0; i < SPARK_FULL; i += 1) {
      this.sparkSeeds[i] = ((i * 2246822519) % 1000) / 1000;
    }

    const streakGeo = new PlaneGeometry(1, 1, 16, 1);
    const streakAlphaAttr = new InstancedBufferAttribute(this.streakAlphas, 1);
    streakAlphaAttr.setUsage(DynamicDrawUsage);
    streakGeo.setAttribute('aAlpha', streakAlphaAttr);
    streakGeo.setAttribute('aSeed', new InstancedBufferAttribute(this.streakSeeds, 1));
    const curveAttr = new InstancedBufferAttribute(this.streakCurves, 1);
    curveAttr.setUsage(DynamicDrawUsage);
    streakGeo.setAttribute('aCurve', curveAttr);
    this.streakMat = new ShaderMaterial({
      vertexShader: STREAK_VERTEX,
      fragmentShader: STREAK_FRAGMENT,
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: NormalBlending,
    });
    // Wind streaks and sparks are part of the same room-filling volume and
    // read the shared light shaft, with the depth test layered on top.
    enableBeamLighting(this.streakMat);
    enableDepthOcclusion(this.streakMat);
    // Staged rollout: implemented, off until the rain/dust wave is verified
    // on hardware (flag in hand-field.ts). With the flag false the shader
    // source is untouched and the field costs nothing.
    if (HAND_FIELD_LAYERS.wind) enableHandField(this.streakMat);
    this.streaks = new InstancedMesh(streakGeo, this.streakMat, STREAK_FULL);
    this.streaks.frustumCulled = false;
    this.streaks.instanceMatrix.setUsage(DynamicDrawUsage);
    this.parkAll(this.streaks, STREAK_FULL);
    this.streakEntity = this.world.createTransformEntity(this.streaks);

    const sparkGeo = new PlaneGeometry(1, 1);
    const sparkAlphaAttr = new InstancedBufferAttribute(this.sparkAlphas, 1);
    sparkAlphaAttr.setUsage(DynamicDrawUsage);
    sparkGeo.setAttribute('aAlpha', sparkAlphaAttr);
    sparkGeo.setAttribute('aSeed', new InstancedBufferAttribute(this.sparkSeeds, 1));
    this.sparkMat = new ShaderMaterial({
      vertexShader: SPARK_VERTEX,
      fragmentShader: SPARK_FRAGMENT,
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: NormalBlending,
    });
    enableBeamLighting(this.sparkMat);
    enableDepthOcclusion(this.sparkMat);
    if (HAND_FIELD_LAYERS.wind) enableHandField(this.sparkMat);
    this.sparks = new InstancedMesh(sparkGeo, this.sparkMat, SPARK_FULL);
    this.sparks.frustumCulled = false;
    this.sparks.instanceMatrix.setUsage(DynamicDrawUsage);
    this.parkAll(this.sparks, SPARK_FULL);
    this.sparkEntity = this.world.createTransformEntity(this.sparks);

    this.cleanupFuncs.push(() => {
      // InstancedMesh GPU buffers release only through their own dispose event.
      this.streaks.dispose();
      this.sparks.dispose();
      this.streakEntity.dispose();
      this.sparkEntity.dispose();
    });
  }

  update(delta: number): void {
    const current = weatherStore.current();
    if (current == null || !current.frame.available.windSpeedKmh || !current.frame.available.windDirectionDeg) {
      this.streaks.count = 0;
      this.sparks.count = 0;
      return;
    }
    const meanWind = current?.drivers.wind ?? 0;
    const gust = current?.drivers.gust ?? 0;
    const strength = Math.min(1, meanWind + Math.max(0, gust - meanWind) * 0.55);
    const dt = Math.min(delta, 0.05);
    const { min, max } = roomModel;
    const spanX = Math.max(0.5, max.x - min.x);
    const spanY = Math.max(0.5, max.y - min.y);
    const spanZ = Math.max(0.5, max.z - min.z);
    windVectorFromFrame(current.frame, 1, this.wind);
    const speed = BASE_SPEED * (1 + strength * 14);
    const time = performance.now() / 1000;

    const moved =
      !this.seeded ||
      Math.abs(min.x - this.lastBounds[0]) > 0.25 ||
      Math.abs(min.y - this.lastBounds[1]) > 0.25 ||
      Math.abs(min.z - this.lastBounds[2]) > 0.25 ||
      Math.abs(max.x - this.lastBounds[3]) > 0.25 ||
      Math.abs(max.y - this.lastBounds[4]) > 0.25 ||
      Math.abs(max.z - this.lastBounds[5]) > 0.25;
    if (moved) {
      this.seeded = true;
      this.lastBounds[0] = min.x;
      this.lastBounds[1] = min.y;
      this.lastBounds[2] = min.z;
      this.lastBounds[3] = max.x;
      this.lastBounds[4] = max.y;
      this.lastBounds[5] = max.z;
      this.seedField(min.x, min.y, min.z, spanX, spanY, spanZ);
    }

    const dirLen = Math.hypot(this.wind.x, this.wind.z);
    const hasWind = dirLen > 0.05;
    const dirX = hasWind ? this.wind.x / dirLen : 1;
    const dirZ = hasWind ? this.wind.z / dirLen : 0;
    // Cylindrical-billboard basis: local X of the quad in world space.
    (this.xrManager.isPresenting ? this.world.player.head : this.world.camera).getWorldPosition(this.cameraPos);
    const yaw = Math.atan2(
      this.cameraPos.x - (min.x + spanX / 2),
      this.cameraPos.z - (min.z + spanZ / 2),
    );
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);

    const budget = this.profile.peek().particleBudget === 'full';
    const streakLive = budget ? STREAK_FULL : STREAK_REDUCED;
    const sparkLive = budget ? SPARK_FULL : SPARK_REDUCED;
    this.streaks.count = streakLive;
    this.sparks.count = sparkLive;
    this.streakMat.uniforms.uTime.value = time;
    this.sparkMat.uniforms.uTime.value = time;

    // Fade filaments aimed straight at the camera (they would read as dots).
    const screenWind = this.wind.x * cosYaw - this.wind.z * sinYaw;
    const viewFactor = dirLen < 0.03 ? 0.85 : 0.4 + 0.6 * Math.min(1, Math.abs(screenWind) / dirLen);
    const baseAlpha = (0.18 + strength * 0.5) * viewFactor;
    // Meander amplitude: gustier air curves harder.
    const meander = 0.45 + strength * 0.5;

    for (let i = 0; i < streakLive; i += 1) {
      const hx = i * 3;
      const seed = this.streakSeeds[i];
      // Local flow direction bends with a slow spatial sine: neighbouring
      // streaks roll onto slightly different headings, tracing S-curves.
      const bend =
        Math.sin(this.streakHeads[hx] * 0.9 + this.streakHeads[hx + 2] * 0.7 + time * 0.35 + seed * 6.28) *
        meander;
      const cosB = Math.cos(bend);
      const sinB = Math.sin(bend);
      const flowX = dirX * cosB - dirZ * sinB;
      const flowZ = dirX * sinB + dirZ * cosB;
      const flowY = Math.sin(time * 0.45 + seed * 12.6 + this.streakHeads[hx] * 0.8) * 0.12;
      this.streakHeads[hx] += flowX * speed * dt;
      this.streakHeads[hx + 1] += flowY * speed * dt;
      this.streakHeads[hx + 2] += flowZ * speed * dt;
      // Wrap horizontally, steer vertically back into the volume.
      if (this.streakHeads[hx] < min.x) this.streakHeads[hx] += spanX;
      else if (this.streakHeads[hx] > max.x) this.streakHeads[hx] -= spanX;
      if (this.streakHeads[hx + 2] < min.z) this.streakHeads[hx + 2] += spanZ;
      else if (this.streakHeads[hx + 2] > max.z) this.streakHeads[hx + 2] -= spanZ;
      if (this.streakHeads[hx + 1] < min.y + 0.15) this.streakHeads[hx + 1] = min.y + 0.15;
      else if (this.streakHeads[hx + 1] > max.y - 0.12) this.streakHeads[hx + 1] = max.y - 0.12;
      const yaw = Math.atan2(this.cameraPos.x - this.streakHeads[hx], this.cameraPos.z - this.streakHeads[hx + 2]);
      const cosYaw = Math.cos(yaw), sinYaw = Math.sin(yaw);
      // Roll the filament onto the flow as seen by the camera.
      const roll = Math.atan2(flowY, flowX * cosYaw - flowZ * sinYaw);
      const length = (0.3 + strength * 1.05) * (0.55 + 0.9 * ((seed * 13.7) % 1));
      const width = 0.012 + strength * 0.012 + 0.006 * ((seed * 7.3) % 1);
      this.streakAlphas[i] = baseAlpha * (0.55 + 0.45 * ((seed * 3.1) % 1));
      this.streakCurves[i] = (length / width) * (0.1 + strength * 0.12);
      this.dummy.position.set(this.streakHeads[hx], this.streakHeads[hx + 1], this.streakHeads[hx + 2]);
      this.dummy.rotation.set(0, yaw, roll);
      this.dummy.scale.set(length, width, 1);
      this.dummy.updateMatrix();
      this.streaks.setMatrixAt(i, this.dummy.matrix);
    }
    this.streaks.instanceMatrix.needsUpdate = true;
    (this.streaks.geometry.getAttribute('aAlpha') as InstancedBufferAttribute).needsUpdate = true;
    (this.streaks.geometry.getAttribute('aCurve') as InstancedBufferAttribute).needsUpdate = true;

    // Sparkles ride the same field with tighter wrap and faster twinkle.
    const sparkAlpha = (0.12 + strength * 0.45) * viewFactor;
    for (let i = 0; i < sparkLive; i += 1) {
      const sx = i * 3;
      const seed = this.sparkSeeds[i];
      const bend =
        Math.sin(this.sparkPos[sx] * 1.1 + this.sparkPos[sx + 2] * 0.9 + time * 0.4 + seed * 6.28) *
        meander;
      const cosB = Math.cos(bend);
      const sinB = Math.sin(bend);
      this.sparkPos[sx] += (dirX * cosB - dirZ * sinB) * speed * 0.8 * dt;
      this.sparkPos[sx + 1] += Math.sin(time * 0.6 + seed * 9.4) * 0.05 * dt;
      this.sparkPos[sx + 2] += (dirX * sinB + dirZ * cosB) * speed * 0.8 * dt;
      if (this.sparkPos[sx] < min.x) this.sparkPos[sx] += spanX;
      else if (this.sparkPos[sx] > max.x) this.sparkPos[sx] -= spanX;
      if (this.sparkPos[sx + 2] < min.z) this.sparkPos[sx + 2] += spanZ;
      else if (this.sparkPos[sx + 2] > max.z) this.sparkPos[sx + 2] -= spanZ;
      if (this.sparkPos[sx + 1] < min.y + 0.1) this.sparkPos[sx + 1] = min.y + 0.1;
      else if (this.sparkPos[sx + 1] > max.y - 0.1) this.sparkPos[sx + 1] = max.y - 0.1;
      this.sparkAlphas[i] = sparkAlpha * (0.4 + 0.6 * ((seed * 5.7) % 1));
      this.dummy.position.set(this.sparkPos[sx], this.sparkPos[sx + 1], this.sparkPos[sx + 2]);
      const yaw = Math.atan2(this.cameraPos.x - this.sparkPos[sx], this.cameraPos.z - this.sparkPos[sx + 2]);
      // Seeds and leaves tumble as they ride the flow.
      const spin = time * (0.5 + seed * 1.4) + seed * 6.28;
      this.dummy.rotation.set(0, yaw, spin);
      this.dummy.scale.setScalar(0.012 + 0.014 * ((seed * 3.3) % 1));
      this.dummy.updateMatrix();
      this.sparks.setMatrixAt(i, this.dummy.matrix);
    }
    this.sparks.instanceMatrix.needsUpdate = true;
    (this.sparks.geometry.getAttribute('aAlpha') as InstancedBufferAttribute).needsUpdate = true;
  }

  private parkAll(mesh: InstancedMesh, count: number): void {
    this.dummy.position.set(0, -10, 0);
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.scale.setScalar(0.001);
    this.dummy.updateMatrix();
    for (let i = 0; i < count; i += 1) mesh.setMatrixAt(i, this.dummy.matrix);
    mesh.instanceMatrix.needsUpdate = true;
  }

  private seedField(
    minX: number,
    minY: number,
    minZ: number,
    spanX: number,
    spanY: number,
    spanZ: number,
  ): void {
    for (let i = 0; i < STREAK_FULL; i += 1) {
      const s = this.streakSeeds[i];
      this.streakHeads[i * 3] = minX + ((s * 3) % 1) * spanX;
      this.streakHeads[i * 3 + 1] = minY + spanY * (0.2 + 0.6 * ((s * 7) % 1));
      this.streakHeads[i * 3 + 2] = minZ + ((s * 13) % 1) * spanZ;
    }
    for (let i = 0; i < SPARK_FULL; i += 1) {
      const s = this.sparkSeeds[i];
      this.sparkPos[i * 3] = minX + ((s * 5) % 1) * spanX;
      this.sparkPos[i * 3 + 1] = minY + spanY * (0.15 + 0.7 * ((s * 11) % 1));
      this.sparkPos[i * 3 + 2] = minZ + ((s * 17) % 1) * spanZ;
    }
  }

  override destroy(): void {
    super.destroy();
    this.streakHeads.fill(0);
    this.streakAlphas.fill(0);
    this.sparkPos.fill(0);
    this.sparkAlphas.fill(0);
    this.seeded = false;
  }
}
