import * as THREE from 'three';
import * as xb from 'xrblocks';
import { installXrGuards, watchXrButton } from '../common/boot.js';
import { makeHud } from '../common/hud.js?v=spatial-ui-8';

// ECHO//ROOM — трёхмерный temporal debugger реальности.
// Каждое движение луча оставляет траекторию, каждый тап — импульс.
// Пространство хранит ~60 секунд. Клик по старому следу разворачивает
// временные слои NOW / −1с … −4с вокруг выбранной точки.

const KEEP = 60;          // секунд истории
const TRAIL_N = 600;      // точек в ленте траектории
const MAX_PULSES = 40;
const LAYER_COUNT = 4;

class EchoRoom extends xb.Script {
  init() {
    this.add(new THREE.HemisphereLight(0xdfe8ff, 0x223344, 1.4));

    // живая лента траектории луча. Буфер продублирован: точка пишется в двух
    // местах, поэтому живое окно [now−8с … now] всегда лежит одним куском и
    // Line не рисует шов через весь буфер при завороте кольца.
    this.trailPos = new Float32Array(TRAIL_N * 2 * 3);
    this.trailAge = new Float32Array(TRAIL_N).fill(1e9);
    this.trailHead = 0;
    this.trailGeo = new THREE.BufferGeometry();
    this.trailGeo.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3));
    this.trailGeo.setDrawRange(0, 0);
    this.trail = new THREE.Line(this.trailGeo, new THREE.LineBasicMaterial({
      color: 0x54d6ff, transparent: true, opacity: 0.6,
    }));
    this.trail.frustumCulled = false;
    this.add(this.trail);

    // импульсы-тапы: кольцевой буфер {mesh, at, pos}
    this.pulses = [];
    this.ringGeo = new THREE.RingGeometry(0.94, 1.0, 40);

    // журнал событий для временных слоёв: {t, kind, pos}
    this.log = [];

    // слои-призраки: линии-копии истории
    this.timeLayers = [];
    for (let l = 1; l <= LAYER_COUNT; l++) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_N * 3), 3));
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({
        color: [0xffb14a, 0x7dff9a, 0xff6ad5, 0x9fe8ff][l - 1],
        transparent: true, opacity: 0.35,
      }));
      line.visible = false;
      line.frustumCulled = false;
      this.add(line);
      this.timeLayers.push({ line, back: l, anchor: null });
    }

    this._o = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._tip = new THREE.Vector3();
    this._sel = new THREE.Vector3();
    this._ray = new THREE.Ray();
    this.hud = makeHud({
      title: 'ECHO//ROOM',
      stat: 'двигай лучом / кликай — следы остаются 60 секунд',
      buttons: [{id: 'clear', label: 'стереть историю', onTap: () => this.wipe()}],
    });
    this.add(this.hud.card);
  }

  stat(s) { this.hud.setStat(s); }

  wipe() {
    this.log = [];
    this.trailAge.fill(1e9);
    this.trailGeo.setDrawRange(0, 0);
    this.trailGeo.attributes.position.needsUpdate = true;
    for (const p of this.pulses) { this.remove(p.mesh); p.mesh.material.dispose(); }
    this.pulses = [];
    for (const l of this.timeLayers) { l.line.visible = false; l.anchor = null; }
    this.selected = null;
    this.stat('история стёрта');
  }

  aim() {
    try {
      xb.user.getControllerPosition(0, this._o);
      const r = xb.user.getRay(0, this._ray);
      if (r && r.direction.lengthSq() > 0.5) { this._d.copy(r.direction); return true; }
    } catch { /* controller may not exist on this platform */ }
    xb.core.camera.getWorldPosition(this._o);
    xb.core.camera.getWorldDirection(this._d);
    return true;
  }

  onSelectEnd() {
    this.aim();
    const pos = this._sel.copy(this._o).addScaledVector(this._d.normalize(), 1.2);
    // свой импульс или выбор старого следа?
    const pick = this.pickPulse(pos);
    if (pick) { this.inspect(pick); return; }
    const m = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({
      color: 0x9fe8ff, transparent: true, opacity: 0.9,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    m.position.copy(pos);
    m.lookAt(xb.core.camera.position);
    this.add(m);
    const t = performance.now() / 1000;
    this.pulses.push({ mesh: m, at: t, pos: pos.clone() });
    this.log.push({ t, kind: 'pulse', pos: pos.clone() });
    if (this.pulses.length > MAX_PULSES) {
      const old = this.pulses.shift();
      this.remove(old.mesh); old.mesh.material.dispose();
    }
    this.prune();
  }

  pickPulse(pos) {
    let best = null, bd = 0.25;
    for (const p of this.pulses) {
      const d = p.pos.distanceTo(pos);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  inspect(pulse) {
    // развернуть слои −1…−4с вокруг точки импульса
    const t0 = pulse.at;
    for (const l of this.timeLayers) {
      l.anchor = pulse.pos.clone();
      l.t = t0 - l.back;
      l.line.visible = true;
    }
    this.selected = pulse;
    this.stat(`слой вокруг ✦ ${this.fmtAgo(t0)} · NOW / −1с / −2с / −3с / −4с`);
  }

  fmtAgo(t) {
    const d = performance.now() / 1000 - t;
    return d < 1 ? 'только что' : `${d.toFixed(0)}с назад`;
  }

  prune() {
    const now = performance.now() / 1000;
    this.log = this.log.filter((e) => now - e.t < KEEP);
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      if (now - this.pulses[i].at > KEEP) {
        const [old] = this.pulses.splice(i, 1);
        this.remove(old.mesh); old.mesh.material.dispose();
      }
    }
  }

  update() {
    const dt = Math.min(xb.getDeltaTime(), 0.05);
    const now = performance.now() / 1000;
    this.aim();

    // пишем точку траектории каждый кадр — сразу в обе половины буфера
    this._tip.copy(this._o).addScaledVector(this._d.normalize(), 1.0);
    const w = this.trailHead % TRAIL_N;
    const ix = w * 3;
    const mirror = ix + TRAIL_N * 3;
    this.trailPos[ix] = this.trailPos[mirror] = this._tip.x;
    this.trailPos[ix + 1] = this.trailPos[mirror + 1] = this._tip.y;
    this.trailPos[ix + 2] = this.trailPos[mirror + 2] = this._tip.z;
    this.trailAge[w] = now;
    this.trailHead++;
    this.log.push({ t: now, kind: 'move', pos: this._tip.clone() });

    // живое окно: считаем назад от головы, пока точки свежее 8 секунд.
    let live = 0;
    const span = Math.min(this.trailHead, TRAIL_N);
    for (let k = 0; k < span; k++) {
      if (now - this.trailAge[(w - k + TRAIL_N) % TRAIL_N] > 8) break;
      live++;
    }
    this.trailGeo.setDrawRange(w + TRAIL_N - live + 1, live > 1 ? live : 0);
    this.trailGeo.attributes.position.needsUpdate = true;

    // импульсы: рост и затухание
    for (const pu of this.pulses) {
      const age = now - pu.at;
      pu.mesh.scale.setScalar(0.05 + age * 0.25);
      pu.mesh.material.opacity = Math.max(0.12, 0.9 - age * 0.06);
    }
    if ((this._pr = (this._pr || 0) + dt) > 2) { this._pr = 0; this.prune(); }

    // слои: история в окне [t−4.5, t−0.5] вокруг точки
    let n = 0;
    for (const l of this.timeLayers) {
      if (!l.line.visible) continue;
      const arr = l.line.geometry.attributes.position.array;
      let count = 0;
      for (const e of this.log) {
        if (count >= TRAIL_N) break;
        if (Math.abs(e.t - l.t) >= 0.6) continue;
        if (e.pos.distanceTo(l.anchor) >= 1.2) continue;
        const at = count * 3;
        arr[at] = e.pos.x; arr[at + 1] = e.pos.y; arr[at + 2] = e.pos.z;
        count++;
      }
      l.line.geometry.setDrawRange(0, count);
      l.line.geometry.attributes.position.needsUpdate = true;
      n += count;
    }

    if ((this._st = (this._st || 0) + dt) > 0.5) {
      this._st = 0;
      this.stat(
        `событий в памяти: ${this.log.length} · импульсов: ${this.pulses.length}` +
        (this.selected ? ` · слои: ${n} точек` : ' · кликни по ✦ чтобы развернуть слои')
      );
    }
  }

  dispose() {
    this.trailGeo.dispose(); this.trail.material.dispose();
    this.ringGeo.dispose();
    for (const l of this.timeLayers) { l.line.geometry.dispose(); l.line.material.dispose(); }
  }
}

const options = new xb.Options();
options.enableReticles();
options.xrButton.showEnterSimulatorButton = true;
options.setAppTitle('ECHO//ROOM');
options.setAppDescription('След и импульсы держат минуту. Тап по ✦ — временные слои.');

installXrGuards();

document.addEventListener('DOMContentLoaded', () => {
  xb.add(new EchoRoom());
  xb.init(options);
  watchXrButton();
});
