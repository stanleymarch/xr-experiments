import * as THREE from 'three';
import * as xb from 'xrblocks';

// REALITY//FIELD — комната как физическое поле.
// Импульс летит из руки/взгляда, бьётся о depth-mesh (Quest) или
// fallback-комнату (десктоп/телефон), расходится кольцом и волной по частицам.
// Жесты: pinch = заряд, open-palm = отталкивание, fist = притяжение,
// spread = растянуть поле. Клик/тап = импульс.

const COUNT = 1400;
const ROOM_R = 3.4;
const ROOM_C = new THREE.Vector3(0, 1.6, 0);

const $ = (id) => document.getElementById(id);

class RealityField extends xb.Script {
  init() {
    this.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.4));
    const sun = new THREE.DirectionalLight(0x88ccff, 1.4);
    sun.position.set(1, 3, 2);
    this.add(sun);

    // --- поле частиц ---
    const pos = new Float32Array(COUNT * 3);
    const col = new Float32Array(COUNT * 3);
    this.vel = new Float32Array(COUNT * 3);
    this.home = new Float32Array(COUNT * 3);
    this.homeCol = new Float32Array(COUNT * 3);
    const c = new THREE.Color();
    for (let i = 0; i < COUNT; i++) {
      const x = (Math.random() * 2 - 1) * 3;
      const y = Math.random() * 2.6 + 0.1;
      const z = (Math.random() * 2 - 1) * 3;
      pos.set([x, y, z], i * 3);
      this.home.set([x, y, z], i * 3);
      c.setHSL(0.52 + Math.random() * 0.18, 0.9, 0.55);
      col.set([c.r, c.g, c.b], i * 3);
      this.homeCol.set([c.r, c.g, c.b], i * 3);
    }
    this.pgeo = new THREE.BufferGeometry();
    this.pgeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.pgeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.pmat = new THREE.PointsMaterial({
      size: 0.02, vertexColors: true, transparent: true, opacity: 0.9,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.pgeo, this.pmat);
    this.points.frustumCulled = false;
    this.add(this.points);

    // --- fallback-комната: пол + сфера (видны только в DEBUG) ---
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 9),
      new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.25, color: 0x54d6ff })
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.visible = false;
    this.roomMesh = new THREE.Mesh(
      new THREE.SphereGeometry(ROOM_R, 24, 16),
      new THREE.MeshBasicMaterial({ wireframe: true, side: THREE.BackSide, transparent: true, opacity: 0.16, color: 0x54d6ff })
    );
    this.roomMesh.position.copy(ROOM_C);
    this.roomMesh.visible = false;
    this.add(this.floor, this.roomMesh);

    // --- пул колец удара ---
    this.rings = [];
    const rgeo = new THREE.RingGeometry(0.94, 1.0, 48);
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(rgeo, new THREE.MeshBasicMaterial({
        color: 0x9fe8ff, transparent: true, opacity: 0,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      m.visible = false;
      this.add(m);
      this.rings.push({ mesh: m, t: 1e9, dur: 1.1 });
    }

    this.waves = []; // {x,y,z, r, speed}
    this.fx = new Set(); // 'repel' | 'attract' | 'stretch'
    this.charge = 0;
    this.debug = false;
    this.dream = false;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = 9;
    this._o = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._h = new THREE.Vector3();
    this._n = new THREE.Vector3();

    const g = xb.core.gestureRecognition;
    this._gs = (e) => this.onGesture(e.detail, true);
    this._ge = (e) => this.onGesture(e.detail, false);
    g.addEventListener('gesturestart', this._gs);
    g.addEventListener('gestureend', this._ge);

    $('btn-debug').onclick = () => {
      this.debug = !this.debug;
      $('btn-debug').classList.toggle('on', this.debug);
      this.floor.visible = this.roomMesh.visible = this.debug;
      try { xb.user.enablePivots(); } catch { /* noop */ }
    };
    $('btn-dream').onclick = () => {
      this.dream = !this.dream;
      $('btn-dream').classList.toggle('on', this.dream);
      this.pmat.size = this.dream ? 0.04 : 0.02;
    };

    this._fpsN = 0; this._fpsT = 0; this._fps = 0;
    this.stat('ready — click / pinch = импульс');
  }

  stat(s) { $('stat').textContent = s; }

  onGesture(detail, start) {
    const n = detail.name;
    if (n === 'pinch') {
      if (start) this.charge = 0.2;
      else { this.fire(this.charge > 0 ? 1 + this.charge : 1); this.charge = 0; }
    } else if (n === 'open-palm') {
      start ? this.fx.add('repel') : this.fx.delete('repel');
    } else if (n === 'fist') {
      start ? this.fx.add('attract') : this.fx.delete('attract');
    } else if (n === 'spread') {
      start ? this.fx.add('stretch') : this.fx.delete('stretch');
    }
  }

  emitter() {
    try {
      xb.user.getControllerPosition(0, this._o);
      const r = xb.user.getRay(0, new THREE.Ray());
      if (r && r.direction.lengthSq() > 0.5) { this._d.copy(r.direction); return true; }
    } catch { /* fallback ниже */ }
    xb.core.camera.getWorldPosition(this._o);
    xb.core.camera.getWorldDirection(this._d);
    return true;
  }

  onSelectEnd() { this.fire(1); }

  fire(power = 1) {
    this.emitter();
    const o = this._o.clone();
    const d = this._d.clone().normalize();
    // цели: живой depth-mesh Quest, иначе fallback-комната
    const targets = [this.floor, this.roomMesh];
    try { if (xb.depth && xb.depth.depthMesh) targets.push(xb.depth.depthMesh); } catch { /* noop */ }
    this.raycaster.set(o, d);
    const hits = this.raycaster.intersectObjects(targets, false);
    const kickOrigin = o.clone().addScaledVector(d, 0.4);
    if (hits.length) {
      const h = hits[0];
      this._h.copy(h.point);
      if (h.face && h.face.normal) this._n.copy(h.face.normal).transformDirection(h.object.matrixWorld);
      else this._n.copy(d).negate();
      this.spawnRing(this._h, this._n);
      this.waves.push({ x: this._h.x, y: this._h.y, z: this._h.z, r: 0.05, speed: 1.6 });
      if (this.waves.length > 6) this.waves.shift();
      this.kick(kickOrigin, d, power, this._h);
    } else {
      this.kick(kickOrigin, d, power, null);
    }
  }

  kick(origin, dir, power, stopAt) {
    const p = this.pgeo.attributes.position.array;
    const maxD = stopAt ? origin.distanceTo(stopAt) : 4;
    for (let i = 0; i < COUNT; i++) {
      const ix = i * 3;
      const px = p[ix] - origin.x, py = p[ix + 1] - origin.y, pz = p[ix + 2] - origin.z;
      const along = px * dir.x + py * dir.y + pz * dir.z;
      if (along < 0 || along > maxD) continue;
      const rx = px - dir.x * along, ry = py - dir.y * along, rz = pz - dir.z * along;
      const rad2 = rx * rx + ry * ry + rz * rz;
      if (rad2 > 0.09) continue;
      const f = power * 2.2 * (1 - Math.sqrt(rad2) / 0.3) * (1 - along / (maxD + 0.5));
      this.vel[ix] += dir.x * f; this.vel[ix + 1] += dir.y * f + 0.4 * f; this.vel[ix + 2] += dir.z * f;
    }
  }

  spawnRing(point, normal) {
    const ring = this.rings.find((r) => r.t >= r.dur) || this.rings[0];
    ring.t = 0;
    ring.mesh.visible = true;
    ring.mesh.position.copy(point);
    ring.mesh.lookAt(this._h.clone().add(normal));
  }

  update() {
    const dt = Math.min(xb.getDeltaTime(), 0.05);
    if (this.charge > 0) this.charge = Math.min(2.5, this.charge + dt * 1.5);
    this.emitter();
    const ex = this._o.x, ey = this._o.y, ez = this._o.z;

    const p = this.pgeo.attributes.position.array;
    const colA = this.pgeo.attributes.color.array;
    const dreamK = this.dream ? 0.4 : 1.0;

    for (const w of this.waves) w.r += w.speed * dt;
    this.waves = this.waves.filter((w) => w.r < 4);

    const repel = this.fx.has('repel') ? 1 : 0;
    const attract = this.fx.has('attract') ? 1 : 0;
    const stretch = this.fx.has('stretch') ? 1 : 0;

    for (let i = 0; i < COUNT; i++) {
      const ix = i * 3;
      let x = p[ix], y = p[ix + 1], z = p[ix + 2];
      let vx = this.vel[ix], vy = this.vel[ix + 1], vz = this.vel[ix + 2];

      // слабая пружина домой
      vx += (this.home[ix] - x) * 0.6 * dt * dreamK;
      vy += (this.home[ix + 1] - y) * 0.6 * dt * dreamK;
      vz += (this.home[ix + 2] - z) * 0.6 * dt * dreamK;
      // затухание
      vx *= 1 - 1.6 * dt; vy *= 1 - 1.6 * dt; vz *= 1 - 1.6 * dt;

      // волны от ударов
      for (const w of this.waves) {
        const dx = x - w.x, dy = y - w.y, dz = z - w.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-4;
        const band = Math.abs(dist - w.r);
        if (band < 0.18) {
          const f = (1 - band / 0.18) * 3.2 * dt;
          vx += (dx / dist) * f; vy += (dy / dist) * f; vz += (dz / dist) * f;
        }
      }

      // ладонь / кулак вокруг эмиттера
      if (repel || attract) {
        const dx = x - ex, dy = y - ey, dz = z - ez;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 2.25 && d2 > 1e-6) {
          const dist = Math.sqrt(d2);
          const f = ((repel ? 1 : 0) - (attract ? 1 : 0)) * 2.4 * dt / (dist + 0.2);
          vx += (dx / dist) * f * 2; vy += (dy / dist) * f * 2; vz += (dz / dist) * f * 2;
        }
      }
      if (stretch) { vx += (x - ROOM_C.x) * 0.8 * dt; vz += (z - ROOM_C.z) * 0.8 * dt; }

      x += vx * dt * 8; y += vy * dt * 8; z += vz * dt * 8;

      // пол и границы комнаты
      if (y < 0.02) { y = 0.02; vy = Math.abs(vy) * 0.4; }
      const bx = x - ROOM_C.x, by = y - ROOM_C.y, bz = z - ROOM_C.z;
      const bl = Math.sqrt(bx * bx + by * by + bz * bz);
      if (bl > ROOM_R) {
        const s = ROOM_R / bl;
        x = ROOM_C.x + bx * s; y = ROOM_C.y + by * s; z = ROOM_C.z + bz * s;
        vx *= -0.3; vy *= -0.3; vz *= -0.3;
      }

      p[ix] = x; p[ix + 1] = y; p[ix + 2] = z;
      this.vel[ix] = vx; this.vel[ix + 1] = vy; this.vel[ix + 2] = vz;

      // подсветка фронта волны
      let glow = 0;
      for (const w of this.waves) {
        const dx = x - w.x, dy = y - w.y, dz = z - w.z;
        if (Math.abs(Math.sqrt(dx * dx + dy * dy + dz * dz) - w.r) < 0.12) { glow = 1; break; }
      }
      colA[ix] = this.homeCol[ix] + glow * 0.6;
      colA[ix + 1] = this.homeCol[ix + 1] + glow * 0.6;
      colA[ix + 2] = this.homeCol[ix + 2] + glow * 0.6;
    }
    this.pgeo.attributes.position.needsUpdate = true;
    this.pgeo.attributes.color.needsUpdate = true;

    for (const r of this.rings) {
      if (r.t >= r.dur) { r.mesh.visible = false; continue; }
      r.t += dt;
      const k = r.t / r.dur;
      r.mesh.scale.setScalar(0.1 + k * 1.6);
      r.mesh.material.opacity = 0.9 * (1 - k);
    }

    // FPS + статус
    this._fpsN++; this._fpsT += dt;
    if (this._fpsT >= 0.5) {
      this._fps = Math.round(this._fpsN / this._fpsT);
      this._fpsN = 0; this._fpsT = 0;
      let depthState = 'fallback-room';
      try { depthState = xb.depth && xb.depth.depthMesh ? 'depth-mesh LIVE' : 'fallback-room'; } catch { /* noop */ }
      const fx = this.charge > 0 ? `CHARGE ${this.charge.toFixed(1)}` : [...this.fx].join('+') || 'pulse';
      this.stat(`FPS ${this._fps} · ${depthState} · ${fx} · волн ${this.waves.length}`);
    }
  }

  dispose() {
    const g = xb.core.gestureRecognition;
    g.removeEventListener('gesturestart', this._gs);
    g.removeEventListener('gestureend', this._ge);
    this.pgeo.dispose(); this.pmat.dispose();
  }
}

const options = new xb.Options();
options.enableHands();
options.enableGestures();
options.enableDepth();
options.enableReticles();
options.controllers.visualizeRays = true;
options.hands.visualization = true;
options.xrButton.showEnterSimulatorButton = true;
options.setAppTitle('REALITY//FIELD');
options.setAppDescription('Комната как физическое поле. Клик — импульс, жесты — поле.');

document.addEventListener('DOMContentLoaded', () => {
  xb.add(new RealityField());
  xb.init(options);
});
