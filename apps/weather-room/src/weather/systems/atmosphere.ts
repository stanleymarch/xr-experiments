/**
 * Atmosphere: cloud cover -> FogExp2 density + three drifting ceiling plates
 * (opacity capped at 0.45 so passthrough stays comfortable) + directional
 * light dimming. Pressure -> 400-point dust field: high pressure sinks low
 * and slow, low pressure expands with a gentle upward swirl.
 */

import {
  AdditiveBlending,
  AmbientLightComponent,
  BufferAttribute,
  BufferGeometry,
  createSystem,
  DirectionalLightComponent,
  FogExp2,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Points,
  PointsMaterial,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import { roomModel } from '../room.js';
import { weatherStore } from '../weather-state.js';

const FOG_CLEAR = 0.006;
const FOG_OVERCAST = 0.028;
const PLATE_MAX_OPACITY = 0.3;
const DUST_COUNT = 400;
const SUN_BRIGHT = 1.0;
const SUN_DIM = 0.35;

export class AtmosphereSystem extends createSystem({}) {
  private fog!: FogExp2;
  private plates: Mesh[] = [];
  private plateEntities: Entity[] = [];
  private plateMats: MeshBasicMaterial[] = [];
  private dust!: Points;
  private dustEntity!: Entity;
  private dustGeo!: BufferGeometry;
  private dustPos = new Float32Array(DUST_COUNT * 3);
  private dustSeed = new Float32Array(DUST_COUNT);
  private sunEntity!: Entity;
  private fillEntity!: Entity;

  init(): void {
    this.fog = new FogExp2(0x9fb4cc, FOG_CLEAR);
    this.world.scene.fog = this.fog;

    for (let i = 0; i < 3; i += 1) {
      const mat = new MeshBasicMaterial({
        color: 0xdfe8f2,
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
      });
      const plate = new Mesh(new PlaneGeometry(2.4 - i * 0.4, 1.6 - i * 0.25), mat);
      plate.rotation.x = Math.PI / 2;
      plate.renderOrder = 5;
      this.plates.push(plate);
      this.plateMats.push(mat);
      this.plateEntities.push(this.world.createTransformEntity(plate));
    }

    this.dustGeo = new BufferGeometry();
    for (let i = 0; i < DUST_COUNT; i += 1) this.dustSeed[i] = ((i * 2654435761) % 1000) / 1000;
    this.dustGeo.setAttribute('position', new BufferAttribute(this.dustPos, 3));
    const dustMat = new PointsMaterial({
      color: 0xcfd8e6,
      size: 0.021,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.dust = new Points(this.dustGeo, dustMat);
    this.dust.frustumCulled = false;
    this.dustEntity = this.world.createTransformEntity(this.dust);

    // Procedural lights are tuned with the current cloud cover.
    this.sunEntity = this.world.createTransformEntity();
    this.sunEntity.addComponent(DirectionalLightComponent, { intensity: SUN_BRIGHT });
    this.sunEntity.object3D?.position.set(-4, 6, 2);
    this.sunEntity.object3D?.lookAt(0, 0, 0);
    this.fillEntity = this.world.createTransformEntity();
    this.fillEntity.addComponent(AmbientLightComponent, { intensity: 0.45 });

    this.cleanupFuncs.push(() => {
      for (const entity of this.plateEntities) entity.dispose();
      this.dustEntity.dispose();
      this.sunEntity.dispose();
      this.fillEntity.dispose();
      if (this.world.scene.fog === this.fog) this.world.scene.fog = null;
    });
  }

  update(_delta: number): void {
    const current = weatherStore.current();
    const cloud = current?.drivers.cloud ?? 0.3;
    const pressure = current?.drivers.pressure ?? 0.5;
    const time = performance.now() / 1000;
    const { min, max } = roomModel;

    this.fog.density = FOG_CLEAR + (FOG_OVERCAST - FOG_CLEAR) * cloud;
    this.sunEntity.setValue(DirectionalLightComponent, 'intensity', SUN_BRIGHT - (SUN_BRIGHT - SUN_DIM) * cloud);

    // Cloud plates drift near the ceiling; opacity follows cover.
    const plateY = max.y - 0.2;
    for (let i = 0; i < this.plates.length; i += 1) {
      const plate = this.plates[i];
      const speed = 0.02 + cloud * 0.08;
      plate.position.set(
        Math.sin(time * speed + i * 2.1) * 1.1,
        plateY - i * 0.06,
        -0.4 + Math.cos(time * speed * 0.7 + i * 1.4) * 0.7,
      );
      this.plateMats[i].opacity = Math.min(PLATE_MAX_OPACITY, 0.02 + cloud * 0.28);
    }

    // Dust: high pressure -> compressed toward the floor and slow;
    // low pressure -> expanded column with a gentle upward swirl.
    const spanX = Math.max(0.5, max.x - min.x);
    const spanZ = Math.max(0.5, max.z - min.z);
    const colH = Math.max(0.5, max.y - min.y);
    const floorBias = pressure; // 1 = hug the floor, 0 = fill the column
    const swirl = (1 - pressure) * 0.35;
    for (let i = 0; i < DUST_COUNT; i += 1) {
      const s = this.dustSeed[i];
      const ix = i * 3;
      const yBase = min.y + colH * (1 - floorBias * (0.55 + 0.35 * ((s * 5) % 1)));
      this.dustPos[ix] = min.x + (((s * 3 + time * 0.008 * (1 + swirl)) % 1 + 1) % 1) * spanX;
      this.dustPos[ix + 1] =
        yBase + Math.sin(time * (0.25 + swirl) + s * 6.28) * 0.08 * (1 + (1 - pressure));
      this.dustPos[ix + 2] = min.z + (((s * 11 + time * 0.006) % 1 + 1) % 1) * spanZ;
      // Gentle upward drift for low pressure; wrap inside the column.
      if (swirl > 0.05) {
        this.dustPos[ix + 1] += (((time * swirl * 0.05 + s) % 0.3) * colH) % (colH * 0.3);
        if (this.dustPos[ix + 1] > max.y) this.dustPos[ix + 1] = min.y + 0.1;
      }
    }
    (this.dustGeo.getAttribute('position') as BufferAttribute).needsUpdate = true;
  }
}
