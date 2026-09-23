import * as THREE from 'three';
import * as xb from 'xrblocks';
import { makePoints } from '../common/fx.js';
import {
  enableAutomation, installLaunchShell, installXrGuards,
  isAutomation, previewFromEyeHeight, watchXrButton,
} from '../common/boot.js?v=mobile-ux-18';
import { makeHud } from '../common/hud.js?v=mobile-ux-17';

// ECHO//ROOM — трёхмерный temporal debugger реальности.
// Каждое движение луча оставляет траекторию, каждый тап — импульс.
// Пространство хранит ~60 секунд. Клик по старому следу разворачивает
// временные слои NOW / −1с … −4с вокруг выбранной точки.

const KEEP = 60;          // секунд истории
const TRAIL_N = 600;      // точек в ленте траектории
const MAX_PULSES = 40;
const LAYER_COUNT = 4;
const SAMPLE_DT = 0.1;          // запись истории поз/движений: 10 Гц, не каждый кадр
const GHOST_N = KEEP / SAMPLE_DT; // кольцо поз на всю минуту истории

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
    this._sel = new THREE.Vector3();
    this._ray = new THREE.Ray();

    // Эхо-аватар: призрак «прошлого тебя» — голова и руки (или плечи, если
    // контроллеров нет). Позы пишутся 10 Гц в кольцо на 60 секунд.
    const ghost = makePoints(3, { size: 0.05, color: 0xffffff, opacity: 0.9 });
    this.ghostPts = ghost.points;
    this.ghostPos = ghost.pos;
    this.ghostCol = ghost.col;
    this.ghostGeo = ghost.geo;
    this.ghostPts.visible = false;
    this.add(this.ghostPts);
    this.poseT = new Float32Array(GHOST_N).fill(-1e9);
    this.poseP = new Float32Array(GHOST_N * 9); // голова + рука L + рука R
    this.poseHead = 0;
    this._poseAcc = 0;
    this.scrub = 0; // 0 = живое настоящее; <0 = смотреть прошлое
    const gc = new THREE.Color().setHSL(0.09, 0.8, 0.6); // тёплое «прошлое»
    this.ghostCol.set([gc.r, gc.g, gc.b, gc.r, gc.g, gc.b, gc.r, gc.g, gc.b]);
    this.ghostGeo.attributes.color.needsUpdate = true;
    this.hud = makeHud({
      title: 'ECHO//ROOM',
      stat: 'MOVE — the room remembers a minute. TAP — impulse, slider — the past',
      slider: {
        min: -60, max: 0, step: 1, value: 0, ariaLabel: 'time scrub',
        onInput: (v) => { this.scrub = v; },
      },
      buttons: [{id: 'clear', label: 'CLEAR', onTap: () => this.wipe()}],
    });
    this.add(this.hud.card);
    this._autoT = isAutomation() ? 0 : null;
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
    this.poseT.fill(-1e9);
    this.poseHead = 0;
    this.scrub = 0;
    this.hud.setSliderValue(0);
    this.ghostPts.visible = false;
    this.stat('history cleared');
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

  onSelectEnd(event) {
    if (this.hud.owns(event?.target)) return;
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
    this.stat(`layers around ✦ ${this.fmtAgo(t0)} · NOW / -1s / -2s / -3s / -4s`);
  }

  fmtAgo(t) {
    const d = performance.now() / 1000 - t;
    return d < 1 ? 'just now' : `${d.toFixed(0)}s ago`;
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
    this.hud.update();
    const dt = Math.min(xb.getDeltaTime(), 0.05);
    const now = performance.now() / 1000;
    this.aim();
    // Automation: статичная камера не оставляет следов — сеем импульсы сами,
    if (this._autoT !== null && (this._autoT += dt) >= 2.5) {
      this._autoT = 0;
      const a = Math.random() * Math.PI * 2;
      const r = 0.7 + Math.random() * 0.6;
      const pos = this._sel.set(Math.cos(a) * r, 0.7 + Math.random() * 0.9, -0.6 - Math.abs(Math.sin(a)) * r);
      const m = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({
        color: 0x9fe8ff, transparent: true, opacity: 0.9,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      m.position.copy(pos);
      m.lookAt(xb.core.camera.position);
      this.add(m);
      const t = now;
      this.pulses.push({ mesh: m, at: t, pos: pos.clone() });
      this.log.push({ t, kind: 'pulse', pos: pos.clone() });
      if (this.pulses.length > MAX_PULSES) {
        const old = this.pulses.shift();
        this.remove(old.mesh); old.mesh.material.dispose();
      }
      this.prune();
    }

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
    // движение в журнал — 10 Гц, не каждый кадр: слоям хватит, мусора меньше
    if ((this._moveAcc = (this._moveAcc || 0) + dt) >= SAMPLE_DT) {
      this._moveAcc = 0;
      this.log.push({ t: now, kind: 'move', pos: this._tip.clone() });
    }

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
      // диффузия: кольцо растёт как √t, яркость падает экспоненциально —
      // импульс честно расплывается, а не тускнеет по линейке таймера
      pu.mesh.scale.setScalar(0.05 + Math.sqrt(age) * 0.12);
      pu.mesh.material.opacity = Math.max(0.05, 0.9 * Math.exp(-age / 18));
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
        (this.scrub < -0.5 ? `SCRUB ${this.scrub.toFixed(0)}s · ghost stands` : `events in memory: ${this.log.length} · pulses: ${this.pulses.length}`) +
        (this.selected ? ` · layers: ${n} points` : (this.scrub < -0.5 ? '' : ' · click a ✦ to unfold layers'))
      );
    }
    // История поз: голова всегда; руки — контроллеры, иначе плечи из базиса
    // камеры. 10 Гц — гладкому призраку хватает, памяти мало.
    this._poseAcc += dt;
    if (this._poseAcc >= SAMPLE_DT) {
      this._poseAcc = 0;
      const gi = this.poseHead % GHOST_N;
      const base = gi * 9;
      xb.core.camera.getWorldPosition(this._tip);
      this.poseP[base] = this._tip.x; this.poseP[base + 1] = this._tip.y; this.poseP[base + 2] = this._tip.z;
      let hands = 0;
      for (let c = 0; c < 2; c++) {
        try {
          xb.user.getControllerPosition(c, this._o);
          this.poseP[base + 3 + c * 3] = this._o.x;
          this.poseP[base + 4 + c * 3] = this._o.y;
          this.poseP[base + 5 + c * 3] = this._o.z;
          hands = 1;
        } catch { /* контроллеров нет — ниже будут плечи */ }
      }
      if (!hands) {
        xb.core.camera.getWorldDirection(this._d);
        const sx = this._d.z, sz = -this._d.x; // боковая ось камеры в плане
        const il = 1 / (Math.hypot(sx, sz) || 1);
        this.poseP[base + 3] = this._tip.x + sx * il * 0.18;
        this.poseP[base + 4] = this._tip.y - 0.12;
        this.poseP[base + 5] = this._tip.z + sz * il * 0.18;
        this.poseP[base + 6] = this._tip.x - sx * il * 0.18;
        this.poseP[base + 7] = this._tip.y - 0.12;
        this.poseP[base + 8] = this._tip.z - sz * il * 0.18;
      }
      this.poseT[gi] = now;
      this.poseHead++;
    }

    // Скраб времени: тёплый призрак в выбранном прошлом, рядом с живым тобой.
    if (this.scrub < -0.5) {
      const want = now + this.scrub;
      let bi = -1, bd = SAMPLE_DT * 1.5;
      const newest = Math.min(this.poseHead, GHOST_N);
      for (let k = 0; k < newest; k++) {
        const idx = (this.poseHead - 1 - k + GHOST_N * 4) % GHOST_N;
        const d = Math.abs(this.poseT[idx] - want);
        if (d < bd) { bd = d; bi = idx; }
        if (this.poseT[idx] < want - 1) break; // дальше только старее
      }
      if (bi >= 0) {
        const base = bi * 9;
        for (let j = 0; j < 9; j++) this.ghostPos[j] = this.poseP[base + j];
        this.ghostGeo.attributes.position.needsUpdate = true;
        this.ghostPts.visible = true;
      }
    } else {
      this.ghostPts.visible = false;
    }

  }

  dispose() {
    this.trailGeo.dispose(); this.trail.material.dispose();
    this.ringGeo.dispose();
    for (const l of this.timeLayers) { l.line.geometry.dispose(); l.line.material.dispose(); }
    this.ghostGeo.dispose();
    this.ghostPts.material.dispose();
  }
}

const options = new xb.Options();
options.enableReticles();
options.world?.enableAnchors?.();
options.xrButton.showEnterSimulatorButton = true;
options.setAppTitle('ECHO//ROOM');
options.setAppDescription('След и импульсы держат минуту. Тап по ✦ — временные слои.');

enableAutomation(options);
installXrGuards();
installLaunchShell(options, [
  'Вход — кнопка внизу: комната запомнит минуту движения',
  'Тап — импульс ✦, тап по старому ✦ — слои времени',
  'Меню — панель внизу экрана',
]);
previewFromEyeHeight();

document.addEventListener('DOMContentLoaded', () => {
  xb.add(new EchoRoom());
  xb.init(options);
  watchXrButton();
});
