/**
 * Rain: CPU-simulated instanced streak quads (max 2400 full / 1200 reduced)
 * filling the RoomModel bounds, plus a 48-instance splash ring field.
 * Density <- drivers.rain, fall speed 4+8*rain m/s, tilt <- shared wind.
 * Instanced quads replace point sprites: point sprites render as solid
 * squares on some mobile/Quest GPUs. All buffers preallocated; per-frame
 * work touches only live particles.
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
  RingGeometry,
  ShaderMaterial,
  Vector3,
} from '@iwsdk/core';
import type { Entity, ReadonlySignal } from '@iwsdk/core';
import { capabilityProfile } from '../capabilities.js';
import type { CapabilityProfile } from '../capabilities.js';
import { roomModel } from '../room.js';
import { weatherStore } from '../weather-state.js';
import { windVectorFromFrame } from '../wind-shared.js';

const MAX_FULL = 2400;
const MAX_REDUCED = 1200;
const SPLASH_COUNT = 48;
const SPLASH_FADE_S = 0.4;
const FALL_BASE_SPEED = 4;
const STREAK_WIDTH = 0.0075;
const STREAK_BASE_LEN = 0.45;

const RAIN_VERTEX = /* glsl */ `
attribute float aAlpha;
varying float vAlpha;
varying vec2 vUv;
void main() {
  vAlpha = aAlpha;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;
const RAIN_FRAGMENT = /* glsl */ `
varying float vAlpha;
varying vec2 vUv;
void main() {
  // Thread-like filament: gaussian core + faint halo, lit head at the
  // leading (bottom) end dissolving into a soft tail. Reads as a thin
  // streak of light from every angle, never a box.
  float x = (vUv.x - 0.5) * 2.0;
  float core = exp(-x * x * 16.0);
  float halo = exp(-x * x * 3.5) * 0.3;
  float head = 0.45 + 0.85 * exp(-pow((vUv.y - 0.1) * 3.0, 2.0));
  float tail = smoothstep(0.0, 0.05, vUv.y) * (1.0 - smoothstep(0.4, 1.0, vUv.y) * 0.7);
  float a = (core + halo) * head * tail * vAlpha;
  if (a < 0.01) discard;
  vec3 col = mix(vec3(0.5, 0.66, 0.92), vec3(0.85, 0.92, 1.0), core);
  gl_FragColor = vec4(col, a * 0.5);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const SPLASH_VERTEX = /* glsl */ `
attribute float aFade;
varying float vFade;
varying vec2 vUv;
void main() {
  vFade = aFade;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;
const SPLASH_FRAGMENT = /* glsl */ `
varying float vFade;
varying vec2 vUv;
void main() {
  // Soft expanding crown ring + brief central glint (RingGeometry uvs are
  // planar across the bounding square, so radial distance is exact).
  float d = length(vUv - vec2(0.5)) * 2.0;
  float ring = exp(-pow((d - 0.72) * 7.0, 2.0));
  float glint = exp(-d * d * 9.0) * 0.3;
  float a = (ring + glint) * vFade;
  if (a < 0.01) discard;
  gl_FragColor = vec4(0.62, 0.78, 1.0, a * 0.65);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class RainSystem extends createSystem({}) {
  private entity!: Entity;
  private splashEntity!: Entity;
  private streaks!: InstancedMesh;
  private positions = new Float32Array(MAX_FULL * 3);
  private alphas = new Float32Array(MAX_FULL);
  private lengths = new Float32Array(MAX_FULL);
  private speeds = new Float32Array(MAX_FULL);
  private cursor = 0;
  private splashMesh!: InstancedMesh;
  private splashPos = new Float32Array(SPLASH_COUNT * 3);
  private splashAge = new Float32Array(SPLASH_COUNT);
  private splashFade = new Float32Array(SPLASH_COUNT);
  private splashCursor = 0;
  private readonly dummy = new Object3D();
  private readonly wind = new Vector3();
  private readonly cameraPos = new Vector3();
  private profile!: ReadonlySignal<CapabilityProfile>;

  init(): void {
    this.profile = capabilityProfile(this.world);

    // Streak field: thin quads stretched along the fall+wind velocity.
    const geo = new PlaneGeometry(STREAK_WIDTH, 1);
    geo.translate(0, -0.5, 0); // pivot at the streak head (bottom).
    const material = new ShaderMaterial({
      vertexShader: RAIN_VERTEX,
      fragmentShader: RAIN_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
    });
    this.streaks = new InstancedMesh(geo, material, MAX_FULL);
    this.streaks.frustumCulled = false;
    this.streaks.instanceMatrix.setUsage(DynamicDrawUsage);
    const alphaAttr = new InstancedBufferAttribute(this.alphas, 1);
    alphaAttr.setUsage(DynamicDrawUsage);
    geo.setAttribute('aAlpha', alphaAttr);
    this.dummy.position.set(0, -10, 0);
    this.dummy.scale.set(1, 0.001, 1);
    this.dummy.updateMatrix();
    for (let i = 0; i < MAX_FULL; i += 1) this.streaks.setMatrixAt(i, this.dummy.matrix);
    this.streaks.instanceMatrix.needsUpdate = true;
    this.streaks.count = 0;
    this.entity = this.world.createTransformEntity(this.streaks);

    const splashGeo = new RingGeometry(0.032, 0.06, 24);
    const fadeAttr = new InstancedBufferAttribute(this.splashFade, 1);
    fadeAttr.setUsage(DynamicDrawUsage);
    splashGeo.setAttribute('aFade', fadeAttr);
    const splashMat = new ShaderMaterial({
      vertexShader: SPLASH_VERTEX,
      fragmentShader: SPLASH_FRAGMENT,
      transparent: true,
      side: DoubleSide,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.splashMesh = new InstancedMesh(splashGeo, splashMat, SPLASH_COUNT);
    this.splashMesh.frustumCulled = false;
    this.splashAge.fill(Number.POSITIVE_INFINITY);
    this.dummy.rotation.set(-Math.PI / 2, 0, 0);
    this.dummy.position.set(0, -10, 0);
    this.dummy.scale.setScalar(0.001);
    this.dummy.updateMatrix();
    for (let i = 0; i < SPLASH_COUNT; i += 1) this.splashMesh.setMatrixAt(i, this.dummy.matrix);
    this.splashMesh.instanceMatrix.needsUpdate = true;
    this.splashEntity = this.world.createTransformEntity(this.splashMesh);
    this.cleanupFuncs.push(() => {
      this.entity.dispose();
      this.splashEntity.dispose();
    });
  }

  update(delta: number): void {
    const current = weatherStore.current();
    const budget = this.profile.peek().particleBudget === 'full' ? MAX_FULL : MAX_REDUCED;
    const dt = Math.min(delta, 0.05);
    if (current == null || current.drivers.rain <= 0.01) {
      this.streaks.count = 0;
      this.updateSplashes(dt);
      return;
    }
    const { drivers, frame } = current;
    const live = Math.floor(drivers.rain * budget);
    this.streaks.count = live;
    windVectorFromFrame(frame, 0.35, this.wind);
    this.wind.multiplyScalar(1 + Math.max(0, drivers.gust - drivers.wind) * 0.8);
    const { min, max } = roomModel;
    const spanX = Math.max(0.5, max.x - min.x);
    const spanZ = Math.max(0.5, max.z - min.z);
    const height = Math.max(0.5, max.y - min.y);
    const floorY = min.y;
    const fallBase = FALL_BASE_SPEED + 8 * drivers.rain;
    this.world.camera.getWorldPosition(this.cameraPos);

    // Seed newly-visible particles at the top (deterministic hash from the
    // cursor keeps the hot loop allocation-free and Math.random-free).
    for (let i = 0; i < live; i += 1) {
      if (this.alphas[i] <= 0) {
        this.cursor += 1;
        const seed = ((this.cursor * 2654435761) % 1000) / 1000;
        const ix = i * 3;
        this.positions[ix] = min.x + seed * spanX;
        this.positions[ix + 1] = min.y + height * (0.5 + 0.5 * ((seed * 7) % 1));
        this.positions[ix + 2] = min.z + ((seed * 13) % 1) * spanZ;
        this.speeds[i] = fallBase * (0.85 + 0.3 * ((seed * 29) % 1));
        this.lengths[i] = STREAK_BASE_LEN * (0.7 + 0.6 * drivers.rain + 0.2 * ((seed * 31) % 1));
        this.alphas[i] = 0.3 + 0.7 * drivers.rain;
      }
    }
    // Simulate drops: recycle each one at the first surface it crosses.
    const toCamYaw = Math.atan2(
      this.cameraPos.x - (min.x + spanX / 2),
      this.cameraPos.z - (min.z + spanZ / 2),
    );
    const cosYaw = Math.cos(toCamYaw);
    const sinYaw = Math.sin(toCamYaw);
    // Wind tilt expressed in each streak's camera-facing plane.
    const tiltTan = Math.min(
      1.2,
      Math.abs((this.wind.x * cosYaw - this.wind.z * sinYaw) / Math.max(1, FALL_BASE_SPEED)),
    );
    const tiltZ = -Math.sign(this.wind.x * cosYaw - this.wind.z * sinYaw || 1) * Math.atan(tiltTan);
    for (let i = 0; i < live; i += 1) {
      if (this.alphas[i] <= 0) continue;
      const ix = i * 3;
      const previousY = this.positions[ix + 1];
      this.positions[ix] += this.wind.x * dt;
      this.positions[ix + 2] += this.wind.z * dt;
      this.positions[ix + 1] -= this.speeds[i] * dt;
      // Wrap horizontally inside the volume.
      if (this.positions[ix] < min.x) this.positions[ix] += spanX;
      else if (this.positions[ix] > max.x) this.positions[ix] -= spanX;
      if (this.positions[ix + 2] < min.z) this.positions[ix + 2] += spanZ;
      else if (this.positions[ix + 2] > max.z) this.positions[ix + 2] -= spanZ;
      const surfaceY = roomModel.surfaceHeightAt(this.positions[ix], this.positions[ix + 2], previousY);
      if (surfaceY != null && this.positions[ix + 1] <= surfaceY) {
        this.spawnSplash(this.positions[ix], this.positions[ix + 2], surfaceY);
        this.recycle(i, min, height);
      } else if (this.positions[ix + 1] <= floorY + 0.02) {
        this.spawnSplash(this.positions[ix], this.positions[ix + 2], floorY);
        this.recycle(i, min, height);
      }
      // Cylindrical billboard toward the camera, tilted into the wind.
      this.dummy.position.set(this.positions[ix], this.positions[ix + 1], this.positions[ix + 2]);
      this.dummy.rotation.set(0, toCamYaw, tiltZ);
      this.dummy.scale.set(1, this.lengths[i], 1);
      this.dummy.updateMatrix();
      this.streaks.setMatrixAt(i, this.dummy.matrix);
    }
    this.streaks.instanceMatrix.needsUpdate = true;
    (this.streaks.geometry.getAttribute('aAlpha') as InstancedBufferAttribute).needsUpdate = true;

    this.updateSplashes(dt);
  }

  /** Re-seed particle i near the top of the volume. */
  private recycle(i: number, min: Vector3, height: number): void {
    this.cursor += 1;
    const seed = ((this.cursor * 2654435761) % 1000) / 1000;
    const ix = i * 3;
    const spanX = Math.max(0.5, roomModel.max.x - min.x);
    const spanZ = Math.max(0.5, roomModel.max.z - min.z);
    this.positions[ix] = min.x + seed * spanX;
    this.positions[ix + 1] = min.y + height * (0.75 + 0.25 * ((seed * 3) % 1));
    this.positions[ix + 2] = min.z + ((seed * 17) % 1) * spanZ;
  }

  private updateSplashes(dt: number): void {
    let splashDirty = false;
    for (let s = 0; s < SPLASH_COUNT; s += 1) {
      const age = this.splashAge[s];
      if (!Number.isFinite(age)) continue;
      const nextAge = age + dt;
      const si = s * 3;
      if (nextAge >= SPLASH_FADE_S) {
        // Expired: park the instance out of sight until reused.
        this.dummy.position.set(0, -10, 0);
        this.dummy.rotation.set(-Math.PI / 2, 0, 0);
        this.dummy.scale.setScalar(0.001);
        this.dummy.updateMatrix();
        this.splashMesh.setMatrixAt(s, this.dummy.matrix);
        this.splashAge[s] = Number.POSITIVE_INFINITY;
        this.splashFade[s] = 0;
        splashDirty = true;
        continue;
      }
      this.splashAge[s] = nextAge;
      const t = nextAge / SPLASH_FADE_S;
      this.splashFade[s] = (1 - t) * (1 - t);
      this.dummy.position.set(this.splashPos[si], this.splashPos[si + 1], this.splashPos[si + 2]);
      this.dummy.rotation.set(-Math.PI / 2, 0, 0);
      this.dummy.scale.setScalar(0.5 + t * 1.9);
      this.dummy.updateMatrix();
      this.splashMesh.setMatrixAt(s, this.dummy.matrix);
      splashDirty = true;
    }
    if (splashDirty) {
      this.splashMesh.instanceMatrix.needsUpdate = true;
      (this.splashMesh.geometry.getAttribute('aFade') as InstancedBufferAttribute).needsUpdate = true;
    }
  }

  private spawnSplash(x: number, z: number, y: number): void {
    const s = this.splashCursor;
    this.splashCursor = (this.splashCursor + 1) % SPLASH_COUNT;
    const si = s * 3;
    this.splashPos[si] = x;
    this.splashPos[si + 1] = y + 0.01;
    this.splashPos[si + 2] = z;
    this.splashAge[s] = 0;
    this.splashFade[s] = 1;
  }

  override destroy(): void {
    super.destroy();
    this.positions.fill(0);
    this.alphas.fill(0);
    this.speeds.fill(0);
    this.splashPos.fill(0);
    this.splashAge.fill(Number.POSITIVE_INFINITY);
    this.splashFade.fill(0);
    this.cursor = 0;
    this.splashCursor = 0;
  }
}
