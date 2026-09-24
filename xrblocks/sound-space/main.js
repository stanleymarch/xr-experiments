import * as THREE from 'three';
import * as xb from 'xrblocks';
import {
  glowBlending, ribbonMaterial, shockRingMaterial, lineMaterial, makePoints, PALETTES,
} from '../common/fx.js?v=mobile-ux-24';
import { makeHud } from '../common/hud.js?v=mobile-ux-24';
import {
  enableAutomation, installLaunchShell, installXrGuards,
  isAutomation, previewFromEyeHeight, watchXrButton,
} from '../common/boot.js?v=mobile-ux-24';

// SOUND//SPACE — звук строит объём вокруг слушателя, а не плоскую ленту.
//
// 32 частотные оси стоят по кругу вокруг головы. Низ — тяжёлые широкие
// плиты у самого пола и ближе всего к телу, верх — тонкие высокие иглы
// дальше по радиусу. Амплитуда выдавливает оси наружу (звук расходится от
// слушателя), поэтому бас толкает всей плитой, а верх — только кончиком.
// По высоте оси едет история: низ — «сейчас», верх — четверть секунды назад,
// волна звука буквально растёт вверх.
//
// Тембр (RMS / спектральный centroid / flux-шумность) переключает материал:
// SPEECH — нервная рябь и шипы, MUSIC — ровные волны, QUIET — спокойный пол.
//
// FREEZE копит галерею: каждый снимок — самостоятельная скульптура в комнате,
// новый встаёт рядом с предыдущим, старейшая вытесняется и гаснет. Живое
// поле вокруг продолжает жить, прошлое стоит и не мерцает: минута разговора
// остаётся рядом как пространственная история. Снимок можно перенести
// (тянуть тело), повернуть (тянуть кольцо) и растворить (держать или
// squeeze). CLEAR стирает всё. Без сервера, без AI, 0 ₽.

const FFT_SIZE = 1024;
const BANDS = 32;          // частотных осей по кругу
const SEGS = 22;           // кадров истории в высоту каждой оси
const BIN_HI = 0.62;       // доля спектра в раскладке: до ~13 кГц при 44/48 кГц
const TAU = Math.PI * 2;

// Пространственная архитектура частот.
const R_MIN = 0.82, R_MAX = 1.44;     // низ ближе к телу, верх дальше
const H_MIN = 0.14, H_MAX = 1.35;     // низ низкий, верх высокий
const W_MIN = 0.19, W_MAX = 0.03;     // низ широкий, верх тонкий
const DISP_LO = 0.30, DISP_HI = 0.15; // смещение наружу: бас тяжёлый, верх пиками
const TILT_LO = 0.7, TILT_HI = 2.1;   // компенсация спада спектра к верхам

const FLUX_LAG = 6;        // flux меряем к спектру 0.1 с назад, а не к соседнему кадру
const DUST = 160;          // точек поля давления
const SCULPT_SCALE = 0.5;  // скульптура-снимок: тот же объект вдвое меньше
const SCULPT_DIST = 1.95;  // первый снимок — в комнате перед слушателем
const SCULPT_GAP = 0.62;   // шаг ряда: каждый следующий встаёт рядом с предыдущим
const GALLERY = 5;         // сколько снимков держит история, старейшая вытесняется
const HOLD_DELETE = 0.72;  // сколько держать снимок, чтобы его растворить
const HOLD_SLOP = 0.06;    // дальше этого — уже drag, а не hold
const VANISH = 0.55;       // сколько гаснет вытеснённый или стёртый снимок
const WARM_FRESH = 0.16;   // тинт свежего снимка: ещё почти спектральный
const WARM_OLD = 0.78;     // тинт минутного: весь в тёплом «прошлом»

const bandF = (b) => b / (BANDS - 1);
const bandRadius = (b) => R_MIN + (R_MAX - R_MIN) * bandF(b);
const bandHeight = (b) => H_MIN + (H_MAX - H_MIN) * Math.pow(bandF(b), 1.15);
const bandWidth = (b) => W_MIN + (W_MAX - W_MIN) * Math.pow(bandF(b), 0.85);
const bandGain = (b) => DISP_LO + (DISP_HI - DISP_LO) * bandF(b);
const bandPeak = (b) => 1 + 1.7 * bandF(b);   // смещение сосредоточено у вершины оси

// Цвет = частота: бас фиолетовый, середина — палитра sound, верх ледяной.
const HUE_LO = new THREE.Color(0x6b34ff);
const HUE_MID = new THREE.Color(PALETTES.sound[1]);
const HUE_HI = new THREE.Color(0xcdf3ff);
const MEM_WARM = new THREE.Color(0xffb478);   // сдвиг снимка в «тёплое прошлое»
const WHITE_HOT = new THREE.Color(0xffffff);  // раскаление плинта при hold
const BAND_IDLE = new THREE.Color(0x8fa8c8);  // кольцо-ручка: покой
const BAND_HOT = new THREE.Color(0xeaf6ff);   // кольцо-ручка: наведение/drag

// Тинт состояния поверх частотного градиента.
const TINTS = {
  QUIET: new THREE.Color(0.50, 0.46, 0.86),
  MUSIC: new THREE.Color(1.05, 0.94, 1.30),
  SPEECH: new THREE.Color(0.86, 1.16, 1.36),
};

function freqColor(f, warm = 0) {
  const c = f < 0.5
    ? HUE_LO.clone().lerp(HUE_MID, f * 2)
    : HUE_MID.clone().lerp(HUE_HI, (f - 0.5) * 2);
  return warm ? c.lerp(MEM_WARM, warm) : c;
}

