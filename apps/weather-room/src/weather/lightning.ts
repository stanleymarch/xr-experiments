/**
 * WEATHER//ROOM room-scale lightning discharge: one preallocated branched
 * ribbon bolt (main channel + two branches) that answers the shared Thunder
 * moment inside the room volume — never above the real ceiling, never a
 * fullscreen strobe.
 *
 * Why a carrier, not just the cloud flash: coherent illumination across
 * virtual materials matters more than an isolated spark, but without a
 * visible discharge the flash has no source and reads as a UI blink. The
 * bolt is the source; the fog/light/cloud lift (AtmosphereSystem) and the
 * rain/wind tint are its response, all driven by the single shared
 * `lightningUniforms` envelope so layers can never disagree.
 *
 * Budget: fixed topology (25-point main + 2 x 7-point branches), one
 * BufferGeometry, one AdditiveBlending ShaderMaterial in the room's pale
 * electric tint — no neon cyan, no laser white. Positions regenerate per
 * strike from a deterministic hash (no Math.random, per app convention);
 * per-frame work is only the billboard yaw and the envelope read. Hidden
 * (`visible = false`) below the envelope floor so it costs nothing at rest.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DepthOccludable,
  DoubleSide,
  DynamicDrawUsage,
  Mesh,
  ShaderMaterial,
  Vector3,
} from '@iwsdk/core';
import type { Entity, World } from '@iwsdk/core';
import { enableDepthOcclusion } from './depth-occlusion.js';
import { enableLightning, lightningFlashLevel } from './light-shared.js';

/** Main-channel centerline points; branches fork from its middle third. */
const MAIN_POINTS = 25;
const BRANCH_POINTS = 7;
const BRANCHES = 2;
const STRIP_POINTS = MAIN_POINTS + BRANCHES * BRANCH_POINTS;
const VERTS = STRIP_POINTS * 2;
/** Envelope floor below which the bolt parks invisible. */
const VISIBILITY_FLOOR = 0.015;
/** Main-channel half-width at the crown, meters; tapers toward the floor. */
const CROWN_HALF_WIDTH = 0.016;
/** Branch half-width: thinner than the channel they fork from. */
const BRANCH_HALF_WIDTH = 0.008;

const BOLT_VERTEX = /* glsl */ `
attribute float aEdge;
attribute float aFade;
varying float vEdge;
varying float vFade;
void main() {
  vEdge = aEdge;
  vFade = aFade;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const BOLT_FRAGMENT = /* glsl */ `
