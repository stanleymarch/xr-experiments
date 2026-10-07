/**
 * Rain: CPU-simulated THREE.Points streaks (max 2400 full / 1200 reduced)
 * filling the RoomModel bounds, plus a 48-instance splash ring field.
 * Density <- drivers.rain, fall speed 4+8*rain m/s, tilt <- shared wind.
 * All buffers preallocated; per-frame work touches only live particles.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  createSystem,
  DoubleSide,
  InstancedMesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  Points,
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

const RAIN_VERTEX = /* glsl */ `
attribute float aAlpha;
varying float vAlpha;
void main() {
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = 130.0 / max(0.1, -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;
const RAIN_FRAGMENT = /* glsl */ `
varying float vAlpha;
void main() {
  vec2 uv = gl_PointCoord - vec2(0.5, 0.5);
  float d = length(vec2(uv.x * 3.2, uv.y));
  float a = (1.0 - smoothstep(0.08, 0.5, d)) * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(0.4, 0.65, 1.0, a * 0.8);
}
`;

export class RainSystem extends createSystem({}) {
  private entity!: Entity;
  private splashEntity!: Entity;
  private geometry!: BufferGeometry;
  private points!: Points;
  private positions = new Float32Array(MAX_FULL * 3);
  private alphas = new Float32Array(MAX_FULL);
  private speeds = new Float32Array(MAX_FULL);
  private cursor = 0;
  private splashMesh!: InstancedMesh;
  private splashPos = new Float32Array(SPLASH_COUNT * 3);
  private splashAge = new Float32Array(SPLASH_COUNT);
  private splashCursor = 0;
  private readonly dummy = new Object3D();
  private readonly wind = new Vector3();
  private profile!: ReadonlySignal<CapabilityProfile>;

  init(): void {
    this.profile = capabilityProfile(this.world);
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('aAlpha', new BufferAttribute(this.alphas, 1));
    this.geometry.setDrawRange(0, 0);
    const material = new ShaderMaterial({
      vertexShader: RAIN_VERTEX,
      fragmentShader: RAIN_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.points = new Points(this.geometry, material);
    this.points.frustumCulled = false;
    this.entity = this.world.createTransformEntity(this.points);

    const splashGeo = new RingGeometry(0.032, 0.06, 24);
    const splashMat = new MeshBasicMaterial({
      color: 0x8cb0e6,
      opacity: 0.7,
      transparent: true,
      side: DoubleSide,
      depthWrite: false,
    });
    this.splashMesh = new InstancedMesh(splashGeo, splashMat, SPLASH_COUNT);
    this.splashMesh.frustumCulled = false;
    this.splashAge.fill(Number.POSITIVE_INFINITY);
    this.dummy.rotation.x = -Math.PI / 2;
    for (let i = 0; i < SPLASH_COUNT; i += 1) {
      this.dummy.position.set(0, -10, 0);
      this.dummy.scale.setScalar(0.001);
      this.dummy.updateMatrix();
      this.splashMesh.setMatrixAt(i, this.dummy.matrix);
    }
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
      this.geometry.setDrawRange(0, 0);
      this.points.visible = false;
      this.updateSplashes(dt);
      return;
    }
    this.points.visible = true;
    const { drivers, frame } = current;
    const live = Math.floor(drivers.rain * budget);
    windVectorFromFrame(frame, 0.35, this.wind);
    const { min, max } = roomModel;
    const spanX = Math.max(0.5, max.x - min.x);
    const spanZ = Math.max(0.5, max.z - min.z);
    const height = Math.max(0.5, max.y - min.y);
    const floorY = min.y;
    const fallBase = FALL_BASE_SPEED + 8 * drivers.rain;

    // Seed newly-visible particles at the top (deterministic hash from the
    // cursor keeps the hot loop allocation-free and Math.random-free).
    for (let i = 0; i < live; i += 1) {
      const ix = i * 3;
      if (this.alphas[i] <= 0) {
        this.cursor += 1;
        const seed = ((this.cursor * 2654435761) % 1000) / 1000;
        this.positions[ix] = min.x + seed * spanX;
        this.positions[ix + 1] = min.y + height * (0.5 + 0.5 * ((seed * 7) % 1));
        this.positions[ix + 2] = min.z + ((seed * 13) % 1) * spanZ;
        this.speeds[i] = fallBase * (0.85 + 0.3 * ((seed * 29) % 1));
        this.alphas[i] = 0.35 + 0.65 * drivers.rain;
      }
    }
    // Simulate drops and recycle each one at the first surface it crosses.
    for (let i = 0; i < live; i += 1) {
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
        this.alphas[i] = 0;
        this.positions[ix + 1] = max.y;
      } else if (this.positions[ix + 1] <= floorY + 0.02) {
        this.spawnSplash(this.positions[ix], this.positions[ix + 2], floorY);
        this.alphas[i] = 0;
        this.positions[ix + 1] = max.y;
      }
    }
    this.geometry.setDrawRange(0, live);
    (this.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('aAlpha') as BufferAttribute).needsUpdate = true;

    this.updateSplashes(dt);
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
        this.dummy.scale.setScalar(0.001);
        this.dummy.updateMatrix();
        this.splashMesh.setMatrixAt(s, this.dummy.matrix);
        this.splashAge[s] = Number.POSITIVE_INFINITY;
        splashDirty = true;
        continue;
      }
      this.splashAge[s] = nextAge;
      const t = nextAge / SPLASH_FADE_S;
      this.dummy.position.set(this.splashPos[si], this.splashPos[si + 1], this.splashPos[si + 2]);
      this.dummy.scale.setScalar(0.5 + t * 1.9);
      this.dummy.updateMatrix();
      this.splashMesh.setMatrixAt(s, this.dummy.matrix);
      splashDirty = true;
    }
    if (splashDirty) this.splashMesh.instanceMatrix.needsUpdate = true;
  }

  private spawnSplash(x: number, z: number, y: number): void {
    const s = this.splashCursor;
    this.splashCursor = (this.splashCursor + 1) % SPLASH_COUNT;
    const si = s * 3;
    this.splashPos[si] = x;
    this.splashPos[si + 1] = y + 0.01;
    this.splashPos[si + 2] = z;
    this.splashAge[s] = 0;
  }
  override destroy(): void {
    super.destroy();
    this.positions.fill(0);
    this.alphas.fill(0);
    this.speeds.fill(0);
    this.splashPos.fill(0);
    this.splashAge.fill(Number.POSITIVE_INFINITY);
    this.cursor = 0;
    this.splashCursor = 0;
  }
}
