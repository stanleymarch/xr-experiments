/**
 * Snow: soft instanced flakes with slow fall and wind-driven sway. Density and
 * fall speed follow snowfall; flakes briefly settle on sensed surfaces.
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
import { sandboxGustFactor } from '../sandbox-gust.js';
import { weatherStore } from '../weather-state.js';
import { windVectorFromFrame } from '../wind-shared.js';

const MAX_FLAKES = 900;
const REDUCED_FLAKES = 400;
const VERTEX = /* glsl */ `
attribute float aAlpha;
varying float vAlpha;
varying vec2 vUv;
void main() {
  vAlpha = aAlpha;
  vUv = uv;
  vec3 center = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vBeamWorld = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
  // Snow is "motes in the shaft": crystals grow inside the light cone and
  // shrink outside it, so the field has a cause instead of filling the room.
  // The outside-the-cone floor stays high enough that a snow hour reads as
  // snowfall everywhere, not only in the beam.
  float sizeMul = 0.72 + 0.28 * rBeamGate(center);
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix *
    vec4(position.xy * sizeMul, position.z, 1.0);
}
`;
const FRAGMENT = /* glsl */ `
uniform float uTime;
varying float vAlpha;
varying vec2 vUv;
void main() {
  // Fluffy flake: soft six-arm puff + gaussian core. The slow glint becomes
  // angular too — looking back along the beam toward the sun makes the
  // crystal flare, the same way a real flake does.
  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);
  float a = atan(p.y, p.x);
  float arms = 0.5 + 0.5 * cos(a * 6.0);
  float body = 1.0 - smoothstep(0.12, 0.42 + 0.4 * arms, r);
  float core = exp(-r * r * 14.0);
  // Faint rather than absent outside the shaft: snowfall must stay readable
  // at night, when there is no shaft at all. The composite alpha stays in a
  // visible band: vAlpha x body x cone-floor landed near 10% before and the
  // flakes disappeared on a lit room.
  float alpha = max(body * 0.85, core) * vAlpha * mix(0.55, 1.0, rBeamGate(vBeamWorld));
  if (alpha < 0.01) discard;
  vec3 viewDir = normalize(cameraPosition - vBeamWorld);
  float glint = pow(max(0.0, dot(viewDir, -uBeamDir)), 6.0);
  float shine = 0.85 + 0.3 * sin(uTime * 2.6 + vAlpha * 47.0);
  // White flakes vanish on a lit room: the soft outer body carries a cool
  // blue-gray rim (reads against pale walls) while the core stays snow-white
  // (reads against dark backgrounds). Straight alpha so the shade survives.
  vec3 flake = mix(vec3(0.66, 0.74, 0.88), vec3(0.98, 0.99, 1.0), clamp(core * 1.2, 0.0, 1.0));
  gl_FragColor = vec4(flake * shine, min(1.0, alpha * (1.0 + glint * 1.4)));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class SnowSystem extends createSystem({}) {
  private entity!: Entity;
  private flakes!: InstancedMesh;
  private profile!: ReadonlySignal<CapabilityProfile>;
  private readonly positions = new Float32Array(MAX_FLAKES * 3);
  private readonly speeds = new Float32Array(MAX_FLAKES);
  private readonly sizes = new Float32Array(MAX_FLAKES);
  private readonly alphas = new Float32Array(MAX_FLAKES);
  private readonly seeds = new Float32Array(MAX_FLAKES);
  private readonly settled = new Float32Array(MAX_FLAKES);
  private readonly dummy = new Object3D();
  private readonly wind = new Vector3();
  private readonly cameraPos = new Vector3();
  private cursor = 0;

  init(): void {
    this.profile = capabilityProfile(this.world);
    const geo = new PlaneGeometry(1, 1);
    const alpha = new InstancedBufferAttribute(this.alphas, 1);
    alpha.setUsage(DynamicDrawUsage);
    geo.setAttribute('aAlpha', alpha);
    const flakeMaterial = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: NormalBlending,
    });
    // Flakes are lit by the shared shaft and fill the same room volume as
    // rain, so they must not paint over real furniture either.
    enableBeamLighting(flakeMaterial);
    enableDepthOcclusion(flakeMaterial);
    // Staged rollout: implemented, off until the rain/dust wave is verified
    // on hardware (flag in hand-field.ts).
    if (HAND_FIELD_LAYERS.snow) enableHandField(flakeMaterial);
    this.flakes = new InstancedMesh(geo, flakeMaterial, MAX_FLAKES);
    this.flakes.frustumCulled = false;
    this.flakes.instanceMatrix.setUsage(DynamicDrawUsage);
    this.dummy.position.set(0, -10, 0);
    this.dummy.scale.setScalar(0.001);
    this.dummy.updateMatrix();
    for (let i = 0; i < MAX_FLAKES; i += 1) this.flakes.setMatrixAt(i, this.dummy.matrix);
    this.flakes.instanceMatrix.needsUpdate = true;
    this.flakes.count = 0;
    this.flakes.name = 'Weather Snow Flakes';
    this.entity = this.world.createTransformEntity(this.flakes);
    this.cleanupFuncs.push(() => this.entity.dispose());
  }

  update(delta: number): void {
    const current = weatherStore.current();
    const snow = current?.drivers.snow ?? 0;
    const budget = this.profile.peek().particleBudget === 'full' ? MAX_FLAKES : REDUCED_FLAKES;
    const live = snow > 0 ? Math.max(1, Math.floor(Math.sqrt(snow) * budget)) : 0;
    this.flakes.count = live;
    if (current == null || live === 0) return;

    const dt = Math.min(delta, 0.05);
    const { min, max } = roomModel;
    const spanX = Math.max(0.5, max.x - min.x);
    const spanZ = Math.max(0.5, max.z - min.z);
    const height = Math.max(0.5, max.y - min.y);
    windVectorFromFrame(current.frame, 0.12, this.wind);
    // A sandbox gust hurries the flakes with the same envelope rain and wind
    // read, so one wave moves every precipitation layer together.
    this.wind.multiplyScalar(1 + sandboxGustFactor() * 1.5);
    const time = performance.now() / 1000;
    (this.flakes.material as ShaderMaterial).uniforms.uTime.value = time;
    (this.xrManager.isPresenting ? this.world.player.head : this.world.camera).getWorldPosition(this.cameraPos);

    for (let i = 0; i < live; i += 1) {
      const ix = i * 3;
      if (this.alphas[i] <= 0) this.seed(i, min.x, min.y, min.z, spanX, spanZ, height, snow);
      const seed = this.seeds[i];
      if (this.settled[i] > 0) {
        this.settled[i] -= dt;
        if (this.settled[i] <= 0) this.seed(i, min.x, min.y, min.z, spanX, spanZ, height, snow);
      } else {
        const previousY = this.positions[ix + 1];
        this.positions[ix] += (this.wind.x + Math.sin(time * 0.7 + seed * 6.28) * 0.08) * dt;
        this.positions[ix + 1] -= this.speeds[i] * dt;
        this.positions[ix + 2] += (this.wind.z + Math.cos(time * 0.6 + seed * 8.1) * 0.08) * dt;
        this.positions[ix] = min.x + ((this.positions[ix] - min.x) % spanX + spanX) % spanX;
        this.positions[ix + 2] = min.z + ((this.positions[ix + 2] - min.z) % spanZ + spanZ) % spanZ;
        const surface = roomModel.surfaceHeightAt(this.positions[ix], this.positions[ix + 2], previousY);
        const contact = surface ?? min.y;
        if (this.positions[ix + 1] <= contact) {
          this.positions[ix + 1] = contact + 0.012;
          this.settled[i] = 1.2;
        }
      }
      const yaw = Math.atan2(
        this.cameraPos.x - this.positions[ix],
        this.cameraPos.z - this.positions[ix + 2],
      );
      this.dummy.position.set(this.positions[ix], this.positions[ix + 1], this.positions[ix + 2]);
      if (this.settled[i] > 0) this.dummy.rotation.set(-Math.PI / 2, 0, seed * Math.PI * 2);
      else this.dummy.rotation.set(0, yaw, Math.sin(time + seed * 6.28) * 0.2);
      this.dummy.scale.setScalar(this.sizes[i]);
      this.dummy.updateMatrix();
      this.flakes.setMatrixAt(i, this.dummy.matrix);
    }
    this.flakes.instanceMatrix.needsUpdate = true;
    (this.flakes.geometry.getAttribute('aAlpha') as InstancedBufferAttribute).needsUpdate = true;
  }

  private seed(i: number, minX: number, minY: number, minZ: number, spanX: number, spanZ: number, height: number, intensity: number): void {
    this.cursor += 1;
    const seed = ((this.cursor * 2654435761) % 10000) / 10000;
    const ix = i * 3;
    this.seeds[i] = seed;
    this.settled[i] = 0;
    this.positions[ix] = minX + ((seed * 7.13) % 1) * spanX;
    this.positions[ix + 1] = minY + height * (0.65 + 0.35 * ((seed * 17.3) % 1));
    this.positions[ix + 2] = minZ + ((seed * 31.7) % 1) * spanZ;
    this.speeds[i] = 0.25 + 0.55 * intensity + 0.25 * ((seed * 13.1) % 1);
    // Room-scale installation, not a macro lens: flakes are deliberately
    // large (6-14 cm) so snowfall reads at 2-4 m, the same reason the rain
    // streaks are 30 cm long.
    this.sizes[i] = 0.06 + 0.08 * ((seed * 19.9) % 1);
    this.alphas[i] = 0.35 + 0.55 * intensity;
  }

  override destroy(): void {
    super.destroy();
    this.positions.fill(0);
    this.speeds.fill(0);
    this.alphas.fill(0);
    this.settled.fill(0);
    this.cursor = 0;
  }
}
