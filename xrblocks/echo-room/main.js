import * as THREE from 'three';
import * as xb from 'xrblocks';
import { glowBlending, makePoints } from '../common/fx.js?v=mobile-ux-24';
import {
  enableAutomation, installLaunchShell, installXrGuards,
  isAutomation, previewFromEyeHeight, watchXrButton,
} from '../common/boot.js?v=mobile-ux-24';
import { makeHud } from '../common/hud.js?v=mobile-ux-24';

// ECHO//ROOM — трёхмерный temporal debugger реальности.
// Каждое движение луча оставляет траекторию, каждый тап — импульс.
// Пространство хранит ~60 секунд. Тап по старому ✦ разворачивает локальные
// временные слои NOW / −1с … −4с вокруг точки; слайдер HUD перематывает всю
// минуту целиком: призрак поз, сечение траектории луча и импульсы показываются
// «кадром прошлого». Возраст везде читается одним теплом: свежее — яркое и
// тёплое, старее — холодное и тусклое.

const KEEP = 60;                  // секунд истории
const TRAIL_N = 600;              // точек в ленте траектории
const TRAIL_LIFE = 8;             // окно ленты: живое и в кадре прошлого
const MAX_PULSES = 40;
const LAYER_COUNT = 4;
const SAMPLE_DT = 0.1;            // запись истории поз/движений: 10 Гц, не каждый кадр
const GHOST_N = KEEP / SAMPLE_DT; // кольцо поз на всю минуту истории
const PULSE_HIT_R = 0.22;         // радиус сферы попадания импульса

// Тепловая рампа возраста. Одна шкала красит ленту, импульсы и призрака,
// поэтому легенда в HUD честна сразу для всего опыта: 0 с — яркое тёплое
// золото, максимум срока — холодный тусклый циан.
const HEAT_STEPS = 32;
const HEAT = Array.from({length: HEAT_STEPS}, (_, i) => {
  const f = i / (HEAT_STEPS - 1);
  return new THREE.Color().setHSL(0.10 + f * 0.45, 0.9 - f * 0.35, 0.66 - f * 0.36);
});
function heatColor(age, ttl) {
  const f = Math.max(0, Math.min(1, age / ttl));
  return HEAT[Math.min(HEAT_STEPS - 1, (f * HEAT_STEPS) | 0)];
}
const LEGEND = 'heat: warm = new, cold = old';

