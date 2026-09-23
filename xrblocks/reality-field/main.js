import * as THREE from 'three';
import * as xb from 'xrblocks';
import {
  enableAutomation, hideInPassthrough, installLaunchShell, installXrGuards,
  isAutomation, watchXrButton,
} from '../common/boot.js?v=mobile-ux-17';
import { makePoints, shockRingMaterial, dome } from '../common/fx.js';
import { makeHud } from '../common/hud.js?v=mobile-ux-17';

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


class RealityField extends xb.Script {
  init() {
    this.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.4));
    const sun = new THREE.DirectionalLight(0x88ccff, 1.4);
    sun.position.set(1, 3, 2);
    this.add(sun);
    this.cupola = dome(7);
    this.cupola.position.copy(ROOM_C);
    this.add(this.cupola);

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
    const strands = 22;
    const rows = Math.ceil(COUNT / strands);
    for (let i = 0; i < COUNT; i++) {
      const strand = i % strands;
      const u = Math.floor(i / strands) / Math.max(1, rows - 1);
      const radius = 0.55 + strand / (strands - 1) * 2.3;
      const a = strand / strands * Math.PI * 2 + u * Math.PI * 3.4;
      const x = Math.sin(a) * radius;
      const y = 0.15 + u * 2.7 + Math.sin(a * 1.7) * 0.07;
      const z = Math.cos(a) * radius * 0.78;
      pos.set([x, y, z], i * 3);
      this.home.set([x, y, z], i * 3);
      this.hue[i] = 0.52 + 0.16 * strand / strands;
      c.setHSL(this.hue[i], 0.9, 0.55);
      col.set([c.r, c.g, c.b], i * 3);
      this.homeCol.set([c.r, c.g, c.b], i * 3);
    }
    this.pgeo.attributes.position.needsUpdate = true;
    this.pgeo.attributes.color.needsUpdate = true;
    this.pmat = this.points.material;

    // Непрерывные силовые траектории: частицы читаются как поле, а не пыль.
    this.fieldLines = new THREE.Group();
    this.flowMaterials = [];
    for (let strand = 0; strand < strands; strand++) {
      const path = [];
      const radius = 0.55 + strand / (strands - 1) * 2.3;
      for (let row = 0; row < rows; row++) {
        const u = row / Math.max(1, rows - 1);
        const a = strand / strands * Math.PI * 2 + u * Math.PI * 3.4;
        path.push(new THREE.Vector3(
          Math.sin(a) * radius,
          0.15 + u * 2.7 + Math.sin(a * 1.7) * 0.07,
          Math.cos(a) * radius * 0.78
        ));
      }
      c.setHSL(0.52 + 0.16 * strand / strands, 0.92, 0.6);
      const material = new THREE.MeshBasicMaterial({
        color: c, transparent: true, opacity: 0.28,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const curve = new THREE.CatmullRomCurve3(path, false, 'centripetal');
      this.fieldLines.add(new THREE.Mesh(
        new THREE.TubeGeometry(curve, 96, 0.0045, 5, false),
        material
      ));
      this.flowMaterials.push(material);
    }
    this.add(this.fieldLines);

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
    this.ringGeo = new THREE.RingGeometry(0.42, 0.5, 64);
    const rgeo = this.ringGeo;
    for (let i = 0; i < 10; i++) {
      const mat = shockRingMaterial(0x9fe8ff);
      const m = new THREE.Mesh(rgeo, mat);
      m.visible = false;
      this.add(m);
      this.rings.push({ mesh: m, t: 1e9, dur: 1.1 });
    }

    this.waves = []; // {x,y,z, r, speed, dx?,dy?,dz?} — с направлением = бегущая отражённая волна
    this.fx = new Set(); // 'repel' | 'attract' | 'stretch'
    this._handsSeen = false; // жесты реально приходили — иначе UI не заявляет HANDS
    this._mode = 'SYNTHETIC'; // источник геометрии последнего импульса
    this.handGestures = { left: new Set(), right: new Set() };
    this.charge = 0;
    this.debug = false;
    this.dream = false;
    this._autoFire = isAutomation() ? 0 : null;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = 9;
    this._ray = new THREE.Ray();
    this._handA = new THREE.Vector3();
    this._handB = new THREE.Vector3();
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
    this.hud = makeHud({
      title: 'REALITY//FIELD',
      stat: 'READY — CLICK / PINCH = IMPULSE',
      buttons: [
        {id: 'debug', label: 'DEBUG', onTap: () => this.setDebug(!this.debug)},
        {id: 'dream', label: 'DREAM', onTap: () => this.setDream(!this.dream)},
      ],
    });
    this.add(this.hud.card);
    // Купол — фон для VR/симулятора; в AR он закрашивает passthrough камеры.
    hideInPassthrough([this.cupola]);

    this._fpsN = 0; this._fpsT = 0; this._fps = 0;
    this.stat('READY — CLICK / PINCH = IMPULSE');
  }

  stat(s) { this.hud.setStat(s); }

  setDebug(enabled) {
    this.debug = enabled;
    this.hud.setLabel('debug', enabled ? 'DEBUG ·on' : 'DEBUG');
    this.floor.visible = this.roomMesh.visible = enabled;
    this.debugRay.visible = enabled;
    if (!enabled) this.normalArrow.visible = false;
    try {
      if (xb.depth?.depthMesh) xb.depth.depthMesh.visible = enabled;
    } catch { /* depth может ещё прогреваться */ }
    try {
      // план комнаты, найденные XR Blocks: тот же слой отладки, что и mesh
      const planes = xb.world?.planes ?? xb.core?.world?.planes;
      planes?.showDebugVisualizations?.(enabled);
    } catch { /* plane detection недоступна */ }
  }

  setDream(on) {
    this.dream = on;
    this.hud.setLabel('dream', on ? 'DREAM ·on' : 'DREAM');
    this.pmat.uniforms.uSize.value = on ? 0.08 : 0.045;
    for (const material of this.flowMaterials) material.opacity = on ? 0.14 : 0.28;
  }

  onGesture(detail, start) {
    this._handsSeen = true; // жестовые события реально приходят — UI может заявить HANDS
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

    // Поле растягивают только две руки: обе в pinch. Открытые ладони не
    // считаются — открытая кисть сама по себе похожа на «spread» и включала
    // бы растяжение постоянно.
    const bothPinch =
      this.handGestures.left.has('pinch') && this.handGestures.right.has('pinch');
    const anyRepel =
      this.handGestures.left.has('open-palm') || this.handGestures.right.has('open-palm');
    const anyAttract =
      this.handGestures.left.has('fist') || this.handGestures.right.has('fist');
    anyRepel ? this.fx.add('repel') : this.fx.delete('repel');
    anyAttract ? this.fx.add('attract') : this.fx.delete('attract');
    bothPinch ? this.fx.add('stretch') : this.fx.delete('stretch');
  }

  // Сила растяжения поля: чем шире разведены руки в pinch, тем сильнее.
  stretchStrength() {
    try {
      xb.user.getControllerPosition(0, this._handA);
      xb.user.getControllerPosition(1, this._handB);
      const d = this._handA.distanceTo(this._handB);
      if (d > 0.1) return Math.min(2.0, 0.4 + d);
    } catch { /* одна рука / десктоп */ }
    return 0.8;
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

  onSelectEnd(event) {
    if (this.hud.owns(event?.target)) return;
    this.fire(1);
  }

  // Цели импульса в порядке честности: живой depth-mesh Quest, затем
  // реальные плоскости WebXR (телефон), и только потом синтетическая комната.
  impulseTargets() {
    const targets = [];
    let mode = 'SYNTHETIC';
    try {
      if (xb.depth && xb.depth.depthMesh) {
        targets.push(xb.depth.depthMesh);
        mode = 'DEPTH';
      }
    } catch { /* depth ещё прогревается */ }
    if (!targets.length) {
      try {
        const planes = xb.world?.planes?.get?.() ?? [];
        for (const plane of planes) {
          if (plane && plane.isObject3D) targets.push(plane);
        }
        if (targets.length) mode = 'PLANES';
      } catch { /* plane detection недоступна */ }
    }
    if (!targets.length) targets.push(this.roomMesh);
    return { targets, mode };
  }

  fire(power = 1) {
    this.emitter();
    const o = this._o.clone();
    const d = this._d.clone().normalize();
    const { targets, mode } = this.impulseTargets();
    this.raycaster.set(o, d);
    const hits = this.raycaster.intersectObjects(targets, false);
    const kickOrigin = o.clone().addScaledVector(d, 0.4);
    if (hits.length) {
      const h = hits[0];
      this._h.copy(h.point);
      if (h.face && h.face.normal) this._n.copy(h.face.normal).transformDirection(h.object.matrixWorld);
      else this._n.copy(d).negate();
      this.spawnRing(this._h, this._n);
      // Первичная волна расходится по поверхности из точки удара.
      this.waves.push({ x: this._h.x, y: this._h.y, z: this._h.z, r: 0.05, speed: 1.6 });
      // Отражённый импульс: r = d − 2(d·n)n. Поверхность реально «отвечает»:
      // вторая волна бежит от точки вдоль r, частицы выбиваются туда же.
      const dn = d.dot(this._n);
      const refl = d.clone().addScaledVector(this._n, -2 * dn).normalize();
      if (refl.lengthSq() > 0.1 && Math.abs(dn) < 0.985) {
        this.waves.push({
          x: this._h.x, y: this._h.y, z: this._h.z, r: 0.04, speed: 2.1,
          dx: refl.x, dy: refl.y, dz: refl.z,
        });
        this.kick(this._h.clone(), refl, power * 0.55, this._h.clone().addScaledVector(refl, 2.6));
      }
      if (this.waves.length > 6) this.waves.splice(0, this.waves.length - 6);
      this.kick(kickOrigin, d, power, this._h);
    } else {
      // Мимо всякой геометрии: честно пинаем по лучу без «поверхности».
      this.kick(kickOrigin, d, power, null);
    }
    this._mode = mode;
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
    this.hud.update();
    const dt = Math.min(xb.getDeltaTime(), 0.05);
    if (this.charge > 0) this.charge = Math.min(2.5, this.charge + dt * 1.5);
    this.emitter();
    if (this._autoFire !== null && (this._autoFire += dt) >= 3) {
      this._autoFire = 0;
      this.fire(1.2);
    }
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

    for (const w of this.waves) {
      w.r += w.speed * dt;
      // Направленная (отражённая) волна не стоит на месте: её центр бежит
      // вдоль отражённого луча — поверхность «выстреливает» импульс обратно.
      if (w.dx !== undefined) {
        w.x += w.dx * w.speed * dt;
        w.y += w.dy * w.speed * dt;
        w.z += w.dz * w.speed * dt;
      }
    }
    this.waves = this.waves.filter((w) => w.r < 4);

    const repel = this.fx.has('repel') ? 1 : 0;
    const attract = this.fx.has('attract') ? 1 : 0;
    const stretch = this.fx.has('stretch') ? this.stretchStrength() : 0;
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
      if (stretch) { vx += (x - ROOM_C.x) * stretch * dt; vz += (z - ROOM_C.z) * stretch * dt; }

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

    const pulse = performance.now() * 0.0007;
    for (let i = 0; i < this.flowMaterials.length; i++) {
      this.flowMaterials[i].opacity = (this.dream ? 0.1 : 0.21)
        + 0.13 * (0.5 + 0.5 * Math.sin(pulse + i * 0.46));
    }

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
      let src = this._mode || 'SYNTHETIC';
      if (src === 'SYNTHETIC') {
        try {
          const n = (xb.world?.planes?.get?.() ?? []).length;
          if (n) src = `PLANES ${n}`;
        } catch { /* plane detection недоступна */ }
      }
      const ctl = this._handsSeen ? 'HANDS' : 'TAP';
      const fx = this.charge > 0 ? `CHARGE ${this.charge.toFixed(1)}` : [...this.fx].join('+') || 'pulse';
      this.stat(`FPS ${this._fps} · ${src} · ${ctl} · ${fx} · волн ${this.waves.length}`);
    }
  }

  dispose() {
    const g = xb.core.gestureRecognition;
    g.removeEventListener('gesturestart', this._gs);
    g.removeEventListener('gestureend', this._ge);
    this.pgeo.dispose(); this.pmat.dispose();
    for (const line of this.fieldLines.children) {
      line.geometry.dispose();
      line.material.dispose();
    }
    this.debugRayGeo.dispose(); this.debugRay.material.dispose();
    this.normalArrow.line.geometry.dispose(); this.normalArrow.line.material.dispose();
    this.normalArrow.cone.geometry.dispose(); this.normalArrow.cone.material.dispose();
    this.ringGeo?.dispose();
    for (const r of this.rings) r.mesh.material.dispose();
    this.floor.geometry.dispose(); this.floor.material.dispose();
    this.roomMesh.geometry.dispose(); this.roomMesh.material.dispose();
}
}

