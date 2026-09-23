// REALITY//FIELD — комната как физическое поле.
//
// Референс (концепт): тонкий циановый импульс из кончика пальца бьёт в
// реальную стену, вспыхивает в точке удара, расходится компактным кольцом
// по отсканированному мешу и осыпается частицами на пол. Метки интерфейса:
// «DEBUG REALITY», «DREAM REALITY», «CHARGE 68%», «FPS 72».
//
// Платформы: Quest 3 / Android XR (жесты и лучи), смартфон AR (тап =
// импульс, удержание = заряд), десктоп (клик), универсальный тест — ?test=1.

import * as THREE from 'three';
import * as xb from 'xrblocks';
import {
  COLORS, baseOptions, createHud, watchSession, spatialControls,
  anchorRoot, fpsMeter,
} from '../common/shell.js';
import {
  softParticlesMaterial, particleAttributes, ringShockMaterial,
  beamMaterial, addBloom, tickMaterials,
} from '../common/shaders.js';
import { glowTexture, starTexture, spritePool } from '../common/sprites.js';

const COUNT = 1400;
const ROOM_R = 3.4;
const ROOM_C = new THREE.Vector3(0, 1.6, 0);
const RING_DUR = 0.9;
const RING_MAX = 0.32;   // компактные кольца: ≤32 см, не «огромные белые круги»
const BEAM_DUR = 1.05;
const FIRE_DEDUPE = 0.15;

window.__RF_VER = 3; document.documentElement.dataset.rfVer = '3';
class RealityField extends xb.Script {
  init() {
    try { this._init(); }
    catch (e) {
      document.documentElement.dataset.rfInitErr = (e && e.message) || String(e);
      console.error('[RF] INIT FAIL', e);
      throw e;
    }
  }