function circleGeometry(radius, segs = 72) {
  const p = new Float32Array(segs * 3);
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * TAU;
    p[i * 3] = Math.cos(a) * radius;
    p[i * 3 + 2] = Math.sin(a) * radius;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  return g;
}

// Живой материал осей. fx.ribbonMaterial красит по position.z, но здесь
// амплитуда живёт в атрибуте aDisp (смещение наружу по кругу) и меняется
// каждый кадр, поэтому шейдер свой — он же и переключает состояние:
// рябь речи, волна музыки, ровное дыхание тишины.
function liveBladeMaterial() {
  return glowBlending(new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: {value: 0},
      uOpacity: {value: 0.92},
      uLow: {value: HUE_LO.clone()},
      uMid: {value: HUE_MID.clone()},
      uHigh: {value: HUE_HI.clone()},
      uTint: {value: new THREE.Color(1, 1, 1)},
      uState: {value: new THREE.Vector3(1, 0, 0)}, // x тишина, y речь, z музыка
      uRms: {value: 0},
      uFlux: {value: 0},
      uCentroid: {value: 0.5},
      uDispLo: {value: DISP_LO},
      uDispHi: {value: DISP_HI},
    },
    vertexShader: /* glsl */`
      attribute float aDisp;
      attribute float aF;
      uniform float uDispLo, uDispHi;
      varying float vAmp;
      varying float vBand;
      varying vec2 vUv;
      void main() {
        // Нормируем на собственную амплитуду оси: верх тоже должен уметь
        // раскаляться, хотя смещается втрое меньше баса.
        float gmax = mix(uDispLo, uDispHi, aF);
        vAmp = clamp(aDisp / max(0.001, gmax), 0.0, 1.6);
        vBand = aF;
        vUv = uv;
        vec3 out3 = normalize(vec3(position.x, 0.0, position.z) + vec3(1e-5, 0.0, 0.0));
        vec3 p = position + out3 * aDisp;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uLow, uMid, uHigh, uTint;
      uniform float uOpacity, uTime, uRms, uFlux, uCentroid;
      uniform vec3 uState; // x — тишина, y — речь, z — музыка
      varying float vAmp;
      varying float vBand;
      varying vec2 vUv;

      float hash(float n) { return fract(sin(n * 12.9898) * 43758.5453); }

      void main() {
        float hot = smoothstep(0.02, 0.60, vAmp);
        // centroid двигает границу холода: много верхов — ледяная зона ближе.
        float g = clamp(vBand * (1.0 + (uCentroid - 0.5) * 0.6), 0.0, 1.0);
        vec3 base = g < 0.5 ? mix(uLow, uMid, g * 2.0) : mix(uMid, uHigh, (g - 0.5) * 2.0);
        // Покой тоже светится: частотную архитектуру видно и в тишине,
        // громкость только раскаляет её до белого.
        vec3 c = mix(base * 0.70, base * 1.75 + vec3(0.30), hot)
               * uTint * (0.88 + 0.42 * uRms);

        float q = uState.x, sp = uState.y, mu = uState.z;
        float nervous = hash(floor(vUv.y * 12.0) * 3.7 + floor(uTime * 18.0)) * 2.0 - 1.0;
        float spike = sin(vUv.y * 82.0 - uTime * 24.0);
        float wave  = 0.5 + 0.5 * sin(vUv.y * 13.0 - uTime * 2.4 + vBand * 6.283);
        float calm  = 0.5 + 0.5 * sin(vUv.y * 2.6 + uTime * 0.6 + vBand * 4.0);
        // Речь — рваная рябь, музыка — бегущая волна, тишина — ровное дыхание.
        float m = 1.0 + sp * (0.50 * nervous + 0.22 * spike)
                      + mu * 0.35 * (wave - 0.5)
                      + q * (0.45 * calm - 0.50);

        float a = uOpacity * (0.45 + 0.85 * hot) * m;
        a *= 0.88 + 0.12 * sin(uTime * 2.6 - vUv.y * 7.0);
        // Кончики высоких осей вспыхивают отдельно: частоты видно и по цвету,
        // и по пикам, и по радиусу.
        a *= 1.0 + 0.70 * smoothstep(0.55, 1.0, vAmp) * smoothstep(0.45, 1.0, vBand);
        // Шумность спектра тоже видно: чем рванее меняется тембр, тем
        // нервнее дрожат вершины осей.
        a *= 1.0 + clamp(uFlux * 1.6, 0.0, 1.0) * 0.35 * sin(vUv.y * 130.0 - uTime * 38.0);
        float edge = smoothstep(0.0, 0.16, vUv.x) * (1.0 - smoothstep(0.84, 1.0, vUv.x))
                   * (1.0 - 0.45 * smoothstep(0.80, 1.0, vUv.y));
        gl_FragColor = vec4(c, clamp(a * edge, 0.0, 1.0));
      }`,
  }));
}

// Единая геометрия всех осей: один draw call на всю архитектуру.
// Позиции — «покой» (частотная форма), амплитуда приходит из aDisp.
// У каждой оси три колонки вершин: боковые гасятся мягким краем в шейдере,
// с двумя колонками погасить было бы нечего — погасла бы вся ось целиком.
const COLS = 3;

