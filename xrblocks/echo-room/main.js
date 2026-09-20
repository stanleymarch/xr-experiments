import * as THREE from 'three';
import * as xb from 'xrblocks';

// ECHO//ROOM — трёхмерный temporal debugger реальности.
// Каждое движение луча оставляет траекторию, каждый тап — импульс.
// Пространство хранит ~60 секунд. Клик по старому следу разворачивает
// временные слои NOW / −1с … −4с вокруг выбранной точки.

const $ = (id) => document.getElementById(id);
const KEEP = 60;          // секунд истории
const TRAIL_N = 600;      // точек в ленте траектории
const MAX_PULSES = 40;
const LAYER_COUNT = 4;

class EchoRoom extends xb.Script {
  init() {
    this.add(new THREE.HemisphereLight(0xdfe8ff, 0x223344, 1.4));

    // живая лента траектории луча
    this.trailPos = new Float32Array(TRAIL_N * 3);
    this.trailAge = new Float32Array(TRAIL_N).fill(1e9);
    this.trailHead = 0;
    this.trailGeo = new THREE.BufferGeometry();
    this.trailGeo.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3));
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
    this.layers = [];
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
      this.layers.push({ line, back: l, anchor: null });
    }

    this._o = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._pts = [];
    $('btn-clear').onclick = () => this.wipe();
    this.stat('двигай лучом / кликай — следы остаются 60 секунд');
  }

  stat(s) { $('stat').textContent = s; }

  wipe() {
    this.log = [];
    this.trailAge.fill(1e9);
    this.trailGeo.attributes.position.needsUpdate = true;
    for (const p of this.pulses) { this.remove(p.mesh); p.mesh.material.dispose(); }
    this.pulses = [];
    for (const l of this.layers) { l.line.visible = false; l.anchor = null; }
    this.selected = null;
    this.stat('история стёрта');
  }

  aim() {
    try {
      xb.user.getControllerPosition(0, this._o);
      const r = xb.user.getRay(0, new THREE.Ray());
      if (r && r.direction.lengthSq() > 0.5) { this._d.copy(r.direction); return true; }
    } catch { /* noop */ }
    xb.core.camera.getWorldPosition(this._o);
    xb.core.camera.getWorldDirection(this._d);
    return true;
  }

  onSelectEnd() {
    this.aim();
    const pos = this._o.clone().addScaledVector(this._d.clone().normalize(), 1.2);
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
    for (const l of this.layers) {
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

    // пишем точку траектории каждый кадр
    const tip = this._o.clone().addScaledVector(this._d.clone().normalize(), 1.0);
    const i = this.trailHead % TRAIL_N;
    this.trailPos.set([tip.x, tip.y, tip.z], i * 3);
    this.trailAge[i] = now;
    this.trailHead++;
    this.log.push({ t: now, kind: 'move', pos: tip.clone() });

    // живая лента: прячем точки старше 8 секунд
    const p = this.trailGeo.attributes.position.array;
    for (let k = 0; k < TRAIL_N; k++) {
      if (now - this.trailAge[k] > 8) { p[k * 3 + 1] = -100; }
    }
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
    for (const l of this.layers) {
      if (!l.line.visible) continue;
      const arr = l.line.geometry.attributes.position.array;
      arr.fill(-100);
      let w = 0;
      for (const e of this.log) {
        if (Math.abs(e.t - l.t) < 0.6 && e.pos.distanceTo(l.anchor) < 1.2 && w < TRAIL_N) {
          arr.set([e.pos.x, e.pos.y, e.pos.z], w * 3);
          w++;
        }
      }
      l.line.geometry.attributes.position.needsUpdate = true;
      l.line.geometry.setDrawRange(0, Math.max(0, w));
      n += w;
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
    for (const l of this.layers) { l.line.geometry.dispose(); l.line.material.dispose(); }
  }
}

const options = new xb.Options();
options.enableReticles();
options.xrButton.showEnterSimulatorButton = true;
options.setAppTitle('ECHO//ROOM');
options.setAppDescription('Следы действий 60 секунд. Клик по ✦ — временные слои.');

document.addEventListener('DOMContentLoaded', () => {
  xb.add(new EchoRoom());
  xb.init(options);
});
