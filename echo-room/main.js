// ECHO//ROOM — комната как луковица времени: предыдущее действие остаётся
// в пространстве как полупрозрачный слой-эхо и медленно тает.
// Оттенок = возраст: ледяной голубой (только что) → фиолетовый → коралл (старое).

import * as THREE from 'three';
import * as xb from 'xrblocks';
import {
  COLORS, baseOptions, createHud, watchSession, spatialControls,
  anchorRoot, fpsMeter,
} from '../common/shell.js';
import { glowBlending, softParticlesMaterial, particleAttributes, tickMaterials } from '../common/shaders.js';
import { glowTexture } from '../common/sprites.js';

// Возраст эха кодируем цветом на CPU: ice blue → violet → muted coral.
const AGE_STOPS = [
  { t: 0.0, c: new THREE.Color(0.62, 0.85, 1.0) },
  { t: 0.5, c: new THREE.Color(0.58, 0.48, 0.95) },
  { t: 1.0, c: new THREE.Color(0.94, 0.52, 0.45) },
];
function ageColor(k) {
  k = Math.min(0.999, Math.max(0, k));
  for (let i = 1; i < AGE_STOPS.length; i++) {
    const a = AGE_STOPS[i - 1], b = AGE_STOPS[i];
    if (k <= b.t) return a.c.clone().lerp(b.c, (k - a.t) / (b.t - a.t));
  }
  return AGE_STOPS.at(-1).c.clone();
}

const COUNT = 500;
const ROOM_R = 2.4;
const ECHO_LIFE = 4.5;
const MAX_ECHOES = 5;

window.__ER_VER = 1;
document.documentElement.dataset.erVer = '1';
// Движение пользователя, которое оставляет эхо: дискретный «шаг» темпа.
function makeEchoGeometry(kind) {
  if (kind === 0) return new THREE.TorusKnotGeometry(0.16, 0.018, 72, 8, 2, 3);
  if (kind === 1) return new THREE.BoxGeometry(0.24, 0.38, 0.02);
  return new THREE.IcosahedronGeometry(0.16, 2);
}

class EchoRoom extends xb.Script {
  init() {
    try { this._init(); }
    catch (e) {
      document.documentElement.dataset.erInitErr = (e && e.message) || String(e);
      console.error('[ER] INIT FAIL', e); throw e;
    }
  }

