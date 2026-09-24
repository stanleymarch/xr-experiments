// CITY//ORBIT — условная схема города: компактная карта на столе и панорама
// демо-точек вокруг вас.
//
// Два честно разных вида, а не смена скорости вращения:
//  · ВИД: КАРТА — компактная схема ~0.9 м на столе, точки и подписи рядом.
//  · ВИД: 360° — те же точки разнесены по кольцу вокруг вас (~3.5 м), впереди
//    отметка «ВПЕРЕДИ», выбор доворачивает панораму к выбранному месту.
// Сама сцена не вращается: двигается только то, что двигает пользователь.
// Оформление — по референсу «светящаяся орбитальная карта»: тонкие световые
// пины с ярким наконечником, концентрические эллипсы и компактные чипы-подписи.
//
// SAMPLE_PLACES — захардкоженный демонстрационный набор условных точек.
// Это НЕ данные о местах рядом: ни метров, ни геолокации, ни живой карты.

import * as THREE from 'three';
import * as xb from 'xrblocks';
import {
  COLORS, baseOptions, createHud, watchSession, spatialControls,
  anchorRoot, fpsMeter,
} from '../common/shell.js';
import { glowBlending, hologramMaterial, tickMaterials } from '../common/shaders.js';
import { glowTexture, spritePool } from '../common/sprites.js';

// Условные категории, а не реальные названия: набор демонстрационный.
const SAMPLE_PLACES = [
  { name: 'ВЫ', self: true, x: 0, z: 0, h: 0.22, color: 0xff6b5e },
  { name: 'МУЗЕЙ', x: -0.48, z: 0.24, h: 0.55, color: 0x54d6ff },
  { name: 'УНИВЕР', x: 0.34, z: -0.4, h: 0.72, color: 0x8a7bff },
  { name: 'КАФЕ', x: 0.3, z: 0.2, h: 0.32, color: 0x54d6ff },
  { name: 'ПАМЯТНИК', x: -0.16, z: -0.58, h: 0.84, color: 0x54d6ff },
];
const TABLE_SPREAD = 0.86; // компактная схема: точки внутри ~0.4 м
const PANO_RADIUS = 1.75;  // панорама: кольцо точек радиусом ~1.75 м вокруг вас
const PANO_BASE = 0.62;    // высота кольца относительно роста пользователя

window.__CO_VER = 2;
document.documentElement.dataset.coVer = '2';

// Компактный чип как в референсе: тёмное стекло + моноширинный текст.
// Текстура в 2× разрешении, чтобы мелкий чип оставался чётким на телефоне.
const CHIP = { w: 0.28, h: 0.056 };

function labelSprite(text, color = '#d9f7ff') {
  const c = document.createElement('canvas');
  c.width = 640; c.height = 128;
  const x = c.getContext('2d');
  x.clearRect(0, 0, c.width, c.height);
  x.fillStyle = 'rgba(6,10,20,0.78)';
  x.beginPath(); x.roundRect(10, 10, 620, 108, 26); x.fill();
  x.strokeStyle = 'rgba(120,190,230,0.28)'; x.lineWidth = 2;
  x.beginPath(); x.roundRect(10, 10, 620, 108, 26); x.stroke();
  x.font = '600 68px ui-monospace, monospace';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.shadowColor = color; x.shadowBlur = 12;
  x.fillStyle = color; x.fillText(text, c.width / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false });
  const s = new THREE.Sprite(mat);
  s.scale.set(CHIP.w, CHIP.h, 1);
  s.userData.dispose = () => { tex.dispose(); mat.dispose(); };
  return s;
}

// Тонкий световой пин: почти невидимая у основания и яркая к наконечнику.
function stemMesh(height, color) {
  const g = new THREE.CylinderGeometry(0.0026, 0.0042, height, 6, 1, true);
  const pos = g.getAttribute('position');
  const cols = new Float32Array(pos.count * 3);
  const bright = new THREE.Color(color);
  const dim = new THREE.Color(color).multiplyScalar(0.12);
  const mix = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, pos.getY(i) / height + 0.5)); // 0 — основание, 1 — верх
    mix.copy(dim).lerp(bright, t * t);
    cols.set([mix.r, mix.g, mix.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  const m = glowBlending(new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
    depthWrite: false,
  }));
  const mesh = new THREE.Mesh(g, m);
  mesh.position.y = height / 2;
  return mesh;
}