function buildArchitecture() {
  const rows = SEGS + 1;
  const count = BANDS * rows * COLS;
  const pos = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const bf = new Float32Array(count);
  const disp = new Float32Array(count);
  const index = new Uint16Array(BANDS * SEGS * (COLS - 1) * 6);
  let v = 0, t = 0;
  for (let b = 0; b < BANDS; b++) {
    const phi = bandF(b) * TAU - Math.PI / 2;   // ось низких частот смотрит вперёд
    const ux = Math.cos(phi), uz = Math.sin(phi);
    const tx = Math.sin(phi), tz = -Math.cos(phi);
    const R = bandRadius(b), h = bandHeight(b), w = bandWidth(b);
    const base = v;
    for (let r = 0; r < rows; r++) {
      const y = h * (r / SEGS);            // r = 0 — пол и «сейчас», r = SEGS — прошлое
      for (let c = 0; c < COLS; c++) {
        const u = c / (COLS - 1);
        const x = (u - 0.5) * w;
        pos[v * 3] = ux * R + tx * x;
        pos[v * 3 + 1] = y;
        pos[v * 3 + 2] = uz * R + tz * x;
        uvs[v * 2] = u;
        uvs[v * 2 + 1] = r / SEGS;
        bf[v] = bandF(b);
        v++;
      }
    }
    for (let r = 0; r < SEGS; r++) {
      for (let c = 0; c < COLS - 1; c++) {
        const a0 = base + r * COLS + c, b0 = a0 + 1;
        const c0 = a0 + COLS, d0 = c0 + 1;
        index[t++] = a0; index[t++] = b0; index[t++] = c0;
        index[t++] = b0; index[t++] = d0; index[t++] = c0;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute('aF', new THREE.BufferAttribute(bf, 1));
  const dispAttr = new THREE.BufferAttribute(disp, 1);
  dispAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aDisp', dispAttr);
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  // Смещение выходит за габариты покоя, поэтому сферу задаём с запасом:
  // иначе архитектура мигает на границе frustum culling.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, H_MAX * 0.5, 0), R_MAX + H_MAX + 0.5);
  return {geo, dispAttr, disp};
}

class SoundSpace extends xb.Script {
  init() {
    this.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a2438, 1.6));
    const key = new THREE.DirectionalLight(0x88ccff, 1.0);
    key.position.set(0.5, 2, 0.5);
    this.add(key);

    // Вся архитектура — вокруг слушателя, центр встаёт под камеру в первом кадре.
    this.group = new THREE.Group();
    this.add(this.group);

    const arch = buildArchitecture();
    this.dispAttr = arch.dispAttr;
    this.disp = arch.disp;
    this.liveMat = liveBladeMaterial();
    this.live = new THREE.Mesh(arch.geo, this.liveMat);
    this.live.frustumCulled = false;
    this.live.renderOrder = -1;        // HUD рисуется поверх структуры
    this.group.add(this.live);

    // История: кольцо из SEGS кадров, в каждом — BANDS значений.
    this.hist = new Float32Array(SEGS * BANDS);
    this.hrow = 0;
    this.newest = SEGS - 1;
    this.frames = 0;
    this.peakW = new Float32Array(BANDS * (SEGS + 1));
    this.gain = new Float32Array(BANDS);
    for (let b = 0; b < BANDS; b++) {
      this.gain[b] = bandGain(b);
      const p = bandPeak(b);
      for (let r = 0; r <= SEGS; r++) this.peakW[b * (SEGS + 1) + r] = Math.pow(r / SEGS, p);
    }

    // Спектр: буферы переиспользуются, в кадре ни одной аллокации.
    this.raw = new Float32Array(BANDS);
    this.shaped = new Float32Array(BANDS);
    this.fhistArr = new Float32Array(FLUX_LAG * BANDS);
    this.fhist = 0;
    this.metrics = {rms: 0, centroid: 0.5, fluxRel: 0, noise: 0};
    this.noise = 0;       // огибающая шумности спектра
    this.peak = 0.05;     // медленно затухающий пик громкости
    this.slow = 0.05;     // медленная средняя: по ней ловим удар
    this.w = {quiet: 1, speech: 0, music: 0};
    this.state = 'QUIET';
    this.want = 'QUIET';
    this.wantT = 0;
    this.tint = TINTS.QUIET.clone();

    this.time = 0;
    this.statT = -1;
    this.lastHit = -10;
    this.anchored = false;
    this.audio = null;
    this.perm = false;
    // Галерея снимков: живые записи (старейшая первой) и угасающие.
    this.gallery = [];
    this.dying = [];
    this.selected = null;
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._autoT = isAutomation() ? 0 : null;
    this.impacts = [];
    this.ringGeo = new THREE.RingGeometry(0.94, 1.0, 48);

    // Кольцо centroid: где сейчас центр тяжести спектра, там и светится пол.
    this.haloR = R_MIN;
    this.haloPulse = 0;
    this.baseRingGeo = circleGeometry(R_MIN);
    this.haloGeo = circleGeometry(1);
    this.baseRing = new THREE.LineLoop(this.baseRingGeo, lineMaterial(HUE_LO.getHex(), 0.16));
    this.baseRing.position.y = 0.02;
    this.halo = new THREE.LineLoop(this.haloGeo, lineMaterial(0xffffff, 0.55));
    this.halo.position.y = 0.03;
    this.halo.scale.setScalar(R_MIN);
    this.group.add(this.baseRing, this.halo);

    // Поле давления: медленный дрейф наружу, дрожь ∝ flux.
    this.dust = makePoints(DUST, {size: 0.022, color: 0xffffff, opacity: 0.55});
    this.dust.points.renderOrder = -1;
    this.dust.points.frustumCulled = false;
    this.group.add(this.dust.points);
    this.dr = new Float32Array(DUST);
    this.da = new Float32Array(DUST);
    this.dy = new Float32Array(DUST);
    this.ds = new Float32Array(DUST);
    this.dv = new Float32Array(DUST);
    for (let i = 0; i < DUST; i++) {
      this.dr[i] = 0.35 + Math.random() * 2.05;
      this.da[i] = Math.random() * TAU;
      this.dy[i] = 0.06 + Math.random() * 1.5;
      this.ds[i] = Math.random();
      this.dv[i] = (Math.random() - 0.5) * 0.5;
    }
    this.dustColor = new THREE.Color(1, 1, 1);

    this.hud = makeHud({
      title: 'SOUND//SPACE',
      stat: 'tap — FREEZE · drag a snapshot · hold to dissolve · MIC for live input',
      // Центрированный дефолт: боковой оффсет не попадает в портретный фрустум.
      buttons: [
        {id: 'mic', label: 'MIC', icon: 'mic', onTap: () => this.enableMic()},
        {id: 'freeze', label: 'FREEZE', onTap: () => this.freeze()},
        {id: 'clear', label: 'CLEAR', onTap: () => this.clear()},
      ],
      width: 0.62,
    });
    this.add(this.hud.card);
  }

  stat(s) { this.hud.setStat(s); }

  // Снимок, владеющий этим объектом (или его предок): userData на группе.
  sculptureOf(target) {
    for (let o = target; o; o = o.parent) {
      if (o.userData && o.userData.snapshot) return o.userData.snapshot;
    }
    return null;
  }

  // Сцена-команда: освобождённый tap/click/pinch по пустому месту — NEW снимок.
  // Для «пустого» тапа capture имеет kind 'none' и completed=false, поэтому
  // валидность проверяем по reason, а не по completed (контракт SelectEnd).
  onSelectEnd(event) {
    if (event.reason !== 'released') return;
    if (this.hud.owns(event?.target)) return;
    if (this.sculptureOf(event?.target)) return;   // целевые события — ниже
    this.freeze();
  }

  // Squeeze (grip) растворяет выбранный снимок; выбор — tap по скульптуре.
  onSqueezeEnd() {
    if (this.selected && !this.selected.doomed) {
      this.retire(this.selected);
      this.stat(`SQUEEZE · snapshot dissolved · ${this.gallery.length} left`);
    }
  }

  // Целевая ветка: здесь и hold-таймер, и выбор. Hold живёт на самом снимке
  // (состояние — у владельца объекта, не в глобальном слоте), а не в
  // onObjectLongSelect: manipulation-захват поглощает long-select SDK
  // (Interaction.ts:updateLongSelect), а нам нужен один механизм на все
  // источники — луч, pinch и прямое касание.
  onObjectSelectStart(event) {
    const e = this.sculptureOf(event.target);
    if (e && !e.doomed) e.hold = {t: 0, origin: e.group.position.clone()};
  }

  onObjectSelectEnd(event) {
    const e = this.sculptureOf(event.target);
    if (e) e.hold = null;
    if (e && !e.doomed) this.selected = e;
  }

  onObjectManipulate(event) {
    const e = this.sculptureOf(event.owner ?? event.target);
    if (!e) return;
    e.dragging = event.phase === 'start' || event.phase === 'update';
  }

  onHoverEnter(event) {
    const e = this.sculptureOf(event.target);
    if (e) e.hover = true;
  }

  onHoverExit(event) {
    const e = this.sculptureOf(event.target);
    if (e) e.hover = false;
  }

  async enableMic() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio: true});
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') await ctx.resume();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.65;
      src.connect(analyser);
      this.audio = {ctx, src, analyser, stream, bins: new Uint8Array(analyser.frequencyBinCount)};
      this.perm = true;
      this.frames = 0;
      this.hist.fill(0);
      this.stat('MIC — speak, clap, play: frequencies rise around you');
    } catch (e) {
      this.stat(`mic unavailable (${e.name}) — demo generator`);
    }
  }

  // Демо без микрофона: речь → музыка → удары → тишина, 24 секунды по кругу.
  demo(t, out) {
    const phase = t % 24;
    if (phase < 8) {                     // речь: плывущие форманты, слоги, согласные
      const s = phase;
      const f1 = 0.13 + 0.09 * Math.sin(s * 1.9);
      const f2 = 0.36 + 0.06 * Math.sin(s * 3.1 + 1.2);
      const syl = 0.35 + 0.65 * Math.abs(Math.sin(s * 5.5));         // слоговой ритм
      const cons = Math.max(0, 1 - ((s * 3.5) % 1) * 6);             // согласные: вспышки
      for (let b = 0; b < BANDS; b++) {
        const f = bandF(b);
        const g = Math.exp(-((f - f1) * (f - f1)) / 0.0030)
                + Math.exp(-((f - f2) * (f - f2)) / 0.0055) * 0.7
                + Math.exp(-((f - 0.72) * (f - 0.72)) / 0.02) * 0.25;  // шипящие
        out[b] = Math.min(1.2, g * syl * (0.85 + 0.3 * Math.random())
          + cons * 0.45 * Math.exp(-f * 0.8) * (0.5 + Math.random()));
      }
    } else if (phase < 16) {             // музыка: гармоническая гребёнка, ровный тон
      const s = phase - 8;
      for (let b = 0; b < BANDS; b++) {
        const f = bandF(b);
        const comb = 0.45 + 0.55 * Math.cos(f * 46.0);
        const sway = 0.92 + 0.08 * Math.sin(s * 1.6 + f * 5.0);
        out[b] = Math.min(1.2, Math.exp(-f * 2.2) * comb * sway * 1.6);
      }
    } else if (phase < 20) {             // удары: тишина и резкие хлопки
      const s = phase - 16;
      const hit = Math.max(0, 1 - (s % 1.6) * 3.2);
      for (let b = 0; b < BANDS; b++) {
        out[b] = 0.012 + hit * 0.9 * Math.exp(-bandF(b) * 1.4) * (0.75 + 0.5 * Math.random());
      }
    } else {                             // тишина: спокойный пол
      for (let b = 0; b < BANDS; b++) {
        out[b] = 0.012 + 0.008 * (0.5 + 0.5 * Math.sin(t * 0.8 + b * 0.5));
      }
    }
    return out;
  }

  // Спектр в 32 осях: лог-раскладка бинов + наклон — без наклона верха не видно.
  spectrum() {
    const out = this.raw;
    if (this.audio) {
      const bins = this.audio.bins;
      this.audio.analyser.getByteFrequencyData(bins);
      const top = bins.length * BIN_HI;
      let i0 = 1;
      for (let b = 0; b < BANDS; b++) {
        const i1 = Math.min(bins.length, Math.max(i0 + 1, Math.round(Math.pow(top, (b + 1) / BANDS))));
        let sum = 0;
        for (let i = i0; i < i1; i++) sum += bins[i];
        const v = sum / (i1 - i0) / 255;
        out[b] = Math.min(1.2, v * (TILT_LO + (TILT_HI - TILT_LO) * bandF(b)));
        i0 = i1;
      }
    } else {
      this.demo(this.time, out);
    }
    return out;
  }

  // Тембр: RMS, centroid (где центр тяжести спектра), flux (шумность).
  // Flux считаем к спектру 0.1 с назад и делим на суммарную энергию: так он
  // не зависит от громкости и от того, узкополосный звук или широкий —
  // речь меняет форму спектра быстро, затянутая нота почти нет.
  measure(raw, dt) {
    const m = this.metrics;
    const old = this.fhist * BANDS;      // здесь лежит спектр FLUX_LAG кадров назад
    let mag = 0, cw = 0, sq = 0, fl = 0;
    for (let b = 0; b < BANDS; b++) {
      const v = raw[b];
      mag += v;
      cw += v * bandF(b);
      sq += v * v;
      fl += Math.max(0, v - this.fhistArr[old + b]);
    }
    m.rms = Math.sqrt(sq / BANDS);
    m.centroid = mag > 1e-4 ? cw / mag : 0.5;
    m.fluxRel = fl / (mag + 0.05);
    // Огибающая шумности: вспышки согласных держат состояние SPEECH, а не
    // заставляют материал дёргаться на каждом кадре.
    this.noise = Math.max(m.fluxRel, this.noise * Math.exp(-dt / 0.35));
    m.noise = this.noise;
    for (let b = 0; b < BANDS; b++) this.fhistArr[old + b] = raw[b];
    this.fhist = (this.fhist + 1) % FLUX_LAG;

    const quietThr = Math.max(0.05, this.peak * 0.22);
    let want;
    if (m.rms < quietThr * (this.state === 'QUIET' ? 1.3 : 1)) want = 'QUIET';
    else if (this.noise > (this.state === 'SPEECH' ? 0.045 : 0.07)) want = 'SPEECH';
    else want = 'MUSIC';
    if (want !== this.want) { this.want = want; this.wantT = 0; }
    this.wantT += dt;
    if (this.wantT > 0.16 && want !== this.state) this.state = want;

    // Удар: мгновенный скачок громкости над медленной средней.
    if (m.rms > 0.15 && m.rms > this.slow * 2.4 && this.time - this.lastHit > 0.6) {
      this.lastHit = this.time;
      this.haloPulse = 1;
      this.burst();
    }
    this.slow += (m.rms - this.slow) * Math.min(1, dt / 1.2);
    this.peak = Math.max(m.rms, this.peak * Math.exp(-dt / 6));
  }

  // Форма спектра по состоянию: речь вырезает форманты и дрожит,
  // музыка сглаживает соседние оси, тишина прижимает всё к полу.
  shape(raw) {
    const out = this.shaped;
    const quiet = this.w.quiet, speech = this.w.speech, music = this.w.music;
    for (let b = 0; b < BANDS; b++) {
      const v = raw[b];
      const l = raw[b > 0 ? b - 1 : 0], r = raw[b < BANDS - 1 ? b + 1 : BANDS - 1];
      const spiky = Math.max(0, v - 0.22) * 1.28;
      const smooth = v * 0.5 + (l + r) * 0.25;
      out[b] = quiet * v * 0.30 + speech * spiky + music * smooth;
    }
    if (speech > 0.01) {
      for (let b = 0; b < BANDS; b++) {
        out[b] = Math.max(0, out[b] + speech * 0.09 * (Math.random() * 2 - 1));
      }
    }
    return out;
  }

  // Раскладываем историю по высоте осей и выдавливаем их наружу.
  sculpt() {
    const d = this.disp, H = this.hist, W = this.peakW;
    const breathAmp = 0.010 + 0.022 * this.w.quiet;
    let v = 0;
    for (let b = 0; b < BANDS; b++) {
      const gain = this.gain[b];
      const ph = b * 0.53;
      for (let r = 0; r <= SEGS; r++) {
        const row = (this.newest - r + SEGS) % SEGS;
        // «Спокойный пол»: даже в тишине оси медленно дышат, но не стоят колом.
        const breath = breathAmp * (0.6 + 0.4 * Math.sin(this.time * 0.7 + ph + r * 0.21));
        const val = (H[row * BANDS + b] * gain + breath) * W[b * (SEGS + 1) + r];
        for (let c = 0; c < COLS; c++) d[v++] = val;
      }
    }
    this.dispAttr.needsUpdate = true;
  }

  pushHistory() {
    const shaped = this.shape(this.raw);
    const hp = this.hrow * BANDS;
    for (let b = 0; b < BANDS; b++) this.hist[hp + b] = shaped[b];
    this.hrow = (this.hrow + 1) % SEGS;
    this.newest = (this.hrow - 1 + SEGS) % SEGS;
    this.frames++;
  }

  // Скульптура-снимок: тот же частотный объект, только застывший и стоящий
  // в комнате. Живёт рядом с живым полем, а не поверх него. Каждая — свой
  // объект со своей геометрией: история копится, а не перезаписывается.
  freeze() {
    if (!this.frames) return;
    const entry = this.makeSculpture(this.disp, this.state);
    this.gallery.push(entry);
    while (this.gallery.length > GALLERY) this.retire(this.gallery.shift());
    this.stat(`FREEZE ${this.state} · ${this.gallery.length}/${GALLERY} snapshots in the room`);
  }

  // Ряд истории: первый снимок встаёт перед слушателем, каждый следующий —
  // на шаг правее направления взгляда от предыдущего. Ряд «гнётся» вслед за
  // тем, куда смотрел человек, — это и есть пространственная запись минут.
  placeInRow(g) {
    const prev = this.gallery[this.gallery.length - 1];
    const cam = xb.core.camera;
    if (!prev) {
      const dir = this._fwd.set(0, 0, -1);
      if (cam) {
        cam.getWorldDirection(dir);
        dir.y = 0;
        if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1); else dir.normalize();
      }
      g.position.set(
        (cam ? cam.position.x : 0) + dir.x * SCULPT_DIST, 0,
        (cam ? cam.position.z : 0) + dir.z * SCULPT_DIST
      );
      return;
    }
    const right = this._right.set(1, 0, 0);
    if (cam) {
      cam.getWorldDirection(this._fwd);
      this._fwd.y = 0;
      if (this._fwd.lengthSq() > 1e-6) {
        this._fwd.normalize();
        right.set(-this._fwd.z, 0, this._fwd.x);
      }
    }
    g.position.copy(prev.group.position).addScaledVector(right, SCULPT_GAP);
  }

  makeSculpture(disp, state) {
    const g = new THREE.Group();
    this.placeInRow(g);
    g.scale.setScalar(SCULPT_SCALE);
    // Управление снимком — manipulation на самом объекте (Interaction
    // manual): тянуть тело — переносить, тянуть кольцо — поворачивать.
    // Явный surface-action обязателен: когда включены два primary-действия,
    // без handle SDK не выбирает ни одно (ManipulationManager.resolve).
    g.xb = {
      manipulation: {
        actions: {translate: true, rotate: {axis: 'y', space: 'world'}},
        handle: {action: 'translate'},
      },
    };

    const entry = {
      group: g, blades: [], plinth: null, band: null,
      born: this.time, state, doomed: false, fade: 1,
      hover: false, dragging: false, holdP: 0, hold: null,
    };
    g.userData.snapshot = entry;

    let v = 0;
    for (let b = 0; b < BANDS; b++) {
      const f = bandF(b);
      const h = bandHeight(b), w = bandWidth(b), R = bandRadius(b);
      const geo = new THREE.PlaneGeometry(w, h, COLS - 1, SEGS);
      geo.translate(0, h / 2, 0);                // ось стоит на полу
      const pa = geo.attributes.position;
      for (let r = 0; r <= SEGS; r++) {
        for (let c = 0; c < COLS; c++) pa.setZ(r * COLS + c, disp[v++]);
      }
      pa.needsUpdate = true;
      // ribbonMaterial красит по position.z — ровно тот случай, для которого
      // он есть. Базовый цвет помним отдельно: тинт возраста едет каждый кадр.
      const mesh = new THREE.Mesh(geo, ribbonMaterial({
        color: freqColor(f, WARM_FRESH), opacity: 0.62, live: false,
      }));
      mesh.userData.base = freqColor(f, WARM_FRESH);
      const phi = f * TAU - Math.PI / 2;
      mesh.position.set(Math.cos(phi) * R, 0, Math.sin(phi) * R);
      mesh.rotation.y = Math.PI / 2 - phi;
      g.add(mesh);
      entry.blades.push(mesh);
    }
    const plinth = new THREE.LineLoop(circleGeometry(R_MIN), lineMaterial(MEM_WARM.getHex(), 0.42));
    plinth.scale.setScalar(1.08);
    plinth.position.y = 0.02;
    // Плинт — индикатор, а не мишень: у Line-геометрии порог попадания
    // ~1 м (Raycaster.params.Line), она бы перехватывала лучи мимо скульптуры.
    plinth.xb = {pointerEvents: 'none'};
    g.add(plinth);
    entry.plinth = plinth;

    // Кольцо-ручка: отдельная поверхность, выбирающая rotate у владельца
    // (interaction manual: «use a handle when one surface must select an
    // action»). Высоко над осями не вешаем — по нему должны попасть лучом.
    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(1.56, 1.56, 0.085, 40, 1, true),
      glowBlending(new THREE.MeshBasicMaterial({
        color: BAND_IDLE.getHex(), transparent: true, opacity: 0.22,
        side: THREE.DoubleSide, depthWrite: false,
      }))
    );
    band.position.y = 0.15;
    band.xb = {manipulationHandle: {action: 'rotate'}};
    g.add(band);
    entry.band = band;

    this.add(g);
    return entry;
  }

  // Снимок покидает историю: из пула — сразу, из сцены — после угасания.
  // manipulation снимается в момент приговора: SDK сам закроет сессию
  // (валидация владельца в ManipulationManager), без перетаскивания призрака.
  retire(entry) {
    if (entry.doomed) return;
    entry.doomed = true;
    const i = this.gallery.indexOf(entry);
    if (i >= 0) this.gallery.splice(i, 1);
    if (this.selected === entry) this.selected = null;
    entry.hold = null;
    entry.group.xb = {manipulation: false, pointerEvents: 'none'};
    this.dying.push(entry);
  }

  disposeSculpture(entry) {
    this.remove(entry.group);
    entry.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    entry.group.userData.snapshot = null;
  }

  // Возраст записи: тепло тинта растёт со временем, поэтому ряд читается
  // как история и без подписей — свежий спектральный, минутный тёплый.
  paintEntry(e) {
    const age = Math.max(0, this.time - e.born);
    const warm = e.doomed ? 1 : WARM_FRESH + (WARM_OLD - WARM_FRESH) * Math.min(1, age / 60);
    for (let i = 0; i < e.blades.length; i++) {
      const m = e.blades[i];
      const u = m.material.uniforms;
      u.uColor.value.copy(m.userData.base).lerp(MEM_WARM, warm);
      u.uOpacity.value = 0.62 * e.fade;
    }
    // Плинт — индикатор состояния записи: пульс выбранной, яркая при
    // наведении и перетаскивании, раскаляется по мере hold-удаления.
    const pm = e.plinth.material;
    let po = 0.40;
    if (e === this.selected) po = 0.55 + 0.28 * (0.5 + 0.5 * Math.sin(this.time * 5.2));
    if (e.hover) po = Math.max(po, 0.72);
    if (e.dragging) po = Math.max(po, 0.85);
    pm.color.copy(MEM_WARM);
    if (e.holdP > 0) {
      pm.color.lerp(WHITE_HOT, e.holdP);
      po = Math.max(po, 0.45 + 0.55 * e.holdP);
    }
    pm.opacity = po * e.fade;
    const bm = e.band.material;
    const hot = e.holdP > 0 ? 1 : (e.hover || e.dragging || e === this.selected) ? 0.6 : 0;
    bm.color.lerpColors(BAND_IDLE, BAND_HOT, hot);
    bm.opacity = (0.22 + 0.33 * hot) * e.fade;
  }

  ageText(e) {
    const s = Math.max(0, this.time - e.born);
    return s < 60 ? `${s | 0}s ago` : `${(s / 60) | 0}m ago`;
  }

  // Ударная волна: плоское кольцо расходится от слушателя по полу,
  // проходя сквозь основания осей.
  burst() {
    const m = new THREE.Mesh(this.ringGeo, shockRingMaterial(0xffffff));
    m.rotation.x = -Math.PI / 2;
    m.position.set(this.group.position.x, 0.05, this.group.position.z);
    m.renderOrder = 2;
    this.add(m);
    this.impacts.push({mesh: m, t: 0});
  }

  clear() {
    for (const e of this.gallery.splice(0)) this.retire(e);
    this.hist.fill(0);
    this.fhistArr.fill(0);
    this.disp.fill(0);
    this.dispAttr.needsUpdate = true;
    this.frames = 0;
    this.state = 'QUIET';
    this.want = 'QUIET';
    this.wantT = 0;
    this.noise = 0;
    this.w = {quiet: 1, speech: 0, music: 0};
    this.tint.copy(TINTS.QUIET);
    this.stat('CLEAR · room swept, listening to silence');
  }

  update() {
    this.hud.update();
    const dt = Math.min(xb.getDeltaTime(), 0.05);
    this.time += dt;
    const cam = xb.core.camera;
    if (!this.anchored && cam) {
      this.group.position.set(cam.position.x, 0, cam.position.z);
      this.anchored = true;
    }

    this.measure(this.spectrum(), dt);

    // Веса состояний едут плавно: материал меняется, а не щёлкает.
    const k = Math.min(1, dt / 0.28);
    const held = this.state === 'QUIET' ? 'quiet' : this.state === 'SPEECH' ? 'speech' : 'music';
    for (const name in this.w) this.w[name] += ((name === held ? 1 : 0) - this.w[name]) * k;

    this.pushHistory();
    this.sculpt();
    this.paint(dt);
    this.stepGallery(dt);

    for (const im of [...this.impacts]) {
      im.t += dt;
      const t = im.t / 0.9;
      // Геометрия 1.0 м: финал ~0.35 м радиуса, а не 3.4-метровые диски.
      im.mesh.scale.setScalar(0.08 + t * 0.27);
      im.mesh.material.uniforms.uT.value = Math.min(1, t);
      if (t >= 1) {
        this.remove(im.mesh);
        im.mesh.material.dispose();
        this.impacts.splice(this.impacts.indexOf(im), 1);
      }
    }

    // Автопресет ?test=1: галерея обязана жить и без рук — снимок сам
    // встаёт в ряд каждые 6 секунд, история наполняется на глазах.
    if (this._autoT !== null && (this._autoT += dt) >= 6) {
      this._autoT = 0;
      this.freeze();
    }

    this.statLine();
  }

  // Галерея: hold-таймер удалений, угасание и перекраска возраста.
  stepGallery(dt) {
    // Hold идёт по каждой записи отдельно (обратный ход — retire режет массив).
    for (let i = this.gallery.length - 1; i >= 0; i--) {
      const e = this.gallery[i];
      if (!e.hold) { e.holdP = 0; continue; }
      e.hold.t += dt;
      e.holdP = Math.min(1, e.hold.t / HOLD_DELETE);
      if (e.group.position.distanceToSquared(e.hold.origin) > HOLD_SLOP * HOLD_SLOP) {
        e.holdP = 0;                      // сдвинули — это drag, а не hold
        e.hold = null;
      } else if (e.hold.t >= HOLD_DELETE) {
        this.retire(e);
        this.stat(`HOLD · snapshot dissolved · ${this.gallery.length} left`);
      }
    }
    for (const e of [...this.dying]) {
      e.fade = Math.max(0, e.fade - dt / VANISH);
      if (e.fade <= 0) {
        this.dying.splice(this.dying.indexOf(e), 1);
        this.disposeSculpture(e);
      }
    }
    for (const e of this.gallery) this.paintEntry(e);
    for (const e of this.dying) this.paintEntry(e);
  }

  paint(dt) {
    const m = this.metrics;
    const u = this.liveMat.uniforms;
    // Цвет состояния едет вместе с весами: QUIET — приглушённый фиолетовый,
    // MUSIC — насыщенный, SPEECH — ледяной.
    this.tint.lerp(TINTS[this.state], Math.min(1, dt / 0.28));
    u.uTime.value = this.time;
    u.uRms.value = m.rms;
    u.uFlux.value = m.noise;
    u.uCentroid.value = m.centroid;
    u.uState.value.set(this.w.quiet, this.w.speech, this.w.music);
    u.uTint.value.copy(this.tint);

    this.haloPulse *= Math.exp(-dt * 3.2);
    const target = R_MIN + (R_MAX - R_MIN) * m.centroid;
    this.haloR += (target - this.haloR) * Math.min(1, dt * 4);
    this.halo.scale.setScalar(this.haloR + this.haloPulse * 0.45);
    // Кольцо светится цветом своей частотной зоны: центр тяжести видно телом.
    this.halo.material.color.copy(freqColor(m.centroid)).multiplyScalar(0.25 + 0.75 * m.rms);
    this.halo.material.opacity = 0.20 + 0.55 * Math.min(1, m.rms * 2.2);

    this.dustColor.lerp(this.tint, Math.min(1, dt * 1.4));
    this.dust.points.material.uniforms.uColor.value.copy(this.dustColor);
    this.dust.points.material.uniforms.uOpacity.value = 0.35 + 0.45 * m.rms + 0.3 * m.noise;
  }

  dustStep(dt) {
    const m = this.metrics;
    const drift = 0.05 + m.rms * 0.55;
    const turb = 0.004 + m.noise * 0.030;
    const pos = this.dust.pos;
    for (let i = 0; i < DUST; i++) {
      const i3 = i * 3;
      this.dr[i] += drift * (0.5 + this.ds[i]) * dt;
      if (this.dr[i] > 2.5) {
        this.dr[i] = 0.35 + Math.random() * 0.3;
        this.dy[i] = 0.06 + Math.random() * 1.5;
      }
      this.da[i] += this.dv[i] * dt * (0.3 + m.noise);
      const jx = (Math.random() - 0.5) * turb * 2;
      const jy = (Math.random() - 0.5) * turb * 2;
      pos[i3] = Math.cos(this.da[i]) * this.dr[i] + jx;
      pos[i3 + 1] = this.dy[i] + jy;
      pos[i3 + 2] = Math.sin(this.da[i]) * this.dr[i] + jx;
    }
    this.dust.geo.attributes.position.needsUpdate = true;
  }

  statLine() {
    if (this.time < 4) return;                       // сначала подсказка
    if (this.time - this.statT < 0.25) return;
    this.statT = this.time;
    const m = this.metrics;
    const hit = this.time - this.lastHit < 0.5 ? ' HIT' : '';
    const mem = this.gallery.length ? ` · ${this.gallery.length}/${GALLERY} SNAPS` : '';
    const sel = this.selected && !this.selected.doomed
      ? ` · SELECTED ${this.ageText(this.selected)} ${this.selected.state}` : '';
    this.stat(`${this.state}${hit} · ${this.perm ? 'MIC' : 'DEMO'}`
      + ` · centroid ${(m.centroid * 100) | 0} rms ${(m.rms * 100) | 0}`
      + ` flux ${(m.noise * 100) | 0}${mem}${sel}`);
  }

  dispose() {
    for (const e of this.gallery.splice(0)) this.disposeSculpture(e);
    for (const e of this.dying.splice(0)) this.disposeSculpture(e);
    for (const im of this.impacts) im.mesh.material.dispose();
    this.impacts = [];
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this.ringGeo.dispose();
    this.baseRingGeo.dispose();
    this.haloGeo.dispose();
    if (this.audio) {
      this.audio.src.disconnect();
      for (const t of this.audio.stream.getTracks()) t.stop();
      this.audio.ctx.close().catch(() => {});
      this.audio = null;
    }
  }
}