  _init() {
    this.add(new THREE.HemisphereLight(0xffffff, 0x1c1830, 1.3));
    this.root = new THREE.Group(); this.root.name = 'echo-room-root'; this.add(this.root);
    this.anchor = anchorRoot();

    // Пылинки-б-reference: темп времени виден по их дрейфу.
    const pos = new Float32Array(COUNT * 3); const col = new Float32Array(COUNT * 3);
    const c = new THREE.Color();
    for (let i = 0; i < COUNT; i++) {
      const a = Math.random() * Math.PI * 2; const r = Math.sqrt(Math.random()) * ROOM_R;
      pos.set([Math.cos(a) * r, Math.random() * 2.2 + 0.05, Math.sin(a) * r], i * 3);
      c.setHSL(0.55 + Math.random() * 0.12, 0.85, 0.6); col.set([c.r, c.g, c.b], i * 3);
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    pg.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    particleAttributes(pg, { scaleRandom: 0.7 });
    this.pmat = softParticlesMaterial({ size: 0.032, color: COLORS.accent, twinkle: 0.85, map: glowTexture({ core: 0.13 }) });
    this.points = new THREE.Points(pg, this.pmat); this.points.frustumCulled = false;
    this.root.add(this.points);
    this.tickRing = new THREE.Mesh(
      new THREE.RingGeometry(0.48, 0.53, 64),
      glowBlending(new THREE.MeshBasicMaterial({ color: COLORS.accent, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }))
    );
    this.tickRing.rotation.x = -Math.PI / 2; this.tickRing.position.y = 0.01;
    this.root.add(this.tickRing);

    this.echoes = [];
    this.echoKind = 0; this.captured = 0; this.playing = false; this.playT = 0; this.autoT = 1.6;

    const KIND_NAMES = ['КОЛЬЦО', 'ПЛИТА', 'СФЕРА'];
    const replay = () => this.startReplay();
    const nextKind = () => {
      this.echoKind = (this.echoKind + 1) % 3;
      const name = KIND_NAMES[this.echoKind];
      this.hud.setLabel('kind', name);
      this.spatial.setLabel('kind', name);
      this.stat();
    };
    this.hud = createHud({
      title: 'ECHO//ROOM',
      controls: [
        { id: 'replay', label: 'REPLAY', onClick: replay },
        { id: 'kind', label: 'КОЛЬЦО', onClick: nextKind },
      ],
      hint: 'тап — оставить эхо-слой · REPLAY — воспроизвести все слои · температура цвета = возраст',
    });
    this.spatial = spatialControls({
      title: 'ECHO//ROOM', status: 'LAYERS 0 · REPLAY OFF',
      controls: [
        { id: 'replay', label: 'REPLAY', onClick: replay },
        { id: 'kind', label: 'КОЛЬЦО', onClick: nextKind },
      ], width: 0.66,
    });
    this.spatial.card.position.set(0.84, 1.72, -1.3); this.add(this.spatial.card);

    this.fpsTick = fpsMeter((fps) => { this.fps = fps; }); this.fps = 0;
    this.raycaster = new THREE.Raycaster(); this._v = new THREE.Vector3();
    window.__echoRoom = this;
  }

  addEcho(point) {
    const mat = glowBlending(new THREE.MeshBasicMaterial({ color: ageColor(0), transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
    const mesh = new THREE.Mesh(makeEchoGeometry(this.echoKind), mat);
    mesh.position.copy(point); mesh.position.y = Math.max(0.5, Math.min(1.9, point.y));
    mesh.rotation.y = Math.random() * Math.PI * 2;
    this.root.add(mesh);
    this.echoes.push({ mesh, mat, age: 0 });
    if (this.echoes.length > MAX_ECHOES) {
      const old = this.echoes.shift(); old.mesh.removeFromParent(); old.mesh.geometry.dispose(); old.mat.dispose();
    }
    this.captured++; this.stat();
  }

  startReplay() {
    this.playing = true; this.playT = 0;
    for (const e of this.echoes) { e.age = 0; e.mat.opacity = 0.85; }
    this.stat();
  }

  onSelectEnd(event) {
    if (event?.completed === false || event?.target?.isUI) return;
    // Точка — из разрешённого попадания пайплайна, а не из взгляда камеры:
    // иначе слой появляется не там, куда попали. Фолбэк — луч камеры.
    const hit = event?.intersection?.point;
    if (hit) { this.addEcho(hit.clone()); return; }
    xb.core.camera.getWorldPosition(this._v);
    const dir = new THREE.Vector3(); xb.core.camera.getWorldDirection(dir);
    this.addEcho(this._v.clone().addScaledVector(dir, 1.1));
  }

  stat() {
    const s = `LAYERS ${this.echoes.length} · TOTAL ${this.captured} · ${this.playing ? 'REPLAY' : 'IDLE'} · FPS ${this.fps || '—'}`;
    this.hud.setStatus(s); this.spatial.setStatus(`LAYERS ${this.echoes.length}\n${this.playing ? 'REPLAY' : 'IDLE'}`);
    document.documentElement.dataset.erState = JSON.stringify({ fps: this.fps, layers: this.echoes.length, captured: this.captured, playing: this.playing, anchor: this.anchor.capability });
  }

  update() {
    const dt = Math.min(xb.getDeltaTime(), 0.05); this.fpsTick(dt);
    const cmd = document.documentElement.dataset.erCmd;
    if (cmd) {
      delete document.documentElement.dataset.erCmd;
      if (cmd === 'echo') this.addEcho(new THREE.Vector3((Math.random() - 0.5) * 1.4, 1 + Math.random() * 0.6, -0.8 - Math.random() * 0.5));
      else if (cmd === 'replay') this.startReplay();
    }
    if (!this.anchor.active && !this.anchor._pending && this.anchor.capability !== 'unsupported') this.anchor.create(this.root);
    this.anchor.follow(this.root);

    const t = xb.getElapsedTime?.() ?? performance.now() / 1000;
    this.points.rotation.y = t * 0.024;
    this.tickRing.scale.setScalar(1 + 0.05 * Math.sin(t * 2.0));

    if (this.playing) {
      this.playT += dt;
      const step = ECHO_LIFE / Math.max(1, this.echoes.length);
      this.echoes.forEach((e, i) => { e.age = Math.max(0, Math.min(ECHO_LIFE, this.playT - i * step * 0.55)); });
      if (this.playT > ECHO_LIFE + this.echoes.length * step * 0.55 + 0.3) { this.playing = false; this.stat(); }
    } else {
      // Без REPLAY новые слои появляются сами — разные формы, чтобы комната
      // читалась как временная реконструкция, а не одно большое кольцо.
      this.autoT -= dt;
      if (this.autoT <= 0) {
        this.autoT = 2.2 + Math.random() * 2.4;
        if (this.echoes.length < 3) {
          this.echoKind = (this.echoKind + 1) % 3;
          this.addEcho(new THREE.Vector3((Math.random() - 0.5) * 1.6, 0.9 + Math.random() * 0.8, -0.6 - Math.random() * 0.7));
        }
      }
    }
    for (const e of this.echoes) {
      if (!this.playing) e.age += dt; // в REPLAY возрастом управляет плейтайм
      const k = e.age / ECHO_LIFE;
      e.mat.color.copy(ageColor(k));
      e.mat.opacity = 0.85 * (1 - k * 0.6);
      e.mesh.rotation.y += dt * 0.12;
      e.mesh.scale.setScalar(0.75 + k * 0.5);
    }
    tickMaterials(t, [this.pmat]);
    this._statT = (this._statT || 0) + dt;
    if (this._statT > 0.5) { this._statT = 0; this.stat(); }
  }

  dispose() {
    this.anchor.dispose();
    for (const e of this.echoes) { e.mesh.removeFromParent(); e.mesh.geometry.dispose(); e.mat.dispose(); }
    this.points.geometry.dispose(); this.pmat.dispose();
    delete window.__echoRoom;
  }
}

// Руки не просим: ввод — тап/клик, hand-tracking делал бы сессию required
// и ронял вход на телефоне (канон: даунгрейд фич сессии).
const options = baseOptions({ title: 'ECHO//ROOM', description: 'Комната-луковица времени: эхо-слои действий тают, цвет кодирует возраст.', depth: false, bloom: false });
options.controllers.visualizeRays = false;

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const script = new EchoRoom(); xb.add(script); await xb.init(options); watchSession();
  } catch (e) { document.documentElement.dataset.erInitErr = (e && e.message) || String(e); console.error('[ER] BOOT FAIL', e); }
});
