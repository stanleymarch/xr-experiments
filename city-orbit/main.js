// CITY//ORBIT — город как абстрактная орбитальная карта над столом.
// Узлы — не мини-здания, а данные: световые точки, вертикальные стемы,
// эллиптические орбиты, плотность и расстояния. Тап выбирает место; spread
// меняет масштаб; TABLE/360 переключает спокойную модель и окружающий атлас.

import * as THREE from 'three';
import * as xb from 'xrblocks';
import {
  COLORS, baseOptions, createHud, watchSession, spatialControls,
  anchorRoot, fpsMeter,
} from '../common/shell.js';
import { hologramMaterial, tickMaterials } from '../common/shaders.js';
import { glowTexture, starTexture, spritePool } from '../common/sprites.js';

const LANDMARKS = [
  { name: 'YOU', distance: 0, x: 0, z: 0, h: 0.22, color: 0xff6b5e },
  { name: 'Kunstkamera', distance: 430, x: -0.48, z: 0.24, h: 0.55, color: 0x54d6ff },
  { name: 'ITMO', distance: 760, x: 0.34, z: -0.4, h: 0.72, color: 0x8a7bff },
  { name: 'CAFÉ', distance: 210, x: 0.3, z: 0.2, h: 0.32, color: 0x54d6ff },
  { name: 'Monument', distance: 1100, x: -0.16, z: -0.58, h: 0.84, color: 0x54d6ff },
];
const SCALE_LABELS = ['200 m', '1 km', '5 km'];

window.__CO_VER = 1;
document.documentElement.dataset.coVer = '1';

function labelSprite(text, color = '#d9f7ff') {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 96;
  const x = c.getContext('2d');
  x.clearRect(0, 0, c.width, c.height);
  x.fillStyle = 'rgba(4,8,18,0.72)';
  x.beginPath(); x.roundRect(72, 7, 368, 82, 20); x.fill();
  x.font = '650 48px ui-monospace, monospace';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.shadowColor = color; x.shadowBlur = 14;
  x.fillStyle = color; x.fillText(text, c.width / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false });
  const s = new THREE.Sprite(mat);
  s.scale.set(0.56, 0.105, 1);
  s.userData.dispose = () => { tex.dispose(); mat.dispose(); };
  return s;
}