function ellipseLine(rx, rz, color, opacity = 0.5) {
  const p = [];
  for (let i = 0; i <= 128; i++) {
    const a = i / 128 * Math.PI * 2;
    p.push(new THREE.Vector3(Math.cos(a) * rx, 0, Math.sin(a) * rz));
  }
  const g = new THREE.BufferGeometry().setFromPoints(p);
  const m = glowBlending(new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
  return new THREE.Line(g, m);
}

class CityOrbit extends xb.Script {
  init() {
    try { this._init(); }
    catch (e) {
      document.documentElement.dataset.coInitErr = (e && e.message) || String(e);
      console.error('[CO] INIT FAIL', e); throw e;
    }
  }

  _init() {
    this.add(new THREE.HemisphereLight(0xffffff, 0x182048, 1.5));
    const rim = new THREE.PointLight(0x54d6ff, 5, 4);
    rim.position.set(-1, 2.4, 1.2); this.add(rim);

    this.root = new THREE.Group();
    this.root.name = 'city-orbit-root';
    this.root.position.set(0, 0.78, -1.35);
    this.add(this.root);
    this.anchor = anchorRoot();

    this.sculpture = new THREE.Group();
    this.root.add(this.sculpture);

    // Материалы обоих видов: перекрёстно гасим их при переходе вид↔вид.
    this.plateFade = [];
    this.panoFade = [];
    const fade = (list, mat, base) => { list.push({ mat, base }); mat.opacity = base; };

    // --- ВИД: КАРТА — компактная схема на столе ---
    this.plate = new THREE.Group();
    this.plate.scale.setScalar(0.42); // стол ~0.9 м в диаметре
    this.sculpture.add(this.plate);
    this.orbits = [];
    for (let i = 0; i < 9; i++) {
      const r = 0.18 + i * 0.105;
      const base = 0.16 + i * 0.03;
      const o = ellipseLine(r, r * (0.58 + i * 0.025), i % 3 === 2 ? COLORS.violet : COLORS.accent, base);
      o.rotation.y = i * 0.21;
      o.rotation.x = (i - 4) * 0.045;
      this.plate.add(o); this.orbits.push(o);
      fade(this.plateFade, o.material, base);
    }

    const count = 380;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const band = i % 12;
      const a = Math.random() * Math.PI * 2;
      const r = 0.13 + band * 0.065 + (Math.random() - 0.5) * 0.025;
      pos.set([Math.cos(a) * r, 0.018 + Math.random() * 0.11 + Math.abs(Math.sin(a * 3)) * 0.035, Math.sin(a) * r * (0.58 + band * 0.018)], i * 3);
      c.set(i % 7 === 0 ? COLORS.violet : COLORS.accent);
      col.set([c.r, c.g, c.b], i * 3);
    }
    const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    pg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const pm = glowBlending(new THREE.PointsMaterial({ size: 0.03, vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: true }));
    this.cityPoints = new THREE.Points(pg, pm); this.plate.add(this.cityPoints);
    fade(this.plateFade, pm, 0.82);

    const table = new THREE.Mesh(
      new THREE.CircleGeometry(1.03, 96),
      new THREE.MeshBasicMaterial({ color: 0x081523, transparent: true, depthWrite: false, side: THREE.DoubleSide })
    );
    table.rotation.x = -Math.PI / 2; table.position.y = -0.008;
    this.plate.add(table);
    fade(this.plateFade, table.material, 0.22);

    const plateTitle = labelSprite('ДЕМО-СХЕМА', '#9fe9ff');
    plateTitle.position.set(0, 0.03, 0.5);
    this.sculpture.add(plateTitle);
    fade(this.plateFade, plateTitle.material, 0.8);

    // --- ВИД: 360° — панорама демо-точек вокруг вас ---
    this.pano = new THREE.Group();
    this.sculpture.add(this.pano);

    const horizon = ellipseLine(PANO_RADIUS, PANO_RADIUS, COLORS.accent, 0.32);
    this.pano.add(horizon); fade(this.panoFade, horizon.material, 0.32);

    const tickPos = [];
    for (let i = 0; i < 36; i++) {
      const a = i / 36 * Math.PI * 2;
      const r0 = PANO_RADIUS - (i % 9 === 0 ? 0.22 : 0.1);
      tickPos.push(Math.sin(a) * r0, 0, -Math.cos(a) * r0, Math.sin(a) * PANO_RADIUS, 0, -Math.cos(a) * PANO_RADIUS);
    }
    const tickMat = glowBlending(new THREE.LineBasicMaterial({ color: COLORS.violet, transparent: true, depthWrite: false }));
    this.pano.add(new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(tickPos, 3)), tickMat
    ));
    fade(this.panoFade, tickMat, 0.4);

    // Занавес точек по кольцу — объём панорамы, а не одна линия.
    const cCount = 260;
    const cPts = new Float32Array(cCount * 3);
    const cCols = new Float32Array(cCount * 3);
    for (let i = 0; i < cCount; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = PANO_RADIUS + (Math.random() - 0.5) * 0.16;
      cPts.set([Math.sin(a) * r, -0.34 + Math.random() * 1.1, -Math.cos(a) * r], i * 3);
      c.set(i % 5 === 0 ? COLORS.violet : COLORS.accent);
      cCols.set([c.r, c.g, c.b], i * 3);
    }
    const cm = glowBlending(new THREE.PointsMaterial({ size: 0.022, vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: true }));
    this.pano.add(new THREE.Points(
      new THREE.BufferGeometry()
        .setAttribute('position', new THREE.BufferAttribute(cPts, 3))
        .setAttribute('color', new THREE.BufferAttribute(cCols, 3)),
      cm
    ));
    fade(this.panoFade, cm, 0.55);

    const front = labelSprite('ВПЕРЕДИ', '#9fe9ff');
    front.position.set(0, 0.5, -PANO_RADIUS);
    this.pano.add(front); fade(this.panoFade, front.material, 0.85);

    const panoTitle = labelSprite('ДЕМО-ТОЧКИ', '#9fe9ff');
    panoTitle.position.set(0, 1.3, -0.45);
    panoTitle.scale.set(CHIP.w * 1.3, CHIP.h * 1.3, 1);
    this.pano.add(panoTitle); fade(this.panoFade, panoTitle.material, 0.8);

    // --- Точки мест: общий риг, который доворачивает панораму к выбору ---
    this.rig = new THREE.Group();
    this.sculpture.add(this.rig);
    this.nodes = [];
    this.mats = [];
    for (const [i, data] of SAMPLE_PLACES.entries()) {
      const group = new THREE.Group();
      // Метка выбора — на группе: тап по пину, гало, наконечнику, шару
      // или чипу резолвится в точку при подъёме по родителям.
      group.userData.landmark = i;
      const stem = stemMesh(data.h, data.color);
      const mat = hologramMaterial({ color: data.color, rim: data.self ? COLORS.coral : COLORS.violet, opacity: 0.9 });
      const node = new THREE.Mesh(new THREE.IcosahedronGeometry(data.self ? 0.045 : 0.064, 2), mat);
      node.position.y = data.h;
      const halo = new THREE.Sprite(glowBlending(new THREE.SpriteMaterial({ map: glowTexture({ core: 0.1 }), color: data.color, transparent: true, opacity: 0.75, depthWrite: false })));
      halo.position.y = data.h; halo.scale.setScalar(data.self ? 0.16 : 0.22);
      // Яркий наконечник пина — то, что читается как «световая точка» издалека.
      const tip = new THREE.Sprite(glowBlending(new THREE.SpriteMaterial({ map: glowTexture({ core: 0.38, gamma: 1.5 }), color: data.color, transparent: true, opacity: 0.95, depthWrite: false })));
      tip.position.y = data.h; tip.scale.setScalar(data.self ? 0.045 : 0.055);
      const label = labelSprite(data.name, data.self ? '#ff8d80' : '#d9f7ff');
      label.position.set(0, data.h + 0.09, 0);
      group.add(stem, halo, tip, node, label);
      this.rig.add(group);
      this.mats.push(mat);
      this.nodes.push({
        data, group, node, halo, tip, label, mat,
        tablePos: new THREE.Vector3(data.x * TABLE_SPREAD, 0, data.z * TABLE_SPREAD),
        panoPos: new THREE.Vector3(), panoYaw: 0,
      });
    }
    // «ВЫ» в панораме — центр кольца (вы и есть точка отсчёта).
    const ring = this.nodes.filter((n) => !n.data.self);
    ring.forEach((n, k) => {
      const a = k / ring.length * Math.PI * 2;
      n.panoYaw = a;
      n.panoPos.set(Math.sin(a) * PANO_RADIUS, 0, -Math.cos(a) * PANO_RADIUS);
    });
    for (const n of this.nodes) if (n.data.self) { n.panoPos.set(0, 0, 0); n.panoYaw = 0; }

    // Маленькая цветная вспышка выбора (не белый глинт на полсцены).
    this.glints = spritePool(glowTexture({ core: 0.16 }), { count: 6, dur: 0.5, grow: 1.3, color: 0xff8d80 });
    this.rig.add(this.glints.group);

    this.mode360 = false;
    this.blend = 0;       // 0 — карта на столе, 1 — панорама вокруг вас
    this.rigYaw = 0;      // текущий доворот панорамы
    this.selected = 1;
    this.missT = 0;
    this._v = new THREE.Vector3();
    this._g = new THREE.Vector3();

    const toggleView = () => this.setMode(!this.mode360);
    const nextPlace = () => this.nextPlace();
    this.hud = createHud({
      title: 'CITY//ORBIT',
      controls: [
        { id: 'mode', label: 'ВИД: КАРТА', onClick: toggleView },
        { id: 'next', label: 'ДАЛЬШЕ ▸', onClick: nextPlace },
      ],
      hint: 'тап по точке — выбрать место · ДАЛЬШЕ — следующее место · ВИД — компактная карта на столе или панорама вокруг вас · spread — сменить вид',
    });
    this.spatial = spatialControls({
      title: 'CITY//ORBIT', status: '…',
      controls: [
        { id: 'mode', label: 'ВИД: КАРТА', onClick: toggleView },
        { id: 'next', label: 'ДАЛЬШЕ', onClick: nextPlace },
      ], width: 0.72,
    });
    this.spatial.card.position.set(0.86, 1.42, -1.28);
    this.add(this.spatial.card);

    // spread — раскрыть/свернуть вид (никакого масштаба в метрах).
    // gestureRecognition существует только при включённом hand-tracking:
    // на телефоне его нет, и это норма (тап и ДАЛЬШЕ остаются).
    const g = xb.core.gestureRecognition;
    if (g) {
      this._gs = (e) => { if (e.detail.name === 'spread') toggleView(); };
      g.addEventListener('gesturestart', this._gs);
    }

    this.fpsTick = fpsMeter((fps) => { this.fps = fps; }); this.fps = 0;
    this.selectNode(1);
    this.refreshControls();
    this.stat();
    window.__cityOrbit = this;
  }

  /** Индексы, доступные для выбора в текущем виде. */
  selectable() {
    const ids = [];
    for (let i = 0; i < this.nodes.length; i++) if (!(this.mode360 && this.nodes[i].data.self)) ids.push(i);
    return ids;
  }

  setMode(on) {
    this.mode360 = !!on;
    if (this.mode360 && this.nodes[this.selected]?.data.self) this.selectNode(this.selectable()[0]);
    this.refreshControls();
    this.stat();
  }

  nextPlace() {
    const ids = this.selectable();
    const k = Math.max(0, ids.indexOf(this.selected));
    this.selectNode(ids[(k + 1) % ids.length]);
  }

  refreshControls() {
    const label = this.mode360 ? 'ВИД: 360°' : 'ВИД: КАРТА';
    this.hud.setLabel('mode', label);
    this.spatial.setLabel('mode', label);
    this.hud.setToggle('mode', this.mode360);
    this.spatial.setToggle('mode', this.mode360);
  }

  selectNode(i) {
    const idx = (i + this.nodes.length) % this.nodes.length;
    if (this.mode360 && this.nodes[idx].data.self) return; // в панораме «ВЫ» — центр, а не выбор
    this.selected = idx;
    for (let n = 0; n < this.nodes.length; n++) {
      const on = n === this.selected;
      this.nodes[n].mat.uniforms.uSelected.value = on ? 1 : 0;
      this.nodes[n].halo.material.color.set(on ? COLORS.coral : this.nodes[n].data.color);
      this.nodes[n].tip.material.color.set(on ? COLORS.coral : this.nodes[n].data.color);
    }
    const x = this.nodes[this.selected];
    this.glints.spawn(this._g.set(x.group.position.x, x.data.h, x.group.position.z), 0.12);
    this.stat();
  }

  stat() {
    const n = this.nodes[this.selected].data;
    const view = this.mode360 ? 'ПАНОРАМА 360°' : 'КАРТА НА СТОЛЕ';
    const look = this.mode360 ? ' · осмотритесь: точки вокруг вас' : '';
    const miss = this.missT > 0 ? ' · мимо: тапните по точке или ДАЛЬШЕ' : '';
    this.hud.setStatus(`${view} · ВЫБРАНО: ${n.name} · демо-точки${look} · ${this.fps || '—'} FPS${miss}`);
    this.spatial.setStatus(`${n.name} · демо-точка\n${this.mode360 ? 'панорама: точки вокруг вас' : 'компактная схема на столе'}`);
    document.documentElement.dataset.coState = JSON.stringify({
      fps: this.fps, mode: this.mode360 ? '360' : 'table', view,
      selected: n.name, selectedIndex: this.selected,
      places: SAMPLE_PLACES.map((p) => p.name), demo: true, nodes: this.nodes.length,
      anchor: this.anchor.capability,
    });
  }

  onSelectEnd(event) {
    // Тап по пространственной кнопке не должен стрелять и в сцену под ней:
    // global-хуки получают select даже после семантического UI-контрола.
    if (this.spatial.owns(event?.target)) return;
    // Метка — на группе точки (stem/halo/tip/node/label наследуют её при
    // подъёме по родителям). Резолвим из зафиксированного surface пайплайна:
    // intersection на отпускании может отсутствовать при дрожании луча.
    let obj = event?.surface ?? event?.target ?? event?.intersection?.object;
    while (obj && obj.userData?.landmark == null) obj = obj.parent;
    if (obj?.userData?.landmark == null) {
      // Промах ничего не меняет — никакого «любой тап выбирает следующее».
      this.missT = 1.8;
      this.stat();
      return;
    }
    this.selectNode(obj.userData.landmark);
  }

  update() {
    const dt = Math.min(xb.getDeltaTime(), 0.05); this.fpsTick(dt);
    const cmd = document.documentElement.dataset.coCmd;
    if (cmd) {
      delete document.documentElement.dataset.coCmd;
      if (cmd === 'next') this.nextPlace();
      else if (cmd === 'mode') this.setMode(!this.mode360);
    }
    if (!this.anchor.active && !this.anchor._pending && this.anchor.capability !== 'unsupported') this.anchor.create(this.root);
    this.anchor.follow(this.root);

    const t = xb.getElapsedTime?.() ?? performance.now() / 1000;
    const k = 1 - Math.exp(-dt * 6);

    // Переход вид↔вид: гасим материалы схемы, проявляем материалы панорамы.
    this.blend += ((this.mode360 ? 1 : 0) - this.blend) * k;
    for (const e of this.plateFade) e.mat.opacity = e.base * (1 - this.blend);
    for (const e of this.panoFade) e.mat.opacity = e.base * this.blend;
    this.plate.visible = this.blend < 0.99;
    this.pano.visible = this.blend > 0.01;

    // Панорама центрируется на вас, схема остаётся над столом.
    // Центр берём из живой позы камеры каждый кадр: после шага/поворота
    // кольцо остаётся вокруг вас, а не вокруг точки старта сессии.
    if (this.mode360 || this.blend > 0.01) {
      xb.core.camera.getWorldPosition(this._v);
      this._v.y = xb.user.height * PANO_BASE;
      this.root.worldToLocal(this._v);
    } else this._v.set(0, 0, 0);
    this.sculpture.position.lerp(this._v, k);

    // Доворот панорамы: выбранное место встаёт вперёд. Карта не доворачивается.
    const wantYaw = this.mode360 ? this.nodes[this.selected].panoYaw : 0;
    let d = wantYaw - this.rigYaw;
    d = ((d + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    this.rigYaw += d * k;
    this.rig.rotation.y = this.rigYaw;

    // Панорама ближе к глазам, чем стол, — поэтому рост умеренный: чип
    // остаётся компактным (≤0.34 м), гало не заливает пол-экрана.
    const nodeScale = 1 + this.blend * 0.3;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      const tp = n.tablePos, pp = n.panoPos;
      n.group.position.set(
        tp.x + (pp.x - tp.x) * this.blend,
        tp.y + (pp.y - tp.y) * this.blend,
        tp.z + (pp.z - tp.z) * this.blend
      );
      const selfFade = n.data.self ? Math.max(0, 1 - this.blend) : 1;
      if (n.data.self) {
        n.group.visible = selfFade > 0.02;
        n.group.scale.setScalar(Math.max(0.02, selfFade));
      }
      const on = i === this.selected;
      const s = nodeScale * (on ? 1.2 : 1);
      n.node.scale.setScalar(s);
      n.node.rotation.y += dt * (0.35 + i * 0.07);
      n.halo.scale.setScalar(Math.min(0.3, (n.data.self ? 0.16 : 0.22) * nodeScale * (on ? 1.2 : 1)));
      n.halo.material.opacity = (0.42 + 0.28 * Math.sin(t * 1.4 + i)) * selfFade;
      const tipBase = n.data.self ? 0.045 : 0.055;
      n.tip.scale.setScalar(tipBase * nodeScale * (on ? 1.2 : 1));
      n.tip.material.opacity = (0.72 + 0.22 * Math.sin(t * 2.1 + i * 1.7)) * selfFade;
      const chip = (1 + this.blend * 0.1) * (on ? 1.2 : 1);
      n.label.scale.set(CHIP.w * chip, CHIP.h * chip, 1);
      n.label.material.opacity = (on ? 1 : 0.78) * selfFade;
    }

    tickMaterials(t, this.mats);
    this.glints.update(dt);
    this.missT = Math.max(0, this.missT - dt);
    this._statT = (this._statT || 0) + dt;
    if (this._statT > 0.5) { this._statT = 0; this.stat(); }
  }

  dispose() {
    xb.core.gestureRecognition?.removeEventListener('gesturestart', this._gs);
    this.anchor.dispose(); this.glints.dispose();
    this.sculpture.traverse((o) => { o.geometry?.dispose?.(); if (o.material && !o.isSprite) o.material.dispose?.(); o.userData?.dispose?.(); });
    for (const n of this.nodes) { n.halo.material.dispose(); n.tip.material.dispose(); }
    delete window.__cityOrbit;
  }
}

const options = baseOptions({
  title: 'CITY//ORBIT',
  description: 'Условная схема города: компактная демо-карта на столе и панорама демо-точек вокруг вас. Тап — выбор, ДАЛЬШЕ — следующее место, ВИД — сменить вид.',
  bloom: false,
});
options.enableHands();
options.controllers.visualizeRays = false;
options.enableGestures();
options.gestures.setGestureEnabled('spread', true);

document.addEventListener('DOMContentLoaded', async () => {
  try { const script = new CityOrbit(); xb.add(script); await xb.init(options); watchSession(); }
  catch (e) { document.documentElement.dataset.coInitErr = (e && e.message) || String(e); console.error('[CO] BOOT FAIL', e); }
});
