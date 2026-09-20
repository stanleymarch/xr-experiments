import * as THREE from 'three';
import * as xb from 'xrblocks';
import { makePoints, shockRingMaterial, dome } from '../common/fx.js';

// REALITY//FIELD — комната как физическое поле.
// Импульс летит из руки/взгляда, бьётся о depth-mesh (Quest) или
// fallback-комнату (десктоп/телефон), расходится кольцом и волной по частицам.
// Жесты: pinch = заряд, open-palm = отталкивание, fist = притяжение,
// spread = растянуть поле. Клик/тап = импульс.
//
// Рендер: процедурные glow-спрайты (шейдер, затухание с глубиной),
// шейдерные shock-кольца, градиентный купол вместо пустоты.

const COUNT = 2200;
const ROOM_R = 3.4;
const ROOM_C = new THREE.Vector3(0, 1.6, 0);

const $ = (id) => document.getElementById(id);

class RealityField extends xb.Script {
  init() {
    this.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.4));
    const sun = new THREE.DirectionalLight(0x88ccff, 1.4);
    sun.position.set(1, 3, 2);
    this.add(sun);
    const cupola = dome(7);
    cupola.position.copy(ROOM_C);
    this.add(cupola);

    // --- поле частиц: шейдерные glow-точки ---
    const kit = makePoints(COUNT, { size: 0.045, color: 0xffffff, opacity: 0.95 });
    this.points = kit.points;
    this.pgeo = kit.geo;
    this.add(this.points);
    const pos = kit.pos;
    const col = kit.col;

    this.vel = new Float32Array(COUNT * 3);
    this.home = new Float32Array(COUNT * 3);
    this.homeCol = new Float32Array(COUNT * 3);
    this.hue = new Float32Array(COUNT);
    const c = new THREE.Color();
    for (let i = 0; i < COUNT; i++) {
      const x = (Math.random() * 2 - 1) * 3;
      const y = Math.random() * 2.6 + 0.1;
      const z = (Math.random() * 2 - 1) * 3;
      pos.set([x, y, z], i * 3);
      this.home.set([x, y, z], i * 3);
      this.hue[i] = 0.52 + Math.random() * 0.18;
      c.setHSL(this.hue[i], 0.9, 0.55);
      col.set([c.r, c.g, c.b], i * 3);
      this.homeCol.set([c.r, c.g, c.b], i * 3);
    }
    this.pgeo.attributes.position.needsUpdate = true;
    this.pgeo.attributes.color.needsUpdate = true;
    this.pmat = this.points.material;

    // тонкие светящиеся силовые линии: 90 отрезков между соседями по дому
    const SEG = 90;
    const lpos = new Float32Array(SEG * 6);
    this.links = new THREE.BufferGeometry();
    this.links.setAttribute('position', new THREE.BufferAttribute(lpos, 3));
    this.linkLines = new THREE.LineSegments(this.links, new THREE.LineBasicMaterial({
      color: 0x2a7fa8, transparent: true, opacity: 0.28,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.linkLines.frustumCulled = false;
    this.add(this.linkLines);
    // пары: i-й линк соединяет точки (i*7)%N и (i*13+5)%N
    this.linkPairs = [];
    for (let l = 0; l < SEG; l++) this.linkPairs.push([(l * 7) % COUNT, (l * 13 + 5) % COUNT]);

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

    // --- пул шейдерных колец удара ---
    this.rings = [];
    const rgeo = new THREE.RingGeometry(0.42, 0.5, 64);
    for (let i = 0; i < 10; i++) {
      const mat = shockRingMaterial(0x9fe8ff);
      const m = new THREE.Mesh(rgeo, mat);
      m.visible = false;
      this.add(m);
      this.rings.push({ mesh: m, t: 1e9, dur: 1.1 });
    }

    this.waves = []; // {x,y,z, r, speed}
    this.fx = new Set(); // 'repel' | 'attract' | 'stretch'
    this.handGestures = { left: new Set(), right: new Set() };
    this.charge = 0;
    this.debug = false;
    this.dream = false;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = 9;
    this._ray = new THREE.Ray();
    this._o = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._h = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._color = new THREE.Color();

    const rayPos = new Float32Array(6);
    this.debugRayGeo = new THREE.BufferGeometry();
    this.debugRayGeo.setAttribute('position', new THREE.BufferAttribute(rayPos, 3));
    this.debugRay = new THREE.Line(
      this.debugRayGeo,
      new THREE.LineBasicMaterial({ color: 0xffb14a, transparent: true, opacity: 0.9 })
    );
    this.debugRay.visible = false;
    this.add(this.debugRay);
    this.normalArrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(),
      0.35,
      0x7dff9a,
      0.09,
      0.05
    );
    this.normalArrow.visible = false;
    this.add(this.normalArrow);
    const g = xb.core.gestureRecognition;
    this._gs = (e) => this.onGesture(e.detail, true);
    this._ge = (e) => this.onGesture(e.detail, false);
    g.addEventListener('gesturestart', this._gs);
    g.addEventListener('gestureend', this._ge);

    $('btn-debug').onclick = () => this.setDebug(!this.debug);
    $('btn-dream').onclick = () => {
      this.dream = !this.dream;
      $('btn-dream').classList.toggle('on', this.dream);
      this.pmat.uniforms.uSize.value = this.dream ? 0.08 : 0.045;
      this.linkLines.material.opacity = this.dream ? 0.12 : 0.28;
    };

    this._fpsN = 0; this._fpsT = 0; this._fps = 0;
    this.stat('ready — click / pinch = импульс');
  }

  stat(s) { $('stat').textContent = s; }

  setDebug(enabled) {
    this.debug = enabled;
    $('btn-debug').classList.toggle('on', enabled);
    this.floor.visible = this.roomMesh.visible = enabled;
    this.debugRay.visible = enabled;
    if (!enabled) this.normalArrow.visible = false;
    try {
      if (xb.depth?.depthMesh) xb.depth.depthMesh.visible = enabled;
    } catch { /* depth может ещё прогреваться */ }
  }

  onGesture(detail, start) {
    const name = detail.name;
    const hand = detail.hand === 'left' ? 'left' : 'right';
    const active = this.handGestures[hand];
    start ? active.add(name) : active.delete(name);

    if (name === 'pinch') {
      if (start) this.charge = Math.max(this.charge, 0.2);
      else {
        this.fire(this.charge > 0 ? 1 + this.charge : 1);
        this.charge = 0;
      }
    }

    const bothSpread =
      this.handGestures.left.has('spread') && this.handGestures.right.has('spread');
    const anyRepel =
      this.handGestures.left.has('open-palm') || this.handGestures.right.has('open-palm');
    const anyAttract =
      this.handGestures.left.has('fist') || this.handGestures.right.has('fist');
    anyRepel ? this.fx.add('repel') : this.fx.delete('repel');
    anyAttract ? this.fx.add('attract') : this.fx.delete('attract');
    bothSpread ? this.fx.add('stretch') : this.fx.delete('stretch');
  }

  emitter() {
    try {
      xb.user.getControllerPosition(0, this._o);
      const r = xb.user.getRay(0, this._ray);
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
    if (this.debug) {
      this.normalArrow.position.copy(point);
      this.normalArrow.setDirection(normal);
      this.normalArrow.visible = true;
      this._normalAge = 0;
    }
  }

  update() {
    const dt = Math.min(xb.getDeltaTime(), 0.05);
    if (this.charge > 0) this.charge = Math.min(2.5, this.charge + dt * 1.5);
    this.emitter();
    const ex = this._o.x, ey = this._o.y, ez = this._o.z;
    if (this.debug) {
      const a = this.debugRayGeo.attributes.position.array;
      a.set([this._o.x, this._o.y, this._o.z], 0);
      a.set([
        this._o.x + this._d.x * 4,
        this._o.y + this._d.y * 4,
        this._o.z + this._d.z * 4,
      ], 3);
      this.debugRayGeo.attributes.position.needsUpdate = true;
      try {
        if (xb.depth?.depthMesh) xb.depth.depthMesh.visible = true;
      } catch { /* depth может ещё прогреваться */ }
    }

    const p = this.pgeo.attributes.position.array;
    const colA = this.pgeo.attributes.color.array;
    const dreamK = this.dream ? 0.4 : 1.0;

    for (const w of this.waves) w.r += w.speed * dt;
    this.waves = this.waves.filter((w) => w.r < 4);

    const repel = this.fx.has('repel') ? 1 : 0;
    const attract = this.fx.has('attract') ? 1 : 0;
    const stretch = this.fx.has('stretch') ? 1 : 0;
    const c = this._color;

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

      // цвет: дом + белизна скорости + вспышка фронта волны
      const speed = Math.min(1, Math.sqrt(vx * vx + vy * vy + vz * vz) * 1.4);
      let glow = 0;
      for (const w of this.waves) {
        const dx = x - w.x, dy = y - w.y, dz = z - w.z;
        if (Math.abs(Math.sqrt(dx * dx + dy * dy + dz * dz) - w.r) < 0.12) { glow = 1; break; }
      }
      const li = 0.55 + speed * 0.3 + glow * 0.5;
      c.setHSL(this.hue[i], 0.9, Math.min(0.95, li));
      colA[ix] = c.r; colA[ix + 1] = c.g; colA[ix + 2] = c.b;
    }
    this.pgeo.attributes.position.needsUpdate = true;
    this.pgeo.attributes.color.needsUpdate = true;

    // силовые линии следуют за концами
    const lp = this.links.attributes.position.array;
    this.linkPairs.forEach(([a, b], l) => {
      lp.set([p[a * 3], p[a * 3 + 1], p[a * 3 + 2], p[b * 3], p[b * 3 + 1], p[b * 3 + 2]], l * 6);
    });
    this.links.attributes.position.needsUpdate = true;

    for (const r of this.rings) {
      if (r.t >= r.dur) { r.mesh.visible = false; continue; }
      r.t += dt;
      const k = r.t / r.dur;
      r.mesh.scale.setScalar(0.2 + k * 3.2);
      r.mesh.material.uniforms.uT.value = k;
    }
    if (this.normalArrow.visible && (this._normalAge += dt) > 1.4) {
      this.normalArrow.visible = false;
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
    this.links.dispose(); this.linkLines.material.dispose();
    this.debugRayGeo.dispose(); this.debugRay.material.dispose();
    this.normalArrow.line.geometry.dispose(); this.normalArrow.line.material.dispose();
    this.normalArrow.cone.geometry.dispose(); this.normalArrow.cone.material.dispose();
}
}

const options = new xb.Options();
options.enableHands();
options.enableGestures();
options.enableDepth();
options.enablePlaneDetection();
options.enableReticles();
options.controllers.visualizeRays = true;
options.hands.visualization = true;
options.hands.visualizeJoints = true;
options.hands.visualizeMeshes = false;
options.gestures.setGestureEnabled('spread', true);
options.simulator.defaultMode = xb.SimulatorMode.POSE;
options.simulator.modeToggle.enabled = true;
options.xrButton.showEnterSimulatorButton = true;
options.setAppTitle('REALITY//FIELD');
options.setAppDescription('Комната как физическое поле. Клик — импульс, жесты — поле.');

document.addEventListener('DOMContentLoaded', () => {
  xb.add(new RealityField());
  xb.init(options);
});