const options = new xb.Options();
// Микрофон не декларируется заранее: браузеры выдают доступ только из жеста
// пользователя, а ранняя декларация задерживает старт опыта. Доступ
// запрашивается по кнопке MIC — тогда же создаётся AudioContext.
options.enableReticles();
// Руки — для прямого контакта со скульптурами: коснуться и держать (hold),
// схватить pinch'ем и перенести (Interaction manual: touch → select → grab →
// manipulation). Телефонному AR эту фичу снимает guard в common/boot.js.
options.enableHands();
options.hands.visualization = true;
options.world?.enableAnchors?.();
options.xrButton.showEnterSimulatorButton = true;
options.setAppTitle('SOUND//SPACE');
options.setAppDescription('Частоты встают вокруг тебя. FREEZE копит галерею снимков.');

enableAutomation(options);
installXrGuards();
installLaunchShell(options, [
  'Вход — кнопка внизу: спектр встанет вокруг тебя',
  'MIC — живое поле, FREEZE — снимок в ряд истории',
  'Снимок: тянуть — перенос, кольцо — поворот, держать — растворить',
  'Меню — панель внизу экрана',
]);
previewFromEyeHeight();
document.addEventListener('DOMContentLoaded', () => {
  xb.add(new SoundSpace());
  xb.init(options);
  watchXrButton();
});
