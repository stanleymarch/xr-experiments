/**
 * Temperature: 500 thermal motes + one warm/cool PointLight.
 * Warm (warmth > 0.55) -> warm-white motes rising from surfaces, warm tint.
 * Cold (warmth < 0.45) -> ice-blue motes sinking near the floor, cool tint.
 * Between -> neutral sparse slow drift. Everything interpolates, no popping.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  createSystem,
  PointLightComponent,
  Points,
  ShaderMaterial,
  Vector3,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import { roomModel } from '../room.js';
import { weatherStore } from '../weather-state.js';

const MOTE_COUNT = 500;
const WARM_EDGE = 0.6;
const COLD_EDGE = 0.6;

const MOTE_VERTEX = /* glsl */ `
attribute float aAlpha;
attribute float aSize;
varying float vAlpha;
void main() {
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize / max(0.1, -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;
const MOTE_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;
void main() {
  vec2 uv = gl_PointCoord - vec2(0.5, 0.5);
  float d = length(uv);
  float a = (1.0 - smoothstep(0.05, 0.5, d)) * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a * 0.8);
}
`;

const WARM_COLOR = new Color(1.0, 0.82, 0.6);
const NEUTRAL_COLOR = new Color(0.75, 0.8, 0.88);
const COLD_COLOR = new Color(0.55, 0.75, 1.0);

export class TemperatureSystem extends createSystem({}) {
  private entity!: Entity;
  private lampEntity!: Entity;
  private geo!: BufferGeometry;
  private mat!: ShaderMaterial;
  private positions = new Float32Array(MOTE_COUNT * 3);
  private alphas = new Float32Array(MOTE_COUNT);
  private sizes = new Float32Array(MOTE_COUNT);
  private seeds = new Float32Array(MOTE_COUNT);
  private readonly tint = new Color();
  private readonly scratch = new Vector3();
  private currentWarmth = 0.5;

  init(): void {
    for (let i = 0; i < MOTE_COUNT; i += 1) {
      this.seeds[i] = ((i * 2654435761) % 1000) / 1000;
      this.sizes[i] = 7 + ((this.seeds[i] * 41) % 1) * 11;
      this.alphas[i] = 0.14 + ((this.seeds[i] * 17) % 1) * 0.3;
    }
    this.geo = new BufferGeometry();
    this.geo.setAttribute('position', new BufferAttribute(this.positions, 3));
    this.geo.setAttribute('aAlpha', new BufferAttribute(this.alphas, 1));
    this.geo.setAttribute('aSize', new BufferAttribute(this.sizes, 1));
    this.mat = new ShaderMaterial({
      vertexShader: MOTE_VERTEX,
      fragmentShader: MOTE_FRAGMENT,
      uniforms: { uColor: { value: this.tint } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const points = new Points(this.geo, this.mat);
    points.frustumCulled = false;
    this.entity = this.world.createTransformEntity(points);

    this.lampEntity = this.world.createTransformEntity();
    this.lampEntity.addComponent(PointLightComponent, { intensity: 0.4, distance: 6 });
    this.cleanupFuncs.push(() => {
      this.entity.dispose();
      this.lampEntity.dispose();
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
    const dt = Math.min(delta, 0.05);

    // Regime blend: -1 (cold) .. 0 (neutral) .. +1 (warm).
    const warmT = Math.min(1, Math.max(0, (warmth - WARM_EDGE) / (1 - WARM_EDGE)));
    const coldT = Math.min(1, Math.max(0, (COLD_EDGE - warmth) / COLD_EDGE));
    this.tint.copy(NEUTRAL_COLOR).lerp(WARM_COLOR, warmT).lerp(COLD_COLOR, coldT);

    const lamp = this.lampEntity.object3D;
    if (lamp != null) {
      lamp.position.set(0, min.y + colH * (0.4 + 0.3 * warmT), -0.5);
    }
    this.lampEntity.setValue(PointLightComponent, 'intensity', 0.25 + 0.45 * Math.max(warmT, coldT));
    this.lampEntity.setValue(PointLightComponent, 'color', this.tint);

    for (let i = 0; i < MOTE_COUNT; i += 1) {
      const s = this.seeds[i];
      const ix = i * 3;
      // Vertical behavior: warm rises from surfaces, cold sinks near floor.
      const rise = warmT * 0.22 - coldT * 0.1;
      const driftPhase = time * (0.2 + 0.5 * Math.max(warmT, coldT)) + s * 6.28;
      this.positions[ix] = min.x + (((s * 3 + time * 0.01) % 1 + 1) % 1) * spanX;
      const baseH = warmth >= 0.5 ? ((s * 7) % 1) * colH : ((s * 7) % 1) * colH * 0.45;
      this.positions[ix + 1] =
        min.y + 0.08 + ((baseH + time * rise + s * colH) % colH + colH) % colH;
      this.positions[ix + 2] =
        min.z + (((s * 11 + Math.sin(driftPhase) * 0.03) % 1 + 1) % 1) * spanZ;
      // Neutral band: sparse and dim; extremes: denser.
      const energy = Math.max(warmT, coldT);
      this.alphas[i] = 0.06 + energy * 0.4 * (0.4 + 0.6 * ((s * 17) % 1));
    }
    (this.geo.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aAlpha') as BufferAttribute).needsUpdate = true;
    void this.scratch;
    void dt;
  }
}