  _init() {
    this.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.4));
    const sun = new THREE.DirectionalLight(0x88ccff, 1.4);
    sun.position.set(1, 3, 2);
    this.add(sun);

    // Всё содержимое — в anchored root: платформа уточняет карту комнаты,
    // якорь удерживает поле на месте (лечит «улетание» трекинга).
    this.root = new THREE.Group();
    this.root.name = 'reality-field-root';
    this.add(this.root);
    this.anchor = anchorRoot();

    // --- поле частиц ---
    const pos = new Float32Array(COUNT * 3);
    const col = new Float32Array(COUNT * 3);
    this.vel = new Float32Array(COUNT * 3);
    this.home = new Float32Array(COUNT * 3);
    this.homeCol = new Float32Array(COUNT * 3);
    const c = new THREE.Color();
    // Не «пыль на стенах», а 18 медленно переплетённых силовых линий.
    // Спирали дают читаемую структуру с любого направления и сохраняют
    // свободный центр для импульса/impact.
    const strands = 18;
    const rows = Math.ceil(COUNT / strands);
    for (let i = 0; i < COUNT; i++) {
      const strand = i % strands;
      const u = Math.floor(i / strands) / Math.max(1, rows - 1);
      const radius = 0.48 + (strand / (strands - 1)) * 2.45;
      const a = strand / strands * Math.PI * 2 + u * Math.PI * 3.4;
      const jitter = () => (Math.random() - 0.5) * 0.055;
      const x = Math.sin(a) * radius + jitter();
      const y = 0.12 + u * 2.55 + Math.sin(a * 1.7) * 0.07 + jitter();
      const z = Math.cos(a) * radius * 0.78 + jitter();
      pos.set([x, y, z], i * 3);
      this.home.set([x, y, z], i * 3);
      c.setHSL(0.52 + 0.16 * (strand / strands), 0.92, 0.56);
      col.set([c.r, c.g, c.b], i * 3);
      this.homeCol.set([c.r, c.g, c.b], i * 3);
    }
    this.pgeo = new THREE.BufferGeometry();
    this.pgeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.pgeo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    particleAttributes(this.pgeo, { scaleRandom: 0.4 });
    this.pmat = softParticlesMaterial({
      size: 0.04, color: COLORS.accent, twinkle: 0.9,
      map: glowTexture({ core: 0.1 }),
    });
    this.points = new THREE.Points(this.pgeo, this.pmat);
    this.points.frustumCulled = false;
    this.root.add(this.points);

    // Непрерывные splines связывают точки в читаемые силовые траектории.
    // Это намеренно не wireframe комнаты: линии принадлежат только полю.
    this.fieldLines = new THREE.Group();
    this.flowMaterials = [];
    for (let strand = 0; strand < strands; strand++) {
      const path = [];
      const radius = 0.48 + (strand / (strands - 1)) * 2.45;
      for (let row = 0; row < rows; row++) {
        const u = row / Math.max(1, rows - 1);
        const a = strand / strands * Math.PI * 2 + u * Math.PI * 3.4;
        path.push(new THREE.Vector3(
          Math.sin(a) * radius,
          0.12 + u * 2.55 + Math.sin(a * 1.7) * 0.07,
          Math.cos(a) * radius * 0.78,
        ));
      }
      c.setHSL(0.52 + 0.16 * (strand / strands), 0.92, 0.6);
      const material = new THREE.MeshBasicMaterial({
        color: c, transparent: true, opacity: 0.3,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const curve = new THREE.CatmullRomCurve3(path, false, 'centripetal');
      const strandMesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 96, 0.0045, 5, false), material);
      this.fieldLines.add(strandMesh);
      this.flowMaterials.push(material);
    }
    this.root.add(this.fieldLines);

    // --- fallback-комната (пол + сфера), видна только в DEBUG,
    //     используется как коллайдер только когда depth-mesh недоступен ---
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 9),
      new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.25, color: COLORS.accent })
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.visible = false;
    this.roomMesh = new THREE.Mesh(
      new THREE.SphereGeometry(ROOM_R, 24, 16),
      new THREE.MeshBasicMaterial({ wireframe: true, side: THREE.BackSide, transparent: true, opacity: 0.16, color: COLORS.accent })
    );
    this.roomMesh.position.copy(ROOM_C);
    this.roomMesh.visible = false;
    this.root.add(this.floor, this.roomMesh);

    // --- визуальные эффекты удара (шейдеры + спрайты) ---
    // Шоквейв-кольца: единичный диск, uProgress 0→1, ориентация нормалью.
    this.rings = [];
    const rgeo = new THREE.CircleGeometry(1, 48);
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(rgeo, ringShockMaterial({ color: COLORS.accent }));
      m.visible = false;
      this.root.add(m);
      this.rings.push({ mesh: m, t: 1e9 });
    }
    // Спрайт-вспышки удара: звезда-искра + мягкое глоу.
    this.glints = spritePool(starTexture({ rays: 6 }), { count: 10, dur: 1.05, grow: 2.2, color: 0xe8fbff });
    this.bursts = spritePool(glowTexture({ core: 0.18 }), { count: 10, dur: 1.05, grow: 2.8, color: 0x54d6ff });
    this.root.add(this.glints.group, this.bursts.group);
    // Лучи-импульсы: две скрещенные плоскости (видны с любого угла,
    // в отличие от цилиндра с торца), uLife 0→1.
    this.beams = [];
    const pgeo = new THREE.PlaneGeometry(0.045, 1);
    pgeo.translate(0, 0.5, 0); // основание в точке эмиттера
    this._up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < 4; i++) {
      // Отдельный material на импульс: перекрывающиеся выстрелы не делят uLife.
      const material = beamMaterial({ color: COLORS.accent });
      const group = new THREE.Group();
      const a = new THREE.Mesh(pgeo, material);
      const b = new THREE.Mesh(pgeo, material);
      b.rotation.y = Math.PI / 2;
      group.add(a, b);
      group.visible = false;
      this.root.add(group);
      this.beams.push({ mesh: group, material, t: 1e9 });
    }
    // маркер нормали последнего удара (только DEBUG)
    this.normalMark = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 0.18, 0xff6b5e);
    this.normalMark.visible = false;
    this.root.add(this.normalMark);

    this.waves = [];
    this.fx = new Set();
    this.charge = 0;
    this.pinchHeld = false;
    this.touchHeld = false;
    this.lastFire = -1;
    this.fired = 0;
    this.debug = false;
    this.dream = false;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = 9;
    this._o = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._h = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._v = new THREE.Vector3();

    const g = xb.core.gestureRecognition;
    this._gs = (e) => this.onGesture(e.detail, true);
    this._ge = (e) => this.onGesture(e.detail, false);
    g.addEventListener('gesturestart', this._gs);
    g.addEventListener('gestureend', this._ge);

    // --- UI: DOM-HUD вне сессии + пространственная панель внутри XR ---
    const toggleDebug = () => this.setDebug(!this.debug);
    const toggleDream = () => this.setDream(!this.dream);
    this.hud = createHud({
      title: 'REALITY//FIELD',
      controls: [
        { id: 'debug', label: 'DEBUG REALITY', onClick: toggleDebug },
        { id: 'dream', label: 'DREAM REALITY', onClick: toggleDream },
      ],
      hint: 'тап — импульс · удержание — заряд · жесты: pinch/open-palm/fist/spread',
    });
    this.spatial = spatialControls({
      title: 'REALITY//FIELD',
      status: 'CHARGE 0% / 0 FPS',
      controls: [
        { id: 'debug', label: 'DEBUG', onClick: toggleDebug },
        { id: 'dream', label: 'DREAM', onClick: toggleDream },
      ], width: 0.68,
    });
    // Основное поле и точка удара должны оставаться открыты: панель уводим
    // вверх вправо, как приборную вставку из референса.
    this.spatial.card.position.set(0.78, 1.72, -1.25);
    this.add(this.spatial.card);

    this.fpsTick = fpsMeter((fps) => { this.fps = fps; });
    this.fps = 0;
    window.__realityField = this; // для универсальных тестов (?test=1)
  }

  get depthMesh() {
    try { return xb.depth?.depthMesh ?? null; } catch { return null; }
  }

  setDebug(on) {
    this.debug = on;
    this.hud.setToggle('debug', on);
    this.spatial.setToggle('debug', on);
    this.floor.visible = on;
    this.roomMesh.visible = on;
    this.normalMark.visible = on && this.normalMark.userData.hasHit;
    try { if (this.depthMesh) this.depthMesh.material.wireframe = on; } catch { /* noop */ }
    this.stat();
  }

  setDream(on) {
    this.dream = on;
    this.hud.setToggle('dream', on);
    this.spatial.setToggle('dream', on);
    this.pmat.uniforms.uSize.value = on ? 0.085 : 0.05;
    this.stat();
  }

  stat() {
    const depthState = this.depthMesh ? 'depth LIVE' : 'fallback-room';
    const chargePct = Math.round(Math.min(this.charge, 1.5) / 1.5 * 100);
    const mode = this.dream ? 'DREAM' : this.debug ? 'DEBUG' : [...this.fx].join('+') || 'pulse';
    const s = `${this.fps || 0} FPS / CHARGE ${chargePct}% / ${depthState} / ${mode}`;
    this.hud.setStatus(s);
    this.spatial.setStatus(`CHARGE ${chargePct}% / ${this.fps || 0} FPS\n${depthState}`);
    // Канал состояния для универсальных тестов (?test=1) и отладки:
    // DOM общий для всех миров, в отличие от window.
    document.documentElement.dataset.rfState = JSON.stringify({
      fps: this.fps, charge: chargePct, depth: depthState, mode,
      fired: this.fired, anchor: this.anchor.capability,
      kids: this.children?.length ?? -1,
      pts: this.points?.visible ?? null,
      ptsMat: this.pmat?.type ?? null,
      card: this.spatial?.card?.visible ?? null,
      cardParent: !!this.spatial?.card?.parent,
      bloom: !!this.bloom, selN: this._selN || 0, selEnd: this._selEnd || 0, selUI: !!this._selUI,
    });
  }

  onGesture(detail, start) {
    const n = detail.name;
    if (n === 'pinch') {
      if (start) { this.pinchHeld = true; this.charge = Math.max(this.charge, 0.2); }
      else { this.pinchHeld = false; this.fire(1 + this.charge); this.charge = 0; }
    } else if (n === 'open-palm') {
      start ? this.fx.add('repel') : this.fx.delete('repel');
    } else if (n === 'fist') {
      start ? this.fx.add('attract') : this.fx.delete('attract');
    } else if (n === 'spread') {
      start ? this.fx.add('stretch') : this.fx.delete('stretch');
    }
  }

  onSelectStart(event) {
    this._selN = (this._selN || 0) + 1;
    this._selUI = !!event?.target?.isUI;
    if (event?.target?.isUI) return; // клик по пространственной панели — не импульс
    this.touchHeld = true;
    this.charge = Math.max(this.charge, 0.2);
  }

  onSelectEnd(event) {
    this._selEnd = (this._selEnd || 0) + 1;
    if (event?.target?.isUI) return;
    this.touchHeld = false;
    if (this.pinchHeld) return; // отпустит gestureend, не дублируем
    this.fire(1 + this.charge);
    this.charge = 0;
  }

  emitter() {
    this._fromController = false;
    try {
      xb.user.getControllerPosition(0, this._o);
      const r = xb.user.getRay(0, new THREE.Ray());
      if (r && r.direction.lengthSq() > 0.5) { this._d.copy(r.direction); this._fromController = true; return true; }
    } catch { /* fallback ниже */ }
    xb.core.camera.getWorldPosition(this._o);
    xb.core.camera.getWorldDirection(this._d);
    return true;
  }

  /** Визуальное «дуло»: чуть вправо-вниз от камеры, иначе луч из глаза
   *  вырождается на экране в точку (камера смотрит вдоль него). */
  muzzleOrigin(o, d) {
    if (this._fromController) return o.clone();
    const right = new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 1, 0)).normalize();
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    return o.clone().addScaledVector(right, 0.14).add(new THREE.Vector3(0, -0.1, 0));
  }

  fire(power = 1) {
    const now = performance.now() / 1000;
    if (now - this.lastFire < FIRE_DEDUPE) return;
    this.lastFire = now;
    this.fired++;

    this.emitter();
    // Луч в мировых координатах; root может быть смещён якорем.
    this.root.updateMatrixWorld();
    const o = this._o.clone();
    const d = this._d.clone().normalize();
    const dm = this.depthMesh;
    const targets = dm ? [dm] : [this.floor, this.roomMesh];
    this.raycaster.set(o, d);
    const hits = this.raycaster.intersectObjects(targets, false);
    const kickOrigin = o.clone().addScaledVector(d, 0.4);

    const missPoint = o.clone().addScaledVector(d, 3.2);
    let hit = null;
    if (hits.length) {
      hit = hits[0];
      this._h.copy(hit.point);
      if (hit.face?.normal) this._n.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
      else this._n.copy(d).negate();
      this.spawnRing(this._h, this._n);
      this.spawnFlash(this._h);
      this.waves.push({ x: this._h.x, y: this._h.y, z: this._h.z, r: 0.05, speed: this.dream ? 1.1 : 1.6 });
      if (this.waves.length > 6) this.waves.shift();
      if (this.debug) {
        this.normalMark.position.copy(this._h);
        this.normalMark.setDirection(this._n);
        this.normalMark.userData.hasHit = true;
        this.normalMark.visible = true;
      }
    } else {
      // Диссипация в пустоте всё равно должна читаться: компактная фронтальная
      // волна, а не огромный экранный круг.
      this._n.copy(d).negate();
      this.spawnRing(missPoint, this._n);
      this.spawnFlash(missPoint);
      this.waves.push({ x: missPoint.x, y: missPoint.y, z: missPoint.z, r: 0.05, speed: 1.2 });
      if (this.waves.length > 6) this.waves.shift();
    }
    this.spawnBeam(this.muzzleOrigin(o, d), hit ? hit.point : missPoint);
    this.kick(kickOrigin, d, power, hit ? hit.point : null);
    this.stat();
  }

  kick(origin, dir, power, stopAt) {
    const p = this.pgeo.attributes.position.array;
    const rootP = this.root.position;
    const maxD = stopAt ? origin.distanceTo(stopAt) : 4;
    for (let i = 0; i < COUNT; i++) {
      const ix = i * 3;
      const px = p[ix] + rootP.x - origin.x;
      const py = p[ix + 1] + rootP.y - origin.y;
      const pz = p[ix + 2] + rootP.z - origin.z;
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
    const ring = this.rings.find((r) => r.t >= RING_DUR) || this.rings[0];
    ring.t = 0;
    ring.mesh.visible = true;
    ring.mesh.position.copy(point).addScaledVector(normal, 0.006); // чуть над поверхностью
    ring.mesh.lookAt(this._v.copy(point).add(normal));
    ring.mesh.scale.setScalar(0.12);
  }
  spawnFlash(point) {
    this.glints.spawn(point, 0.58);
    this.bursts.spawn(point, 0.72);
  }

  spawnBeam(from, to) {
    const beam = this.beams.find((b) => b.t >= BEAM_DUR) || this.beams[0];
    beam.t = 0;
    beam.material.uniforms.uLife.value = 0;
    beam.mesh.visible = true;
    beam.mesh.position.copy(from);
    const dir = this._v.copy(to).sub(from);
    const len = dir.length() || 0.01;
    beam.mesh.quaternion.setFromUnitVectors(this._up, dir.normalize());
    beam.mesh.scale.set(1, len, 1);
  }

  update() {
    const dt = Math.min(xb.getDeltaTime(), 0.05);
    this.fpsTick(dt);

    // Командный канал для ?test=1 / внешних harness'ов: DOM общий для всех
    // миров изолированных контекстов. Пример: dataset.rfCmd='fire'.
    const cmd = document.documentElement.dataset.rfCmd;
    if (cmd) {
      delete document.documentElement.dataset.rfCmd;
      try {
        if (cmd === 'fire') { this.emitter(); this.fire(1.4); }
        else if (cmd === 'debug') this.setDebug(!this.debug);
        else if (cmd === 'dream') this.setDream(!this.dream);
        else if (cmd === 'probe') {
          const b = this.beams[0];
          const wp = new THREE.Vector3();
          b.mesh.getWorldPosition(wp);
          document.documentElement.dataset.rfFx = JSON.stringify({
            beamVis: b.mesh.visible,
            beamPos: wp.toArray(),
            beamScale: b.mesh.scale.toArray(),
            beamLife: b.material.uniforms.uLife.value,
            glintVis: this.glints.group.children.map((c) => c.visible),
            drawCalls: xb.core.renderer.info.render.calls,
            triangles: xb.core.renderer.info.render.triangles,
          });
        }
        delete document.documentElement.dataset.rfCmdErr;
      } catch (e) {
        document.documentElement.dataset.rfCmdErr = (e && e.message) || String(e);
      }
    }

    // Якорь: создаём один раз, когда подсистема готова, и следуем за ним.
    if (!this.anchor.active && !this.anchor._pending && this.anchor.capability !== 'unsupported') {
      this.anchor.create(this.root);
    }
    this.anchor.follow(this.root);

    if (this.pinchHeld || this.touchHeld) this.charge = Math.min(2.5, this.charge + dt * 1.5);

    this.emitter();
    const ex = this._o.x, ey = this._o.y, ez = this._o.z;

    const p = this.pgeo.attributes.position.array;
    const colA = this.pgeo.attributes.aColor.array;
    const dreamK = this.dream ? 0.4 : 1.0;

    for (const w of this.waves) w.r += w.speed * dt;
    this.waves = this.waves.filter((w) => w.r < 4);

    const repel = this.fx.has('repel') ? 1 : 0;
    const attract = this.fx.has('attract') ? 1 : 0;
    const stretch = this.fx.has('stretch') ? 1 : 0;
    const rootP = this.root.position;
    // волны и эффекты ладони живут в мировых координатах — пересчитываем эмиттер в локальные
    const lx = ex - rootP.x, ly = ey - rootP.y, lz = ez - rootP.z;

    for (let i = 0; i < COUNT; i++) {
      const ix = i * 3;
      let x = p[ix], y = p[ix + 1], z = p[ix + 2];
      let vx = this.vel[ix], vy = this.vel[ix + 1], vz = this.vel[ix + 2];

      vx += (this.home[ix] - x) * 0.6 * dt * dreamK;
      vy += (this.home[ix + 1] - y) * 0.6 * dt * dreamK;
      vz += (this.home[ix + 2] - z) * 0.6 * dt * dreamK;
      vx *= 1 - 1.6 * dt; vy *= 1 - 1.6 * dt; vz *= 1 - 1.6 * dt;

      for (const w of this.waves) {
        const dx = x - (w.x - rootP.x), dy = y - (w.y - rootP.y), dz = z - (w.z - rootP.z);
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-4;
        const band = Math.abs(dist - w.r);
        if (band < 0.18) {
          const f = (1 - band / 0.18) * 3.2 * dt;
          vx += (dx / dist) * f; vy += (dy / dist) * f; vz += (dz / dist) * f;
        }
      }

      if (repel || attract) {
        const dx = x - lx, dy = y - ly, dz = z - lz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 2.25 && d2 > 1e-6) {
          const dist = Math.sqrt(d2);
          const f = (repel - attract) * 2.4 * dt / (dist + 0.2);
          vx += (dx / dist) * f * 2; vy += (dy / dist) * f * 2; vz += (dz / dist) * f * 2;
        }
      }
      if (stretch) { vx += (x - ROOM_C.x) * 0.8 * dt; vz += (z - ROOM_C.z) * 0.8 * dt; }

      x += vx * dt * 8; y += vy * dt * 8; z += vz * dt * 8;

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

      let glow = 0;
      for (const w of this.waves) {
        const dx = x - (w.x - rootP.x), dy = y - (w.y - rootP.y), dz = z - (w.z - rootP.z);
        if (Math.abs(Math.sqrt(dx * dx + dy * dy + dz * dz) - w.r) < 0.12) { glow = 1; break; }
      }
      colA[ix] = this.homeCol[ix] + glow * 0.6;
      colA[ix + 1] = this.homeCol[ix + 1] + glow * 0.6;
      colA[ix + 2] = this.homeCol[ix + 2] + glow * 0.6;
    }
    this.pgeo.attributes.position.needsUpdate = true;
    this.pgeo.attributes.aColor.needsUpdate = true;

    const t = xb.getElapsedTime?.() ?? performance.now() / 1000;
    tickMaterials(t, [this.pmat, ...this.rings.map((r) => r.mesh.material), ...this.beams.map((b) => b.material)]);
    for (let i = 0; i < this.flowMaterials.length; i++) {
      this.flowMaterials[i].opacity = 0.22 + 0.14 * (0.5 + 0.5 * Math.sin(t * 0.7 + i * 0.46));
    }
    this.glints.update(dt);
    this.bursts.update(dt);
    for (const r of this.rings) {
      if (r.t >= RING_DUR) { r.mesh.visible = false; continue; }
      r.t += dt;
      const k = Math.min(r.t / RING_DUR, 1);
      r.mesh.material.uniforms.uProgress.value = k;
      r.mesh.scale.setScalar(0.12 + k * RING_MAX);
    }
    for (const b of this.beams) {
      if (b.t >= BEAM_DUR) { b.mesh.visible = false; continue; }
      b.t += dt;
      b.material.uniforms.uLife.value = Math.min(b.t / BEAM_DUR, 1);
    }
    this.bloom?.sync();

    this._statT = (this._statT || 0) + dt;
    if (this._statT >= 0.5) { this._statT = 0; this.stat(); }
  }

  dispose() {
    const g = xb.core.gestureRecognition;
    g.removeEventListener('gesturestart', this._gs);
    g.removeEventListener('gestureend', this._ge);
    this.anchor.dispose();
    this.glints.dispose();
    this.bursts.dispose();
    this.pgeo.dispose();
    this.pmat.dispose();
    for (const line of this.fieldLines.children) {
      line.geometry.dispose();
      line.material.dispose();
    }
    delete window.__realityField;
  }
}

const options = baseOptions({
  title: 'REALITY//FIELD',
  description: 'Комната как физическое поле. Тап — импульс, удержание — заряд, жесты — поле.',
  depth: true,
  bloom: false,
});
options.enableHands();
options.controllers.visualizeRays = false;
options.enableGestures();
options.gestures.setGestureEnabled('spread', true);

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const script = new RealityField();
    xb.add(script);
    await xb.init(options);
    script.bloom = addBloom({ strength: 0.7, radius: 0.5, threshold: 0.68 });
    watchSession();
  } catch (e) {
    document.documentElement.dataset.rfInitErr = (e && e.message) || String(e);
    console.error('[RF] BOOT FAIL', e);
  }
});
