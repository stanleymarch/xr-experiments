/**
 * REALITY//FIELD — the motes.
 *
 * The air of the room is not empty: it holds a slow drift of luminous dust.
 * The dust is what makes the field legible between strikes — it shows where
 * the hands are, how fast they move and how the room pulls and pushes.
 *
 * Physics is deliberately simple and local:
 *
 * - an open palm pushes the motes out of its volume;
 * - a fist pulls them in;
 * - a fresh impulse attracts the motes around the contact point for a
 *   moment, so the strike visibly gathers the air around it;
 * - everything else is a slow curl drift with damping.
 *
 * The simulation runs on the CPU over a bounded particle count and writes
 * straight into the position buffer, so there is no per-frame allocation
 * and no per-particle object.
 */

import {
  AdditiveBlending,
  BufferGeometry,
  Float32BufferAttribute,
  Points,
  ShaderMaterial,
  Vector3,
  createSystem,
} from '@iwsdk/core';
import { Field } from '../field-component.js';
import { fieldRuntime } from '../field/runtime.js';
import { fieldState } from '../field/state.js';
import type { Entity } from '@iwsdk/core';

/** Motes kept alive when the field has no authored count. */
const DEFAULT_MOTES = 2000;
/** Half-width of the mote volume around the viewer, meters. */
const VOLUME_HALF_XZ = 2.6;
/** Height of the mote volume relative to the head, meters. */
const VOLUME_BELOW = 1.7;
const VOLUME_ABOVE = 1.3;
/** Radius of an open palm's push, meters. */
const PUSH_RADIUS = 0.55;
/** Radius of a fist's pull, meters. */
const PULL_RADIUS = 0.7;
/** Radius of the pull towards a fresh impact, meters. */
const IMPACT_RADIUS = 1.5;
/** How long an impact keeps pulling, seconds. */
const IMPACT_PULL_S = 1.1;

const VERTEX_SHADER = /* glsl */ `
attribute float aLife;
attribute float aSize;
varying float vLife;
void main() {
  vLife = aLife;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(aSize * (8.0 / max(-mv.z, 0.25)), 1.5, 16.0);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
varying float vLife;
void main() {
  vec2 offset = gl_PointCoord - 0.5;
  float d = dot(offset, offset);
  if (d > 0.25) discard;
  float glow = exp(-d * 11.0);
  vec3 color = mix(vec3(0.34, 0.56, 0.98), vec3(0.92, 0.98, 1.0), vLife);
  gl_FragColor = vec4(color * 1.35, glow * (0.3 + 0.75 * vLife));
}
`;

