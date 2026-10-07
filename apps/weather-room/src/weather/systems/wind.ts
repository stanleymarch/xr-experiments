/**
 * Wind: 16 ribbon trails (THREE.Line, 24 preallocated points each) advecting
 * along the shared world wind vector inside the RoomModel bounds.
 * Speed/amplitude <- drivers.wind; calm air parks the ribbons faintly.
 */

import {
  BufferAttribute,
  BufferGeometry,
  createSystem,
  Line,
  LineBasicMaterial,
  Vector3,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import { roomModel } from '../room.js';
import { weatherStore } from '../weather-state.js';
import { windVectorFromFrame } from '../wind-shared.js';

const RIBBON_COUNT = 16;
const TRAIL_POINTS = 24;
const BASE_SPEED = 0.6;

export class WindSystem extends createSystem({}) {
  private readonly entities: Entity[] = [];
  private readonly geos: BufferGeometry[] = [];
  private readonly mats: LineBasicMaterial[] = [];
  private readonly heads = new Float32Array(RIBBON_COUNT * 3);
  private readonly seeds = new Float32Array(RIBBON_COUNT);
  private readonly wind = new Vector3();
  private seeded = false;

  init(): void {
    for (let r = 0; r < RIBBON_COUNT; r += 1) {
      const positions = new Float32Array(TRAIL_POINTS * 3);
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(positions, 3));
      const mat = new LineBasicMaterial({ color: 0x79e3ff, transparent: true, opacity: 0.0 });
      const line = new Line(geo, mat);
      line.frustumCulled = false;
      this.entities.push(this.world.createTransformEntity(line));
      this.geos.push(geo);
      this.mats.push(mat);
      this.seeds[r] = ((r * 2654435761) % 1000) / 1000;
    }
    this.cleanupFuncs.push(() => {
      for (const entity of this.entities) entity.dispose();
      this.entities.length = 0;
    });
  }

  update(delta: number): void {
    const current = weatherStore.current();
    const strength = current?.drivers.wind ?? 0;
    const dt = Math.min(delta, 0.05);
    const { min, max } = roomModel;
    const spanX = Math.max(0.5, max.x - min.x);
    const spanY = Math.max(0.5, max.y - min.y);
    const spanZ = Math.max(0.5, max.z - min.z);
    if (current != null) windVectorFromFrame(current.frame, 1, this.wind);
    const speed = BASE_SPEED * (0.25 + strength * 3);

    if (!this.seeded) {
      this.seeded = true;
      for (let r = 0; r < RIBBON_COUNT; r += 1) {
        const s = this.seeds[r];
        this.heads[r * 3] = min.x + ((s * 3) % 1) * spanX;
        this.heads[r * 3 + 1] = min.y + spanY * (0.25 + 0.5 * ((s * 7) % 1));
        this.heads[r * 3 + 2] = min.z + ((s * 13) % 1) * spanZ;
        this.fillTrail(r);
      }
    }

    const dirLen = Math.hypot(this.wind.x, this.wind.z);
    const hasWind = dirLen > 0.05;
    const dirX = hasWind ? this.wind.x / dirLen : 1;
    const dirZ = hasWind ? this.wind.z / dirLen : 0;
    // Trail spacing grows with wind so fast flow stretches the ribbon.
    const spacing = 0.03 + strength * 0.12;
    // Sway perpendicular to flow; amplitude <- wind.
    const swayAmp = 0.02 + strength * 0.16;
    const time = performance.now() / 1000;

    for (let r = 0; r < RIBBON_COUNT; r += 1) {
      const mat = this.mats[r];
      mat.opacity = 0.08 + strength * 0.7;
      if (strength <= 0.01) continue;
      const hx = r * 3;
      this.heads[hx] += dirX * speed * dt;
      this.heads[hx + 1] += Math.sin(time * 1.7 + this.seeds[r] * 6.28) * swayAmp * 0.3 * dt;
      this.heads[hx + 2] += dirZ * speed * dt;
      // Wrap inside the volume.
      if (this.heads[hx] < min.x) this.heads[hx] += spanX;
      else if (this.heads[hx] > max.x) this.heads[hx] -= spanX;
      if (this.heads[hx + 1] < min.y + 0.1) this.heads[hx + 1] = min.y + 0.1;
      else if (this.heads[hx + 1] > max.y) this.heads[hx + 1] = max.y;
      if (this.heads[hx + 2] < min.z) this.heads[hx + 2] += spanZ;
      else if (this.heads[hx + 2] > max.z) this.heads[hx + 2] -= spanZ;
      // Shift the trail back along the flow with a perpendicular sine sway.
      const positions = (this.geos[r].getAttribute('position') as BufferAttribute).array as Float32Array;
      const perpX = -dirZ;
      const perpZ = dirX;
      for (let p = 0; p < TRAIL_POINTS; p += 1) {
        const back = p * spacing;
        const sway = Math.sin(time * 2 + p * 0.55 + this.seeds[r] * 6.28) * swayAmp * (p / TRAIL_POINTS);
        positions[p * 3] = this.heads[hx] - dirX * back + perpX * sway;
        positions[p * 3 + 1] = this.heads[hx + 1] + Math.cos(time * 1.3 + p * 0.4) * swayAmp * 0.3 * (p / TRAIL_POINTS);
        positions[p * 3 + 2] = this.heads[hx + 2] - dirZ * back + perpZ * sway;
      }
      (this.geos[r].getAttribute('position') as BufferAttribute).needsUpdate = true;
    }
  }

  private fillTrail(r: number): void {
    const positions = (this.geos[r].getAttribute('position') as BufferAttribute).array as Float32Array;
    for (let p = 0; p < TRAIL_POINTS; p += 1) {
      positions[p * 3] = this.heads[r * 3];
      positions[p * 3 + 1] = this.heads[r * 3 + 1];
      positions[p * 3 + 2] = this.heads[r * 3 + 2];
    }
    (this.geos[r].getAttribute('position') as BufferAttribute).needsUpdate = true;
  }
}
