/**
 * Rain: CPU-simulated instanced streak quads (max 2400 full / 1200 reduced)
 * filling the RoomModel bounds, plus a 48-instance splash ring field.
 * Density <- drivers.rain, fall speed 4+8*rain m/s, tilt <- shared wind.
 * Instanced quads replace point sprites: point sprites render as solid
 * squares on some mobile/Quest GPUs. All buffers preallocated; per-frame
 * work touches only live particles.
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
  RingGeometry,
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

const MAX_FULL = 3200;
const MAX_REDUCED = 1200;
const SPLASH_COUNT = 48;
const SPLASH_FADE_S = 0.6;
const FALL_BASE_SPEED = 4;
/** World width of one streak. Wide enough to be macroscopic: at this size the
 * projectile reads as a real object whose apparent thickness grows with
 * proximity, instead of a sub-pixel hairline that aliases to the same 1 px at
 * every depth. */
const STREAK_WIDTH = 0.012;
const STREAK_BASE_LEN = 0.3;

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
  // Thread-like filament: three core samples offset across the width, weighted
  // R/G/B, give the drop a chromatic fringe (dispersion) instead of a flat
  // white bar. Halo and head/tail shape stay as before.
  float x = (vUv.x - 0.5) * 2.0;
  float w = 0.16;
  float cr = exp(-(x - w) * (x - w) * 9.0);
  float cg = exp(-x * x * 9.0);
  float cb = exp(-(x + w) * (x + w) * 9.0);
  float core = (cr + cg + cb) * 0.3333;
  float halo = exp(-x * x * 3.0) * 0.32;
  float head = 0.45 + 0.85 * exp(-pow((vUv.y - 0.1) * 3.0, 2.0));
  // Contact must read: the tip stays lit to the surface (a hairline fade
  // here is what made drops look like they stop above the floor).
  float tail = smoothstep(0.0, 0.02, vUv.y) * (1.0 - smoothstep(0.4, 1.0, vUv.y) * 0.7);
  // Crossing the light shaft brightens the drop; outside it the rain dims.
  float beam = rBeamFactor(vBeamWorld);
  float a = (core + halo) * head * tail * vAlpha;
  if (a < 0.01) discard;
  // Steel-blue/teal water, not white: saturated core survives ACES tone
  // mapping instead of washing to pale gray. The halo keeps the drop's
  // edge dark enough to read against a lit room (a light halo vanished on
  // pale walls).
  vec3 fringe = vec3(cr, cg, cb) / max(cr + cg + cb, 0.0001);
  vec3 col = mix(vec3(0.16, 0.42, 0.6), fringe, core * 0.6);
  col = mix(col, vec3(0.3, 0.55, 0.72), halo * 0.6);
  // Straight (non-premultiplied) alpha under NormalBlending: the old
  // col * a output double-multiplied (a^2 effective) and crushed saturated
  // mid-tones toward pale transparency. Beam scales the color only.
  gl_FragColor = vec4(col * beam, a);
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
  // Contact flash, not a flat decal ring: a six-ray angular comb radiated from
  // the impact point plus a short central glint, so the hit reads from any
  // viewing angle (RingGeometry uvs are planar across the bounding square).
  vec2 p = vUv - vec2(0.5);
  float d = length(p) * 2.0;
  float ang = atan(p.y, p.x);
  float comb = pow(0.5 + 0.5 * cos(ang * 6.0), 8.0);
  float radial = smoothstep(1.0, 0.25, d) * (1.0 - smoothstep(0.0, 0.14, d));
  float glint = exp(-d * d * 9.0) * 0.8;
  float a = (comb * radial + glint) * vFade;
  if (a < 0.01) discard;
  // Teal-steel contact mark, straight alpha: legible against pale fog without
  // going white. Representative contacts only (48-pool vs 2400 drops).
  float outA = a;
  // The beam helpers are injected but never pre-evaluated in this shader:
  // without this line beam is an undeclared identifier and the whole
  // program fails to compile (the rings then never draw).
  float beam = rBeamFactor(vBeamWorld);
  // A physical impact does not dim outside the light shaft: floor the beam
  // so contact rings stay legible across the whole room.
  gl_FragColor = vec4(vec3(0.35, 0.62, 0.8) * max(beam, 0.6), outA);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class RainSystem extends createSystem({}) {
  private entity!: Entity;
  private splashEntity!: Entity;
  private streaks!: InstancedMesh;
  private positions = new Float32Array(MAX_FULL * 3);
  /** Seed alpha: also the liveness marker for the simulation. */
  private alphas = new Float32Array(MAX_FULL);
  /** Per-frame render alpha = seed alpha x distance attenuation. */
  private readonly alphasOut = new Float32Array(MAX_FULL);
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
    // Contact invariant: positions[] is the streak HEAD (leading tip). The
    // geometry grows upward (+Y) by the per-instance length, so the contact
    // test below fires exactly when the visible tip reaches a mapped surface
    // (table) or the room floor. Never recycle pre-impact.
    const geo = new PlaneGeometry(STREAK_WIDTH, 1);
    geo.translate(0, 0.5, 0);
    const material = new ShaderMaterial({
      vertexShader: RAIN_VERTEX,
      fragmentShader: RAIN_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: NormalBlending,
    });
    // Shared beam first, then the depth test on top: both hooks append after
    // the shader's own gl_Position, so the streak keeps its instance-correct
    // occlusion and gains the shaft brightness.
    enableBeamLighting(material);
    // Streaks fall through the whole room volume, so they are the effect that
    // must disappear behind real furniture.
    enableDepthOcclusion(material);
    // Staged rollout flag: streaks part around a tracked hand (push + dim in
    // the vertex stage; see hand-field.ts). Splashes are surface decals and
    // stay pinned — a hand does not shove the floor.
    if (HAND_FIELD_LAYERS.rain) enableHandField(material);
    this.streaks = new InstancedMesh(geo, material, MAX_FULL);
    this.streaks.frustumCulled = false;
    this.streaks.instanceMatrix.setUsage(DynamicDrawUsage);
    const alphaAttr = new InstancedBufferAttribute(this.alphasOut, 1);
    alphaAttr.setUsage(DynamicDrawUsage);
    geo.setAttribute('aAlpha', alphaAttr);
    this.dummy.position.set(0, -10, 0);
    this.dummy.scale.set(1, 0.001, 1);
    this.dummy.updateMatrix();
    for (let i = 0; i < MAX_FULL; i += 1) this.streaks.setMatrixAt(i, this.dummy.matrix);
    this.streaks.instanceMatrix.needsUpdate = true;
    this.streaks.count = 0;
    this.streaks.name = 'Weather Rain Streaks';
    this.entity = this.world.createTransformEntity(this.streaks);
    // F5/F6 legibility: 9.5 cm outer ring (was 6 cm) reads against fog at 2 m
    // without going white; representative contacts only (48-pool, see below).
    const splashGeo = new RingGeometry(0.045, 0.095, 24);
    const fadeAttr = new InstancedBufferAttribute(this.splashFade, 1);
    fadeAttr.setUsage(DynamicDrawUsage);
    splashGeo.setAttribute('aFade', fadeAttr);
    const splashMat = new ShaderMaterial({
      vertexShader: SPLASH_VERTEX,
      fragmentShader: SPLASH_FRAGMENT,
      transparent: true,
      side: DoubleSide,
      depthWrite: false,
      // Decal compromise: the splash stays a surface mark (it keeps depthTest
      // and the module's 3 cm real-depth bias) instead of ignoring occlusion
      // outright. Rising the impact point 3 cm along the surface normal and
      // pulling the virtual depth forward with polygonOffset keeps the mark in
      // front of the surface it sits on, so it neither flickers against its
      // own sampled floor nor floats — while any real geometry that is
      // genuinely closer still cuts it.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      blending: NormalBlending,
    });
    enableBeamLighting(splashMat);
    enableDepthOcclusion(splashMat);
    this.splashMesh = new InstancedMesh(splashGeo, splashMat, SPLASH_COUNT);
    this.splashMesh.frustumCulled = false;
    this.splashAge.fill(Number.POSITIVE_INFINITY);
    this.dummy.rotation.set(-Math.PI / 2, 0, 0);
    this.dummy.position.set(0, -10, 0);
    this.dummy.scale.setScalar(0.001);
    this.dummy.updateMatrix();
    for (let i = 0; i < SPLASH_COUNT; i += 1) this.splashMesh.setMatrixAt(i, this.dummy.matrix);
    this.splashMesh.instanceMatrix.needsUpdate = true;
    this.splashMesh.name = 'Weather Rain Contacts';
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
    if (current == null || current.drivers.rain <= 0) {
      this.streaks.count = 0;
      this.updateSplashes(dt);
      return;
    }
    const { drivers, frame } = current;
    // Compress the display density range so genuine drizzle remains visible;
    // zero precipitation still produces zero drops. The 0.35 exponent lifts
    // drizzle out of "a handful of scratches" without flattening downpours.
    const live = Math.max(1, Math.floor(Math.pow(drivers.rain, 0.35) * budget));
    this.streaks.count = live;
    windVectorFromFrame(frame, 0.35, this.wind);
    this.wind.multiplyScalar(1 + Math.max(0, drivers.gust - drivers.wind) * 0.8);
    const { min, max } = roomModel;
    const spanX = Math.max(0.5, max.x - min.x);
    const spanZ = Math.max(0.5, max.z - min.z);
    const height = Math.max(0.5, max.y - min.y);
    const floorY = min.y;
    const fallBase = FALL_BASE_SPEED + 8 * drivers.rain;
    (this.xrManager.isPresenting ? this.world.player.head : this.world.camera).getWorldPosition(this.cameraPos);
    // The room's own FogExp2 is what the far rain must dissolve into, so the
    // attenuation reads as air rather than as a per-drop brightness rule.
    const fog = this.world.scene.fog as unknown as { density?: number } | null;
    const fogDensity = typeof fog?.density === 'number' ? fog.density : 0.006;

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
        this.alphas[i] = 0.72 + 0.28 * drivers.rain;
      }
    }
    // positions[] is the leading tip; local +Y is its trailing streak.
    // Test this tip against the surface, then recycle only on impact.
    for (let i = 0; i < live; i += 1) {
      if (this.alphas[i] <= 0) continue;
      const ix = i * 3;
      const previousY = this.positions[ix + 1];
      this.positions[ix] += this.wind.x * dt;
      this.positions[ix + 2] += this.wind.z * dt;
      this.positions[ix + 1] -= this.speeds[i] * dt;
      // Wrap horizontally inside the volume.
      this.positions[ix] = min.x + ((this.positions[ix] - min.x) % spanX + spanX) % spanX;
      this.positions[ix + 2] = min.z + ((this.positions[ix + 2] - min.z) % spanZ + spanZ) % spanZ;
      // surfaceHeightAt(x, z, previousY): highest mapped surface at/below the
      // pre-step tip. Mapped cell -> splash at that height; null (unmapped)
      // -> fall through to floorY + 0.02. Null is never faked into geometry.
      const surfaceY = roomModel.surfaceHeightAt(this.positions[ix], this.positions[ix + 2], previousY);
      if (surfaceY != null && this.positions[ix + 1] <= surfaceY) {
        this.spawnSplash(this.positions[ix], this.positions[ix + 2], surfaceY);
        this.recycle(i, min, height);
      } else if (this.positions[ix + 1] <= floorY + 0.02) {
        this.spawnSplash(this.positions[ix], this.positions[ix + 2], floorY);
        this.recycle(i, min, height);
      }
      // Contact anticipation input: distance left to this drop's stop
      // surface (mapped surface, or the floor when the cell is unmapped).
      const stopY = surfaceY ?? floorY + 0.02;
      const stopGap = stopY - this.positions[ix + 1];
      const toCamYaw = Math.atan2(
        this.cameraPos.x - this.positions[ix],
        this.cameraPos.z - this.positions[ix + 2],
      );
      const crossWind = this.wind.x * Math.cos(toCamYaw) - this.wind.z * Math.sin(toCamYaw);
      const tiltZ = -Math.atan(crossWind / Math.max(1, this.speeds[i]));
      // Physical depth cue: drop brightness falls off with camera distance
      // through the room's own fog, so near rain is bright and far rain fades
      // into the haze instead of reading as a flat screen overlay. Width and
      // length need no term here — the quads have a real world size, so their
      // apparent size already grows with proximity; the alpha is what was
      // missing for depth to read.
      const ddx = this.positions[ix] - this.cameraPos.x;
      const ddy = this.positions[ix + 1] - this.cameraPos.y;
      const ddz = this.positions[ix + 2] - this.cameraPos.z;
      const distance = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
      const atten = Math.max(
        0.42,
        Math.min(1.2, (1.2 / (1 + 0.3 * distance)) * Math.exp(-fogDensity * 4 * distance)),
      );
      // Contact anticipation: brighten the last 25 cm of fall so the eye
      // follows the drop onto the surface instead of losing it in the fog.
      this.alphasOut[i] =
        this.alphas[i] * atten * (stopGap < 0.25 ? 1 + (1 - Math.max(0, stopGap) / 0.25) * 0.6 : 1);
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
      this.dummy.scale.setScalar(0.7 + t * 1.3);
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
    this.splashPos[si + 1] = y + 0.03;
    this.splashPos[si + 2] = z;
    this.splashAge[s] = 0;
    this.splashFade[s] = 1;
  }

  override destroy(): void {
    super.destroy();
    this.positions.fill(0);
    this.alphas.fill(0);
    this.alphasOut.fill(0);
    this.speeds.fill(0);
    this.splashPos.fill(0);
    this.splashAge.fill(Number.POSITIVE_INFINITY);
    this.splashFade.fill(0);
    this.cursor = 0;
    this.splashCursor = 0;
  }
}