varying float vEdge;
varying float vFade;
void main() {
  // Soft luminous core across the ribbon: gaussian, never a hard bar.
  float core = exp(-vEdge * vEdge * 5.0);
  float a = core * vFade * uWrFlash;
  if (a < 0.01) discard;
  // Hot near-white heart only at the onset peak; the decay breathes toward
  // the pale electric tint instead of holding white.
  float heart = clamp(uWrFlash - 0.55, 0.0, 1.0);
  vec3 col = mix(uWrFlashTint, vec3(0.96, 0.97, 1.0), heart * core);
  gl_FragColor = vec4(col, min(a, 0.85));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Deterministic 0..1 hash; the app avoids Math.random everywhere. */
function hash(seed: number): number {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return value - Math.floor(value);
}

export class LightningBolt {
  private readonly mesh: Mesh;
  private readonly geometry: BufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly boltEntity: Entity;
  private readonly positions = new Float32Array(VERTS * 3);
  private readonly fades = new Float32Array(VERTS);
  private readonly dummy = new Vector3();
  private strikes = 0;

  constructor(world: World) {
    const geometry = new BufferGeometry();
    const positionAttr = new BufferAttribute(this.positions, 3);
    positionAttr.setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', positionAttr);
    const edges = new Float32Array(VERTS);
    for (let i = 0; i < STRIP_POINTS; i += 1) {
      edges[i * 2] = -1;
      edges[i * 2 + 1] = 1;
    }
    geometry.setAttribute('aEdge', new BufferAttribute(edges, 1));
    const fadeAttr = new BufferAttribute(this.fades, 1);
    fadeAttr.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aFade', fadeAttr);
    // Independent triangle-list quads share one mesh and draw call.
    const index: number[] = [];
    const runs: Array<[number, number]> = [
      [0, MAIN_POINTS],
      [MAIN_POINTS, BRANCH_POINTS],
      [MAIN_POINTS + BRANCH_POINTS, BRANCH_POINTS],
    ];
    for (const [start, count] of runs) {
      for (let i = 0; i < count - 1; i += 1) {
        const a = (start + i) * 2;
        const b = (start + i + 1) * 2;
        index.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    geometry.setIndex(index);
    const material = new ShaderMaterial({
      vertexShader: BOLT_VERTEX,
      fragmentShader: BOLT_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
    });
    // Real furniture cuts the discharge; the strike envelope tints it.
    enableDepthOcclusion(material);
    enableLightning(material);
    this.mesh = new Mesh(geometry, material);
    this.geometry = geometry;
    this.material = material;
    this.mesh.name = 'Weather Lightning Discharge';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.visible = false;
    this.mesh.raycast = () => {};
    this.boltEntity = world.createTransformEntity(this.mesh);
    this.boltEntity.addComponent(DepthOccludable, {});
  }

  /**
   * Regenerate the discharge inside the room: crown hangs below the ceiling
   * (never above it), the channel walks to near the floor with fractal offsets,
   * branches fork outward-down from the middle third. All clamped inside the
   * room footprint inset, so the bolt stays in view from the default viewpoint.
   */
  strike(
    centerX: number,
    topY: number,
    centerZ: number,
    floorY: number,
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
  ): void {
    this.strikes += 1;
    const seed = this.strikes * 17.31 + topY * 3.7 + centerX;
    const drop = Math.max(0.8, topY - floorY - 0.25);
    const clampX = (x: number): number => Math.min(maxX - 0.25, Math.max(minX + 0.25, x));
    const clampZ = (z: number): number => Math.min(maxZ - 0.25, Math.max(minZ + 0.25, z));
    const crownX = clampX(centerX + (hash(seed) - 0.5) * 0.9);
    const crownZ = clampZ(centerZ + (hash(seed + 1) - 0.5) * 0.9);
    const footX = clampX(crownX + (hash(seed + 2) - 0.5) * 1.4);
    const footZ = clampZ(crownZ + (hash(seed + 3) - 0.5) * 1.4);
    const mainX = new Float32Array(MAIN_POINTS);
    const mainZ = new Float32Array(MAIN_POINTS);
    let spread = 0.34;
    // Linear crown→foot baseline first: the midpoint subdivision below only
    // visits a subset of indices, so every point starts on the line and the
    // loop adds fractal offsets onto real values, never zeros.
    for (let i = 0; i < MAIN_POINTS; i += 1) {
      const t = i / (MAIN_POINTS - 1);
      mainX[i] = crownX + (footX - crownX) * t;
      mainZ[i] = crownZ + (footZ - crownZ) * t;
    }
    let step = MAIN_POINTS - 1;
    let level = 0;
    while (step > 1) {
      const half = step >> 1;
      for (let i = half; i < MAIN_POINTS - 1; i += step) {
        const s = seed + level * 11.7 + i * 1.31;
        mainX[i] = (mainX[i - half] + mainX[i + half]) / 2 + (hash(s) - 0.5) * 2 * spread;
        mainZ[i] = (mainZ[i - half] + mainZ[i + half]) / 2 + (hash(s + 40) - 0.5) * 2 * spread;
      }
      step = half;
      spread *= 0.55;
      level += 1;
    }
    // Local frame: crown at the origin, channel falling along -Y; the mesh
    // position anchors the crown, so the whole bolt yaw-billboards as one.
    this.mesh.position.set(crownX, topY, crownZ);
    this.mesh.rotation.set(0, 0, 0);
    this.mesh.scale.setScalar(1);
    for (let i = 0; i < MAIN_POINTS; i += 1) {
      const t = i / (MAIN_POINTS - 1);
      const y = -t * drop;
      const half = CROWN_HALF_WIDTH * (1 - t * 0.55);
      const fade = Math.min(1, (1 - t) * 3) * Math.min(1, t * 8 + 0.35);
      this.setRibbonVert(i, mainX[i] - crownX, y, mainZ[i] - crownZ, half, fade);
    }
    // Branches fork from the middle third, running outward and down.
    const forks = [Math.floor(MAIN_POINTS * 0.38), Math.floor(MAIN_POINTS * 0.58)];
    for (let b = 0; b < BRANCHES; b += 1) {
      const fork = forks[b];
      const ft = fork / (MAIN_POINTS - 1);
      const dirS = seed + 90 + b * 31;
      const dirX = hash(dirS) - 0.5;
      const dirZ = hash(dirS + 7) - 0.5;
      const len = 0.35 + hash(dirS + 13) * 0.4;
      for (let i = 0; i < BRANCH_POINTS; i += 1) {
        const t = i / (BRANCH_POINTS - 1);
        const s = dirS + i * 3.3;
        const x = mainX[fork] - crownX + dirX * len * t + (hash(s) - 0.5) * 0.12 * t;
        const y = -ft * drop - t * len * 0.8;
        const z = mainZ[fork] - crownZ + dirZ * len * t + (hash(s + 21) - 0.5) * 0.12 * t;
        const fade = (1 - t) * 0.8;
        this.setRibbonVert(MAIN_POINTS + b * BRANCH_POINTS + i, x, y, z, BRANCH_HALF_WIDTH, fade);
      }
    }
    this.mesh.geometry.getAttribute('position').needsUpdate = true;
    (this.mesh.geometry.getAttribute('aFade') as BufferAttribute).needsUpdate = true;
  }

  /** Yaw-billboard toward the viewer; hide below the envelope floor. */
  update(cameraX: number, cameraZ: number): void {
    const flash = lightningFlashLevel();
    if (flash < VISIBILITY_FLOOR) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    this.dummy.set(cameraX - this.mesh.position.x, 0, cameraZ - this.mesh.position.z);
    if (this.dummy.lengthSq() > 1e-8) {
      this.mesh.rotation.y = Math.atan2(this.dummy.x, this.dummy.z);
    }
  }

  private setRibbonVert(
    point: number,
    x: number,
    y: number,
    z: number,
    half: number,
    fade: number,
  ): void {
    const o = point * 6;
    this.positions[o] = x - half;
    this.positions[o + 1] = y;
    this.positions[o + 2] = z;
    this.positions[o + 3] = x + half;
    this.positions[o + 4] = y;
    this.positions[o + 5] = z;
    this.fades[point * 2] = fade;
    this.fades[point * 2 + 1] = fade;
  }

  /** Release the entity, geometry and material (system teardown). */
  dispose(): void {
    this.mesh.visible = false;
    this.boltEntity.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
