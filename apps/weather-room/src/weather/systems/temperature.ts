/**
 * Temperature: three low haze strata spread through the air nearest the floor
 * plus one warm/cool PointLight. Warm (warmth > 0.55) -> warm haze and lamp
 * tint; Cold (warmth < 0.45) -> ice-blue haze; between -> neutral and faint.
 * Everything interpolates, no popping.
 *
 * The strata are spread through a capped band instead of stacking inside the
 * bottom 0.3 m of the column: three sheets at one height read as a single
 * cloud lying on the floor (the AR report), and an uncapped band would put the
 * top sheet through the viewer's eyes in a tall room. The footprint stays
 * inside the walls, and the material is depth-occluded like every other
 * weather layer, so furniture and walls cut the haze instead of being painted
 * over.
 *
 * The old 500-point mote field was removed: it duplicated the atmosphere dust
 * layer, read as visual noise, and could not say anything the haze does not.
 * The haze carries the same warmth information with far fewer pixels and the
 * warmth still flows continuously between the two extremes.
 */

import {
  Color,
  createSystem,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Object3D,
  PlaneGeometry,
  PointLightComponent,
  ShaderMaterial,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import { createCloudNoise } from '../cloud-noise.js';
import { enableDepthOcclusion } from '../depth-occlusion.js';
import { roomModel } from '../room.js';
import { weatherStore } from '../weather-state.js';

const HAZE_COUNT = 3;
const WARM_EDGE = 0.6;
const COLD_EDGE = 0.6;
/** Relative weight of each sheet; scaled together by the regime energy. */
const HAZE_BASE = [0.55, 0.75, 0.5];

const VERTEX = /* glsl */ `
attribute float aAlpha;
varying float vAlpha;
varying vec2 vUv;
void main() {
  vAlpha = aAlpha;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;
const FRAGMENT = /* glsl */ `
uniform sampler2D uNoise;
uniform vec3 uColor;
uniform float uTime;
varying float vAlpha;
varying vec2 vUv;
void main() {
  // Two fbm taps from the shared noise atlas, drifting slowly: a low sheet of
  // breathing haze instead of points pretending to be dust.
  vec2 p = vUv * 2.4 + vec2(uTime * 0.01, uTime * -0.006);
  float a = texture2D(uNoise, p).r;
  float b = texture2D(uNoise, p * 2.1 + 0.37).g;
  float fbm = a * 0.65 + b * 0.35;
  // Soften the sheet's own border so the quad never reads as a rectangle.
  float edge = smoothstep(0.0, 0.2, vUv.x) * (1.0 - smoothstep(0.8, 1.0, vUv.x));
  edge *= smoothstep(0.0, 0.2, vUv.y) * (1.0 - smoothstep(0.8, 1.0, vUv.y));
  float alpha = smoothstep(0.3, 0.86, fbm) * edge * vAlpha;
  if (alpha < 0.006) discard;
  gl_FragColor = vec4(uColor, alpha * 0.35);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const WARM_COLOR = new Color(1.0, 0.82, 0.6);
const NEUTRAL_COLOR = new Color(0.75, 0.8, 0.88);
const COLD_COLOR = new Color(0.55, 0.75, 1.0);

export class TemperatureSystem extends createSystem({}) {
  private entity!: Entity;
  private lampEntity!: Entity;
  private haze!: InstancedMesh;
  private material!: ShaderMaterial;
  private readonly alphas = new Float32Array(HAZE_COUNT);
  private readonly dummy = new Object3D();
  private readonly tint = new Color();
  private readonly lastBounds = new Float32Array(6);
  private currentWarmth = 0.5;
  private placed = false;

  init(): void {
    const noise = createCloudNoise();
    const geometry = new PlaneGeometry(1, 1);
    const alphaAttr = new InstancedBufferAttribute(this.alphas, 1);
    alphaAttr.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aAlpha', alphaAttr);
    this.material = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: { uNoise: { value: noise }, uColor: { value: this.tint }, uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      // Seen from both above and below as the viewer moves through it.
      side: DoubleSide,
    });
    // Walls, tall furniture and the real floor cut the haze like every other
    // weather layer; without this it was the one layer that drew straight
    // through real geometry (and the only survivor of a broken depth pass).
    enableDepthOcclusion(this.material);
    this.haze = new InstancedMesh(geometry, this.material, HAZE_COUNT);
    this.haze.frustumCulled = false;
    this.haze.instanceMatrix.setUsage(DynamicDrawUsage);
    this.haze.renderOrder = 2;
    this.dummy.position.set(0, -10, 0);
    this.dummy.scale.setScalar(0.001);
    this.dummy.updateMatrix();
    for (let i = 0; i < HAZE_COUNT; i += 1) this.haze.setMatrixAt(i, this.dummy.matrix);
    this.haze.instanceMatrix.needsUpdate = true;
    this.entity = this.world.createTransformEntity(this.haze);

    this.lampEntity = this.world.createTransformEntity();
    this.lampEntity.addComponent(PointLightComponent, { intensity: 0.4, distance: 6 });
    this.cleanupFuncs.push(() => {
      this.entity.dispose();
      this.lampEntity.dispose();
      geometry.dispose();
      this.material.dispose();
      noise.dispose();
    });
  }

  update(delta: number): void {
    const current = weatherStore.current();
    const target = current?.drivers.warmth ?? 0.5;
    // Ease toward the target so scrubbing the timeline never pops.
    const ease = Math.min(1, Math.min(delta, 0.05) * 2);
    this.currentWarmth += (target - this.currentWarmth) * ease;
    const warmth = this.currentWarmth;
    const { min, max } = roomModel;
    const spanX = Math.max(0.5, max.x - min.x);
    const spanZ = Math.max(0.5, max.z - min.z);
    const colH = Math.max(0.5, max.y - min.y);
    const time = performance.now() / 1000;

    // Regime blend: -1 (cold) .. 0 (neutral) .. +1 (warm).
    const warmT = Math.min(1, Math.max(0, (warmth - WARM_EDGE) / (1 - WARM_EDGE)));
    const coldT = Math.min(1, Math.max(0, (COLD_EDGE - warmth) / COLD_EDGE));
    this.tint.copy(NEUTRAL_COLOR).lerp(WARM_COLOR, warmT).lerp(COLD_COLOR, coldT);

    const cx = (min.x + max.x) / 2;
    const cz = (min.z + max.z) / 2;
    const moved =
      !this.placed ||
      Math.abs(min.x - this.lastBounds[0]) > 0.25 ||
      Math.abs(min.y - this.lastBounds[1]) > 0.25 ||
      Math.abs(min.z - this.lastBounds[2]) > 0.25 ||
      Math.abs(max.x - this.lastBounds[3]) > 0.25 ||
      Math.abs(max.y - this.lastBounds[4]) > 0.25 ||
      Math.abs(max.z - this.lastBounds[5]) > 0.25;
    if (moved) {
      this.placed = true;
      // Capped band: three strata through the lower air, the top one always
      // below eye level, the footprint always inside the walls.
      const band = Math.min(colH * 0.5, 1.25);
      for (let i = 0; i < HAZE_COUNT; i += 1) {
        const t = (i + 1) / (HAZE_COUNT + 1);
        this.dummy.position.set(cx, min.y + 0.3 + t * band, cz);
        this.dummy.rotation.set(-Math.PI / 2, 0, i * 0.7);
        this.dummy.scale.set(spanX * (0.86 + 0.05 * i), spanZ * (0.82 + 0.05 * i), 1);
        this.dummy.updateMatrix();
        this.haze.setMatrixAt(i, this.dummy.matrix);
      }
      this.haze.instanceMatrix.needsUpdate = true;
      this.lastBounds[0] = min.x;
      this.lastBounds[1] = min.y;
      this.lastBounds[2] = min.z;
      this.lastBounds[3] = max.x;
      this.lastBounds[4] = max.y;
      this.lastBounds[5] = max.z;
    }

    // The haze breathes with the regime: present at the extremes, faint when
    // the room is neither warm nor cold.
    const energy = 0.45 + 0.55 * Math.max(warmT, coldT);
    for (let i = 0; i < HAZE_COUNT; i += 1) this.alphas[i] = HAZE_BASE[i] * energy;
    (this.haze.geometry.getAttribute('aAlpha') as InstancedBufferAttribute).needsUpdate = true;
    this.material.uniforms.uTime.value = time;

    // One local warm/cool source so surfaces actually pick up the regime.
    const lamp = this.lampEntity.object3D;
    if (lamp != null) {
      lamp.position.set(0, min.y + colH * (0.4 + 0.3 * warmT), -0.5);
    }
    this.lampEntity.setValue(PointLightComponent, 'intensity', 0.25 + 0.45 * Math.max(warmT, coldT));
    this.lampEntity.setValue(PointLightComponent, 'color', this.tint);
  }
}