function ellipseLine(rx, rz, color, opacity = 0.5) {
  const p = [];
  for (let i = 0; i <= 128; i++) {
    const a = i / 128 * Math.PI * 2;
    p.push(new THREE.Vector3(Math.cos(a) * rx, 0, Math.sin(a) * rz));
  }
  const g = new THREE.BufferGeometry().setFromPoints(p);
  const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
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

    // Подложка — тонкие концентрические измерительные орбиты.
    this.orbits = [];
    for (let i = 0; i < 9; i++) {
      const r = 0.18 + i * 0.105;
      const o = ellipseLine(r, r * (0.58 + i * 0.025), i % 3 === 2 ? COLORS.violet : COLORS.accent, 0.16 + i * 0.03);
      o.rotation.y = i * 0.21;
      o.rotation.x = (i - 4) * 0.045;
      this.sculpture.add(o); this.orbits.push(o);
    }

    // Городское поле: 380 точек на эллиптических потоках.
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
    const pm = new THREE.PointsMaterial({ size: 0.014, vertexColors: true, transparent: true, opacity: 0.82, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
    this.cityPoints = new THREE.Points(pg, pm); this.sculpture.add(this.cityPoints);

    // Вертикальные узлы и подписи мест.
    this.nodes = [];
    for (const [i, data] of LANDMARKS.entries()) {
      const group = new THREE.Group();
      group.position.set(data.x, 0, data.z);
      const stem = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, data.h, 0)]),
        new THREE.LineBasicMaterial({ color: data.color, transparent: true, opacity: 0.72, blending: THREE.AdditiveBlending })
      );
      const mat = hologramMaterial({ color: data.color, rim: i === 0 ? COLORS.coral : COLORS.violet, opacity: 0.9 });
      const node = new THREE.Mesh(new THREE.IcosahedronGeometry(i === 0 ? 0.045 : 0.064, 2), mat);
      node.position.y = data.h;
      node.userData.landmark = i;
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture({ core: 0.1 }), color: data.color, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false }));
      halo.position.y = data.h; halo.scale.setScalar(i === 0 ? 0.16 : 0.22);
      const label = labelSprite(data.name, i === 0 ? '#ff8d80' : '#d9f7ff');
      label.position.set(0, data.h + 0.11, 0); label.userData.landmark = i;
      group.add(stem, halo, node, label);
      this.sculpture.add(group);
      this.nodes.push({ data, group, stem, node, halo, label, mat });
    }

    // Стеклянная плоскость стола с полярной сеткой.
    const table = new THREE.Mesh(
      new THREE.CircleGeometry(1.03, 96),
      new THREE.MeshBasicMaterial({ color: 0x081523, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide })
    );
    table.rotation.x = -Math.PI / 2; table.position.y = -0.008;
    this.sculpture.add(table);

    this.glints = spritePool(starTexture({ rays: 6 }), { count: 8, dur: 0.9, grow: 1.8, color: 0xff8d80 });
    this.sculpture.add(this.glints.group);

    this.mode360 = false; this.scaleIndex = 1; this.selected = 1;

    const toggleMode = () => this.setMode(!this.mode360);
    const nextScale = () => this.setScale((this.scaleIndex + 1) % SCALE_LABELS.length);
    this.hud = createHud({
      title: 'CITY//ORBIT',
      controls: [
        { id: 'mode', label: 'TABLE MODE', onClick: toggleMode },
        { id: 'scale', label: 'SCALE 1 km', onClick: nextScale },
      ],
      hint: 'тап — выбрать место · spread — масштаб · TABLE/360 — композиция',
    });
    this.spatial = spatialControls({
      title: 'CITY//ORBIT', status: 'Kunstkamera · 430 m',
      controls: [
        { id: 'mode', label: 'TABLE / 360°', onClick: toggleMode },
        { id: 'scale', label: 'SCALE', onClick: nextScale },
      ], width: 0.66,
    });
    this.spatial.card.position.set(0.86, 1.42, -1.28);
    this.add(this.spatial.card);

    const g = xb.core.gestureRecognition;
    this._gs = (e) => { if (e.detail.name === 'spread') this.setScale(Math.min(2, this.scaleIndex + 1)); };
    this._ge = () => {};
    g.addEventListener('gesturestart', this._gs);
    g.addEventListener('gestureend', this._ge);

    this.fpsTick = fpsMeter((fps) => { this.fps = fps; }); this.fps = 0;
    this.raycaster = new THREE.Raycaster(); this._o = new THREE.Vector3(); this._d = new THREE.Vector3();
    this.selectNode(1);
    window.__cityOrbit = this;
  }

  setMode(on) {
    this.mode360 = on;
    this.hud.setToggle('mode', on);
    this.spatial.setToggle('mode', on);
    this.stat();
  }

  setScale(i) {
    this.scaleIndex = THREE.MathUtils.clamp(i, 0, 2);
    const k = [0.72, 1, 1.42][this.scaleIndex];
    this.sculpture.scale.setScalar(k);
    this.stat();
  }

  selectNode(i) {
    this.selected = (i + this.nodes.length) % this.nodes.length;
    for (let n = 0; n < this.nodes.length; n++) {
      const on = n === this.selected;
      this.nodes[n].mat.uniforms.uSelected.value = on ? 1 : 0;
      this.nodes[n].node.scale.setScalar(on ? 1.45 : 1);
      this.nodes[n].halo.material.color.set(on ? COLORS.coral : this.nodes[n].data.color);
      this.nodes[n].halo.scale.setScalar(on ? 0.3 : (n === 0 ? 0.16 : 0.2));
      this.nodes[n].label.material.opacity = on ? 1 : 0.78;
    }
    const x = this.nodes[this.selected];
    this.glints?.spawn(x.group.position.clone().add(new THREE.Vector3(0, x.data.h, 0)), 0.32);
    this.stat();
  }

  onSelectEnd(event) {
    if (event?.target?.isUI) return;
    let obj = event?.intersection?.object;
    while (obj && obj.userData?.landmark == null) obj = obj.parent;
    if (obj?.userData?.landmark != null) this.selectNode(obj.userData.landmark);
    else this.selectNode(this.selected + 1);
  }

  stat() {
    const n = this.nodes[this.selected]?.data ?? LANDMARKS[1];
    const d = n.distance ? `${n.distance} m` : 'here';
    const s = `${this.mode360 ? '360° MODE' : 'TABLE MODE'} · ${SCALE_LABELS[this.scaleIndex]} · ${n.name} · ${d} · FPS ${this.fps || '—'}`;
    this.hud.setStatus(s);
    this.spatial.setStatus(`${n.name} · ${d}\nSCALE ${SCALE_LABELS[this.scaleIndex]}`);
    document.documentElement.dataset.coState = JSON.stringify({
      fps: this.fps, mode: this.mode360 ? '360' : 'table', scale: SCALE_LABELS[this.scaleIndex],
      selected: n.name, distance: n.distance, nodes: this.nodes.length,
      anchor: this.anchor.capability,
    });
  }

  update() {
    const dt = Math.min(xb.getDeltaTime(), 0.05); this.fpsTick(dt);
    const cmd = document.documentElement.dataset.coCmd;
    if (cmd) {
      delete document.documentElement.dataset.coCmd;
      if (cmd === 'next') this.selectNode(this.selected + 1);
      else if (cmd === 'mode') this.setMode(!this.mode360);
      else if (cmd === 'scale') this.setScale((this.scaleIndex + 1) % 3);
    }
    if (!this.anchor.active && !this.anchor._pending && this.anchor.capability !== 'unsupported') this.anchor.create(this.root);
    this.anchor.follow(this.root);

    const t = xb.getElapsedTime?.() ?? performance.now() / 1000;
    this.sculpture.rotation.y += dt * (this.mode360 ? 0.12 : 0.025);
    for (let i = 0; i < this.orbits.length; i++) this.orbits[i].rotation.y += dt * (0.01 + i * 0.002);
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      n.node.rotation.y += dt * (0.35 + i * 0.07);
      n.halo.material.opacity = 0.42 + 0.28 * Math.sin(t * 1.4 + i);
    }
    tickMaterials(t, this.nodes.map((n) => n.mat));
    this.glints.update(dt);
    this._statT = (this._statT || 0) + dt;
    if (this._statT > 0.5) { this._statT = 0; this.stat(); }
  }

  dispose() {
    const g = xb.core.gestureRecognition;
    g.removeEventListener('gesturestart', this._gs); g.removeEventListener('gestureend', this._ge);
    this.anchor.dispose(); this.glints.dispose();
    this.sculpture.traverse((o) => { o.geometry?.dispose?.(); if (o.material && !o.isSprite) o.material.dispose?.(); o.userData?.dispose?.(); });
    delete window.__cityOrbit;
  }
}

const options = baseOptions({
  title: 'CITY//ORBIT',
  description: 'Город как орбитальная голограмма над столом. Тап — место, spread — масштаб, TABLE/360 — композиция.',
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