const options = new xb.Options();
options.enableHands();
options.enableGestures();
options.enableDepth();
options.enablePlaneDetection();
options.world?.enableAnchors?.();
options.world.planes.showDebugVisualizations =
  new URLSearchParams(window.location.search).has('debug');
options.enableReticles();
options.controllers.visualizeRays = true;
options.hands.visualization = true;
options.hands.visualizeJoints = true;
options.hands.visualizeMeshes = false;
// Режим симулятора остаётся USER (клик мышью = select, WASD = ходьба);
// позы рук доступны переключением режимов по Left Shift.
options.simulator.modeToggle.enabled = true;
options.xrButton.showEnterSimulatorButton = true;
options.setAppTitle('REALITY//FIELD');
options.setAppDescription('Импульс из pinch бьёт в реальную геометрию. Ладонь — отталкивает, кулак — притягивает.');

// Телефон без depth/hand-tracking получит сессию без них: boot.js даёт
// requestSession вторую попытку, а опыт остаётся на fallback-геометрии.
enableAutomation(options);
installXrGuards();
installLaunchShell(options, [
  'Вход — кнопка внизу: камера телефона станет окном в комнату',
  'Тап / pinch — импульс в реальную геометрию',
  'Меню — панель внизу экрана',
]);

document.addEventListener('DOMContentLoaded', () => {
  xb.add(new RealityField());
  xb.init(options);
  watchXrButton();
});