export class MoteFieldSystem extends createSystem({
  field: { required: [Field] },
}) {
  private points: Points | null = null;
  private moteEntity: Entity | null = null;
  private geometry: BufferGeometry | null = null;
  private material: ShaderMaterial | null = null;
  private positions: Float32Array | null = null;
  private velocities: Float32Array | null = null;
  private lives: Float32Array | null = null;
  private sizes: Float32Array | null = null;
  private count = 0;
  private readonly scratch = new Vector3();
  private readonly head = new Vector3();
  private rngState = 1337;

  init(): void {
    this.build(DEFAULT_MOTES);
  }

  update(delta: number, time: number): void {
    if (this.points == null || this.positions == null || this.velocities == null) return;
    const desired = this.readMoteCount();
    if (desired > 0 && desired !== this.count) {
      this.points = null;
      this.build(desired);
      return;
    }
    const positions = this.positions;
    const velocities = this.velocities;
    const lives = this.lives;
    const sizes = this.sizes;
    if (lives == null || sizes == null) return;

    this.world.player.head.getWorldPosition(this.head);
    const step = Math.min(delta, 0.05);

    const left = fieldState.hands.left;
    const right = fieldState.hands.right;
    const impactAge = time - (fieldState.impactCount > 0 ? fieldState.lastImpactAt : -100);
    const impactPull = impactAge >= 0 && impactAge < IMPACT_PULL_S ? 1 - impactAge / IMPACT_PULL_S : 0;

    for (let i = 0; i < this.count; i += 1) {
      const offset = i * 3;
      let x = positions[offset];
      let y = positions[offset + 1];
      let z = positions[offset + 2];
      let vx = velocities[offset];
      let vy = velocities[offset + 1];
      let vz = velocities[offset + 2];

      // Slow curl drift: three cheap sine terms, no noise texture.
      const phase = i * 0.37;
      vx += Math.sin(time * 0.31 + phase) * 0.006;
      vy += Math.sin(time * 0.23 + phase * 1.7) * 0.004;
      vz += Math.cos(time * 0.27 + phase * 0.8) * 0.006;

      // Hands push or pull the dust.
      for (const hand of [left, right]) {
        if (!hand.present) continue;
        const isPull = hand.gesture === 'fist';
        const isPush = hand.gesture === 'open';
        if (!isPull && !isPush) continue;
        const radius = isPull ? PULL_RADIUS : PUSH_RADIUS;
        const dx = x - hand.palm.x;
        const dy = y - hand.palm.y;
        const dz = z - hand.palm.z;
        const distanceSq = dx * dx + dy * dy + dz * dz;
        if (distanceSq > radius * radius || distanceSq < 1e-6) continue;
        const distance = Math.sqrt(distanceSq);
        const falloff = 1 - distance / radius;
        const force = (isPull ? 2.4 : 3.2) * falloff * falloff;
        const sign = isPull ? 1 : -1;
        vx += (sign * dx * force) / distance;
        vy += (sign * dy * force) / distance;
        vz += (sign * dz * force) / distance;
      }

      // A fresh strike gathers the air around the contact point.
      if (impactPull > 0) {
        const dx = fieldState.impactPosition.x - x;
        const dy = fieldState.impactPosition.y - y;
        const dz = fieldState.impactPosition.z - z;
        const distanceSq = dx * dx + dy * dy + dz * dz;
        if (distanceSq > 1e-6 && distanceSq < IMPACT_RADIUS * IMPACT_RADIUS) {
          const distance = Math.sqrt(distanceSq);
          const falloff = 1 - distance / IMPACT_RADIUS;
          const force = 3.4 * falloff * impactPull;
          vx += (dx * force) / distance;
          vy += (dy * force) / distance;
          vz += (dz * force) / distance;
        }
      }

      // Damping and integration.
      const damping = 0.94;
      vx *= damping;
      vy *= damping;
      vz *= damping;
      const speed = Math.hypot(vx, vy, vz);
      if (speed > 1.6) {
        const scale = 1.6 / speed;
        vx *= scale;
        vy *= scale;
        vz *= scale;
      }
      x += vx * step;
      y += vy * step;
      z += vz * step;

      // Keep the dust around the viewer.
      const minY = this.head.y - VOLUME_BELOW;
      const maxY = this.head.y + VOLUME_ABOVE;
      if (
        x < this.head.x - VOLUME_HALF_XZ ||
        x > this.head.x + VOLUME_HALF_XZ ||
        z < this.head.z - VOLUME_HALF_XZ ||
        z > this.head.z + VOLUME_HALF_XZ ||
        y < minY ||
        y > maxY
      ) {
        this.respawn(i);
        x = positions[offset];
        y = positions[offset + 1];
        z = positions[offset + 2];
        vx = 0;
        vy = 0;
        vz = 0;
      }

      positions[offset] = x;
      positions[offset + 1] = y;
      positions[offset + 2] = z;
      velocities[offset] = vx;
      velocities[offset + 1] = vy;
      velocities[offset + 2] = vz;
      lives[i] = Math.min(1, lives[i] + step * 0.6);
    }

    const attribute = this.geometry?.getAttribute('position') as Float32BufferAttribute | undefined;
    if (attribute != null) attribute.needsUpdate = true;
    const lifeAttribute = this.geometry?.getAttribute('aLife') as Float32BufferAttribute | undefined;
    if (lifeAttribute != null) lifeAttribute.needsUpdate = true;
  }
  /** Read the authored mote count from the `Field` component. */
  private readMoteCount(): number {
    for (const entity of this.queries.field.entities) {
      const value = entity.getValue(Field, 'moteCount');
      if (typeof value === 'number' && value > 0) return Math.floor(value);
    }
    return DEFAULT_MOTES;
  }

  /** Build the point cloud and register it with the world. */
  private build(count: number): void {
    const total = Math.max(0, Math.min(4000, count));
    // A previous cloud is replaced wholesale: dispose it instead of leaking
    // its geometry and entity.
    if (this.moteEntity != null) {
      this.moteEntity.dispose();
      this.moteEntity = null;
    }
    this.geometry?.dispose();
    this.material?.dispose();
    this.count = total;
    const positions = new Float32Array(total * 3);
    const velocities = new Float32Array(total * 3);
    const lives = new Float32Array(total);
    const sizes = new Float32Array(total);
    for (let i = 0; i < total; i += 1) {
      this.placeMote(i, positions, lives, sizes);
    }
    this.positions = positions;
    this.velocities = velocities;
    this.lives = lives;
    this.sizes = sizes;

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('aLife', new Float32BufferAttribute(lives, 1));
    geometry.setAttribute('aSize', new Float32BufferAttribute(sizes, 1));
    geometry.computeBoundingSphere();
    const material = new ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const points = new Points(geometry, material);
    points.frustumCulled = false;
    this.geometry = geometry;
    this.material = material;
    this.points = points;
    this.moteEntity = this.world.createTransformEntity(points);
  }

  /** Place one mote inside the volume around the viewer. */
  private respawn(index: number): void {
    const positions = this.positions;
    const lives = this.lives;
    const sizes = this.sizes;
    if (positions == null || lives == null || sizes == null) return;
    this.placeMote(index, positions, lives, sizes);
  }

  /** Write one mote's initial state into the given buffers. */
  private placeMote(
    index: number,
    positions: Float32Array,
    lives: Float32Array,
    sizes: Float32Array,
  ): void {
    this.world.player.head.getWorldPosition(this.head);
    const offset = index * 3;
    positions[offset] = this.head.x + (this.random() - 0.5) * VOLUME_HALF_XZ * 2;
    positions[offset + 1] =
      this.head.y - VOLUME_BELOW + this.random() * (VOLUME_BELOW + VOLUME_ABOVE);
    positions[offset + 2] = this.head.z + (this.random() - 0.5) * VOLUME_HALF_XZ * 2;
    lives[index] = 0;
    sizes[index] = 0.6 + this.random() * 1.1;
  }

  /** Deterministic pseudo-random: the dust must not depend on Math.random. */
  private random(): number {
    this.rngState = (this.rngState * 1664525 + 1013904223) % 4294967296;
    return this.rngState / 4294967296;
  }

  override destroy(): void {
    super.destroy();
    this.moteEntity?.dispose();
    this.moteEntity = null;
    this.geometry?.dispose();
    this.material?.dispose();
    this.geometry = null;
    this.material = null;
    this.points = null;
  }
}