class EchoRoom extends xb.Script {
  init() {
    this.add(new THREE.HemisphereLight(0xdfe8ff, 0x223344, 1.4));

    // живая лента траектории луча. Буфер продублирован: точка пишется в двух
    // местах, поэтому живое окно [now−8с … now] всегда лежит одним куском и
    // Line не рисует шов через весь буфер при завороте кольца. Цвет каждой
    // точки — тепло её возраста, лента сама себе легенда.
    this.trailPos = new Float32Array(TRAIL_N * 2 * 3);
    this.trailCol = new Float32Array(TRAIL_N * 2 * 3);
    this.trailAge = new Float32Array(TRAIL_N).fill(1e9);
    this.trailHead = 0;
    this.trailGeo = new THREE.BufferGeometry();
    this.trailGeo.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3));
    this.trailGeo.setAttribute('color', new THREE.BufferAttribute(this.trailCol, 3));
    this.trailGeo.setDrawRange(0, 0);
    this.trail = new THREE.Line(this.trailGeo, glowBlending(new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.85,
    })));
    this.trail.frustumCulled = false;
    this.trail.xb = {pointerEvents: 'none'}; // презентация не ловит луч
    this.add(this.trail);

    // кадр прошлого: та же лента, собранная из журнала на момент T.
    // Собирается только пока слайдер перемотан, живёт своей геометрией.
    this.pastPos = new Float32Array(TRAIL_N * 3);
    this.pastCol = new Float32Array(TRAIL_N * 3);
    this.pastGeo = new THREE.BufferGeometry();
    this.pastGeo.setAttribute('position', new THREE.BufferAttribute(this.pastPos, 3));
    this.pastGeo.setAttribute('color', new THREE.BufferAttribute(this.pastCol, 3));
    this.pastGeo.setDrawRange(0, 0);
    this.pastTrail = new THREE.Line(this.pastGeo, glowBlending(new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.6,
    })));
    this.pastTrail.frustumCulled = false;
    this.pastTrail.xb = {pointerEvents: 'none'};
    this.pastTrail.visible = false;
    this.add(this.pastTrail);

    // импульсы-тапы: {mesh, hit, at, pos}. mesh — свет, hit — сфера попадания
    // фиксированного радиуса: кольцо со временем расплывается, и цель под
    // лучом не должна расплываться вместе с ним.
    this.pulses = [];
    this.ringGeo = new THREE.RingGeometry(0.94, 1.0, 40);
    this.hitGeo = new THREE.SphereGeometry(1, 10, 8);
    this.hitMat = new THREE.MeshBasicMaterial({visible: false}); // не рисуется, но рейкастится

    // журнал событий для слоёв и кадра прошлого: {t, kind, pos}
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
      line.xb = {pointerEvents: 'none'};
      this.add(line);
      this.timeLayers.push({line, back: l, anchor: null, t: 0});
    }

    this._o = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._sel = new THREE.Vector3();
    this._tip = new THREE.Vector3();
    this._ray = new THREE.Ray();

    // Эхо-аватар: призрак «прошлого тебя» — голова и руки (или плечи, если
    // контроллеров нет). Позы пишутся 10 Гц в кольцо на 60 секунд, при
    // перемотке интерполируются между соседними сэмплами.
    const ghost = makePoints(3, { size: 0.05, color: 0xffffff, opacity: 0.9 });
    this.ghostPts = ghost.points;
    this.ghostPos = ghost.pos;
    this.ghostCol = ghost.col;
    this.ghostGeo = ghost.geo;
    this.ghostPts.visible = false;
    this.ghostPts.xb = {pointerEvents: 'none'};
    this.add(this.ghostPts);
    this.poseT = new Float32Array(GHOST_N).fill(-1e9);
    this.poseP = new Float32Array(GHOST_N * 9); // голова + рука L + рука R
    this.poseHead = 0;
    this._poseAcc = 0;
    this.scrub = 0; // 0 = живое настоящее; <0 = смотреть прошлое
    this.selected = null;
    this.hovered = null;

    // мини-карточка выбранного импульса: возраст и подсказка про слои.
    // pointerEvents none — подпись не должна перехватывать тап по самому ✦.
    this.label = new xb.UICard({
      size: {width: 0.24, height: 'auto'},
      pointerEvents: 'none',
      visible: false,
      style: {flexDirection: 'column', gap: 4, padding: 10, backgroundColor: '#101726'},
      children: [
        new xb.UIText({
          text: '✦ IMPULSE',
          style: {fontSize: 18, fontWeight: 'bold', textAlign: 'center'},
        }),
        this.labelBody = new xb.UIText({
          text: '',
          style: {fontSize: 14, opacity: 0.8, textAlign: 'center'},
        }),
      ],
    });
    this.label.add(new xb.FaceCamera({mode: 'spherical', smoothing: 0.15}));
    this.add(this.label);

    this.hud = makeHud({
      title: 'ECHO//ROOM',
      stat: 'TAP — impulse · tap ✦ — layers · slider — a past frame',
      slider: {
        min: -60, max: 0, step: 1, value: 0, ariaLabel: 'time scrub',
        onInput: (v) => this.setScrub(v, false),
      },
      buttons: [{id: 'clear', label: 'CLEAR', onTap: () => this.wipe()}],
    });
    this.add(this.hud.card);
    this.setScrub(0);
    this._autoT = isAutomation() ? 0 : null;
  }

  stat(s) { this.hud.setStat(s); }

  // Перемотка: одна точка входа и для слайдера, и для сброса из кода.
  // Призрак прошлого красится тем же теплом — чем глубже перемотка, тем
  // холоднее призрак, легенда HUD остаётся честной.
  setScrub(v, syncUi = true) {
    this.scrub = v;
    if (syncUi) this.hud.setSliderValue(v);
    this.hud.setSliderLabel(v === 0 ? 'NOW' : `${Math.round(v)} s · past frame`);
    const c = heatColor(Math.max(0, -v), KEEP);
    for (let j = 0; j < 3; j++) {
      const a = j * 3;
      this.ghostCol[a] = c.r; this.ghostCol[a + 1] = c.g; this.ghostCol[a + 2] = c.b;
    }
    this.ghostGeo.attributes.color.needsUpdate = true;
  }

  wipe() {
    this.log = [];
    this.trailAge.fill(1e9);
    this.trailHead = 0;
    this.trailGeo.setDrawRange(0, 0);
    this.trailGeo.attributes.position.needsUpdate = true;
    for (const pu of this.pulses) this.removePulse(pu);
    this.pulses = [];
    this.closeLayers();
    this.hovered = null;
    this.poseT.fill(-1e9);
    this.poseHead = 0;
    this.setScrub(0);
    this.pastTrail.visible = false;
    this.pastGeo.setDrawRange(0, 0);
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

  // Тап по пустоте — импульс. Точка берётся из события: попадание луча, если
  // резолвер его дал, иначе 1.2 м вдоль SDK-снапшота луча источника
  // (свой Raycaster в колбэке запрещён контрактом проекта).
  onSelectEnd(event) {
    if (this.hud.owns(event?.target)) return; // HUD уже разобрался со своим тапом
    if (event.target) return;                 // цель захвачена объектом — её разбирает onObjectSelectEnd
    if (!event.completed) return;
    if (this.scrub < -0.5) { this.stat('the past is read-only — slide back to NOW'); return; }
    let pos;
    if (event.intersection?.point) {
      pos = this._sel.copy(event.intersection.point);
    } else {
      this.aim();
      pos = this._sel.copy(this._o).addScaledVector(this._d.normalize(), 1.2);
    }
    this.spawnPulse(pos);
  }

  // Тап по импульсу: сфера попадания отдаёт свой pulse, повторный тап по
  // выбранному закрывает слои. Завершение проверяем по контракту события.
  onObjectSelectEnd(event) {
    if (!event.completed) return;
    const pulse = event.surface?.userData?.pulse;
    if (!pulse) return;
    event.stopPropagation();
    this.inspect(pulse);
  }

  onHoverEnter(event) {
    const pulse = event.surface?.userData?.pulse;
    if (pulse) this.hovered = pulse;
  }

  onHoverExit(event) {
    if (event.surface?.userData?.pulse === this.hovered) this.hovered = null;
  }

  spawnPulse(pos, at = performance.now() / 1000) {
    const mesh = new THREE.Mesh(this.ringGeo, glowBlending(new THREE.MeshBasicMaterial({
      color: 0xffffff, // перекрашивается теплом возраста каждый кадр
      transparent: true, opacity: 0.9,
      side: THREE.DoubleSide, depthWrite: false,
    })));
    mesh.position.copy(pos);
    mesh.lookAt(xb.core.camera.position);
    mesh.xb = {pointerEvents: 'none'}; // визуал не ловит луч — ловит сфера попадания
    const hit = new THREE.Mesh(this.hitGeo, this.hitMat);
    hit.position.copy(pos);
    hit.scale.setScalar(PULSE_HIT_R);
    const pu = {mesh, hit, at, pos: pos.clone()};
    hit.userData.pulse = pu;
    this.add(mesh, hit);
    this.pulses.push(pu);
    this.log.push({t: at, kind: 'pulse', pos: pos.clone()});
    if (this.pulses.length > MAX_PULSES) this.removePulse(this.pulses.shift());
    this.prune();
    return pu;
  }

  removePulse(pu) {
    this.remove(pu.mesh);
    this.remove(pu.hit);
    pu.mesh.material.dispose();
    if (this.selected === pu) this.closeLayers();
    if (this.hovered === pu) this.hovered = null;
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

  closeLayers() {
    for (const l of this.timeLayers) { l.line.visible = false; l.anchor = null; }
    this.selected = null;
    this.label.visible = false;
  }

  fmtAgo(t) {
    const d = performance.now() / 1000 - t;
    return d < 1 ? 'just now' : `${d.toFixed(0)}s ago`;
  }

  prune() {
    const now = performance.now() / 1000;
    this.log = this.log.filter((e) => now - e.t < KEEP);
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      if (now - this.pulses[i].at > KEEP) this.removePulse(this.pulses.splice(i, 1)[0]);
    }
  }

  // Кадр прошлого: сечение журнала на момент T — те же 8 секунд ленты, но
  // записанные 10 Гц движениями луча. Журнал идёт по времени, поэтому всё,
  // что позже T, обрывает цикл, а старее окна просто пропускается.
  buildPastTrail(T) {
    let count = 0;
    for (const e of this.log) {
      if (e.t > T || count >= TRAIL_N) break;
      if (e.kind !== 'move' || e.t < T - TRAIL_LIFE) continue;
      const c = heatColor(T - e.t, TRAIL_LIFE);
      const a = count * 3;
      this.pastPos[a] = e.pos.x; this.pastPos[a + 1] = e.pos.y; this.pastPos[a + 2] = e.pos.z;
      this.pastCol[a] = c.r; this.pastCol[a + 1] = c.g; this.pastCol[a + 2] = c.b;
      count++;
    }
    this.pastGeo.setDrawRange(0, count);
    this.pastGeo.attributes.position.needsUpdate = true;
    this.pastGeo.attributes.color.needsUpdate = true;
    return count;
  }

  // Поза на момент want: линейная интерполяция соседних сэмплов кольца,
  // чтобы перемотка не прыгала по шагам записи 10 Гц. b0 — старая сторона
  // скобки (новейший сэмпл не позже want), b1 — соседний к нему свежее.
  ghostPoseAt(want) {
    const total = Math.min(this.poseHead, GHOST_N);
    if (!total) return false;
    const last = (this.poseHead - 1) % GHOST_N;
    let b0 = -1, b1 = -1;
    for (let k = 0; k < total; k++) {
      const idx = (last - k + GHOST_N * 4) % GHOST_N;
      if (this.poseT[idx] <= want) {
        b0 = idx;
        if (k > 0) b1 = (last - k + 1 + GHOST_N * 4) % GHOST_N;
        break;
      }
    }
    if (b0 < 0) b0 = (last - total + 1 + GHOST_N * 4) % GHOST_N; // want старше истории
    const p0 = b0 * 9;
    if (b1 >= 0 && this.poseT[b1] > this.poseT[b0]) {
      let f = (want - this.poseT[b0]) / (this.poseT[b1] - this.poseT[b0]);
      f = Math.max(0, Math.min(1, f));
      const p1 = b1 * 9;
      for (let j = 0; j < 9; j++) {
        this.ghostPos[j] = this.poseP[p0 + j] + (this.poseP[p1 + j] - this.poseP[p0 + j]) * f;
      }
    } else {
      for (let j = 0; j < 9; j++) this.ghostPos[j] = this.poseP[p0 + j];
    }
    this.ghostGeo.attributes.position.needsUpdate = true;
    return true;
  }

  update() {
    this.hud.update();
    const dt = Math.min(xb.getDeltaTime(), 0.05);
    const now = performance.now() / 1000;
    this.aim();
    // Automation: статичная камера не оставляет следов — сеем импульсы сами.
    if (this._autoT !== null && (this._autoT += dt) >= 2.5) {
      this._autoT = 0;
      const a = Math.random() * Math.PI * 2;
      const r = 0.7 + Math.random() * 0.6;
      this.spawnPulse(this._tip.set(
        Math.cos(a) * r, 0.7 + Math.random() * 0.9, -0.6 - Math.abs(Math.sin(a)) * r));
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
    // движение в журнал — 10 Гц, не каждый кадр: слоям и кадру прошлого хватит
    if ((this._moveAcc = (this._moveAcc || 0) + dt) >= SAMPLE_DT) {
      this._moveAcc = 0;
      this.log.push({ t: now, kind: 'move', pos: this._tip.clone() });
    }

    // живое окно: считаем назад от головы, пока точки свежее окна ленты.
    let live = 0;
    const span = Math.min(this.trailHead, TRAIL_N);
    for (let k = 0; k < span; k++) {
      if (now - this.trailAge[(w - k + TRAIL_N) % TRAIL_N] > TRAIL_LIFE) break;
      live++;
    }
    const start = w + TRAIL_N - live + 1;
    this.trailGeo.setDrawRange(start, live > 1 ? live : 0);
    this.trailGeo.attributes.position.needsUpdate = true;

    // Перемотка переключает презентацию: живое поле или кадр прошлого.
    // Запись истории не останавливается — «сейчас» продолжает копиться.
    const scrubbing = this.scrub < -0.5;
    const T = scrubbing ? now + this.scrub : now; // «сейчас» глазами наблюдателя
    this.trail.visible = !scrubbing;
    this.pastTrail.visible = scrubbing;
    let pastN = 0;
    if (scrubbing) {
      pastN = this.buildPastTrail(T);
    } else if (live > 1) {
      // тепло живой ленты: цвет каждой нарисованной точки — её возраст
      for (let k = 0; k < live; k++) {
        const c = heatColor(now - this.trailAge[(start + k) % TRAIL_N], TRAIL_LIFE);
        const a = (start + k) * 3;
        this.trailCol[a] = c.r; this.trailCol[a + 1] = c.g; this.trailCol[a + 2] = c.b;
      }
      this.trailGeo.attributes.color.needsUpdate = true;
    }

    // импульсы: рост и диффузия — от момента T, если смотрим прошлое.
    // Диффузия: кольцо растёт как √t, яркость падает экспоненциально —
    // импульс честно расплывается, а не тускнеет по линейке таймера.
    // Импульсы, которых на T ещё нет или уже нет, скрываются вместе со
    // сферами попадания: кадр прошлого read-only и не ловит луч.
    let alive = 0;
    for (const pu of this.pulses) {
      const age = T - pu.at;
      const show = age >= 0 && age <= KEEP;
      pu.mesh.visible = pu.hit.visible = show;
      if (!show) continue;
      alive++;
      const lift = pu === this.hovered ? 1.18 : 1; // наведённый ✦ приподнимается
      pu.mesh.scale.setScalar((0.05 + Math.sqrt(age) * 0.12) * lift);
      pu.mesh.material.color.copy(heatColor(age, KEEP));
      pu.mesh.material.opacity = Math.min(1,
        (0.05 + 0.9 * Math.exp(-age / 18)) * (pu === this.hovered ? 1.9 : 1));
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

    // подпись выбранного импульса: над кольцом, лицом к наблюдателю.
    // Если в кадре прошлого этот ✦ ещё не родился — подпись тоже гаснет.
    const showLabel = !!this.selected && this.selected.mesh.visible;
    if (showLabel) {
      this.label.position.set(
        this.selected.pos.x, this.selected.pos.y + 0.16, this.selected.pos.z);
    }
    if (this.label.visible !== showLabel) this.label.visible = showLabel;

    if ((this._st = (this._st || 0) + dt) > 0.5) {
      this._st = 0;
      if (this.selected) this.labelBody.text = `${this.fmtAgo(this.selected.at)} · layers −1…−4 s`;
      if (scrubbing) {
        this.stat(`past ${(-this.scrub).toFixed(0)} s · ghost + trail ${pastN} pts · ✦ alive ${alive}/${this.pulses.length} · ${LEGEND}`);
      } else if (this.selected) {
        this.stat(`✦ ${this.fmtAgo(this.selected.at)} · layers ${n} pts · tap ✦ again — close · ${LEGEND}`);
      } else {
        this.stat(`live · events ${this.log.length} · pulses ${this.pulses.length} · tap ✦ — layers · ${LEGEND}`);
      }
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

    // Кадр прошлого: тёплый призрак в перемотанном прошлом, рядом с живым
    // тобой. В живом режиме призрак скрыт — прошлое и так видно в ленте.
    if (scrubbing) {
      this.ghostPts.visible = this.ghostPoseAt(T);
    } else {
      this.ghostPts.visible = false;
    }
  }

  dispose() {
    if (this._gone) return; // идемпотентно: повторный вызов ничего не ломает
    this._gone = true;
    this.trailGeo.dispose(); this.trail.material.dispose();
    this.pastGeo.dispose(); this.pastTrail.material.dispose();
    this.ringGeo.dispose(); this.hitGeo.dispose(); this.hitMat.dispose();
    for (const pu of this.pulses) pu.mesh.material.dispose();
    this.pulses = [];
    for (const l of this.timeLayers) { l.line.geometry.dispose(); l.line.material.dispose(); }
    this.ghostGeo.dispose(); this.ghostPts.material.dispose();
    this.label.dispose?.();
  }
}

const options = new xb.Options();
options.enableReticles();
options.world?.enableAnchors?.();
options.xrButton.showEnterSimulatorButton = true;
options.setAppTitle('ECHO//ROOM');
options.setAppDescription('След и импульсы держат минуту. Тап по ✦ — слои, слайдер — кадр прошлого.');

enableAutomation(options);
installXrGuards();
installLaunchShell(options, [
  'Вход — кнопка внизу: комната запомнит минуту движения',
  'Тап — импульс ✦, тап по старому ✦ — слои времени',
  'Слайдер — перемотка минуты: призрак поз и кадр прошлого',
  'Меню — панель внизу экрана',
]);
previewFromEyeHeight();

document.addEventListener('DOMContentLoaded', () => {
  xb.add(new EchoRoom());
  xb.init(options);
  watchXrButton();
});
