import * as THREE from 'three';
import * as xb from 'xrblocks';

// SOUND//SPACE — звук строит пространство.
// Микрофон → Web Audio FFT → живая светящаяся структура перед тобой.
// Речь — нервные шипы, музыка — гладкие волны, хлопок — ударная волна.
// FREEZE/pinch замораживает текущий момент в скульптуру; вокруг собирается
// история последних минут. Без сервера, без AI, 0 ₽.

const $ = (id) => document.getElementById(id);
const FFT = 512;
const RIBBONS = 3;      // слоёв истории помимо живого
const STEPS = 96;       // длина ленты во времени
const BANDS = 40;       // частотных бинов на ленту

class SoundSpace extends xb.Script {
  init() {
    this.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a2438, 1.6));
    const key = new THREE.DirectionalLight(0x88ccff, 1.0);
    key.position.set(0.5, 2, 0.5);
    this.add(key);

    this.group = new THREE.Group();
    this.group.position.set(0, 1.35, -1.1);
    this.add(this.group);

    // живой анализатор + замороженные ленты
    this.ribbons = [];
    for (let l = 0; l <= RIBBONS; l++) {
      const geo = new THREE.PlaneGeometry(1.5, 1.0, STEPS, BANDS);
      const live = l === 0;
      const mat = new THREE.MeshBasicMaterial({
        color: live ? 0x54d6ff : [0xffb14a, 0x7dff9a, 0xff6ad5][l - 1],
        transparent: true, opacity: live ? 0.55 : 0.34,
        wireframe: true, side: THREE.DoubleSide, depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.z = -l * 0.28;
      this.group.add(mesh);
      this.ribbons.push({ mesh, hist: [], maxAge: Infinity });
    }

    this.audio = null;         // {ctx, analyser, freq}
    this.frozen = [];          // снимки {snap, at}
    this.demoPhase = 0;
    this.impacts = [];         // ударные волны хлопков
    this.ringGeo = new THREE.RingGeometry(0.94, 1.0, 48);

    $('btn-mic').onclick = () => this.enableMic();
    $('btn-freeze').onclick = () => this.freeze();
    $('btn-clear').onclick = () => this.clear();

    this.perm = false;
    this.stat('нажми MIC — или слушай демо-генератор');
  }

  stat(s) { $('stat').textContent = s; }
  onSelectEnd() { this.freeze(); }
  onSqueezeEnd() { this.clear(); }

  async enableMic() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT * 2;
      analyser.smoothingTimeConstant = 0.75;
      src.connect(analyser);
      const freq = new Uint8Array(analyser.frequencyBinCount);
      this.audio = { ctx, analyser, freq };
      this.perm = true;
      $('btn-mic').classList.add('on');
      this.stat('mic live · говори, хлопай, играй');
    } catch (e) {
      this.stat(`mic недоступен (${e.name}) — демо-генератор`);
    }
  }

  demoSpectrum(t) {
    // речь/музыка/хлопки по очереди — чтобы без микрофона было видно разницу
    const out = new Float32Array(BANDS);
    const mode = Math.floor(t / 6) % 3;
    for (let b = 0; b < BANDS; b++) {
      const f = b / BANDS;
      if (mode === 0) out[b] = Math.max(0, Math.sin(f * 40 + t * 9) * Math.sin(f * 7 - t * 5)) * (1 - f);       // речь
      else if (mode === 1) out[b] = (0.4 + 0.6 * Math.abs(Math.sin(f * 9 + t * 2))) * Math.exp(-f * 2.2);        // музыка
      else out[b] = Math.exp(-f * 8) * Math.exp(-((t % 6) - 0.3) * 3) * 2;                                      // хлопок
    }
    return { out, mode, level: mode === 2 ? 1 : 0.5 };
  }

  spectrum() {
    if (this.audio) {
      this.audio.analyser.getByteFrequencyData(this.audio.freq);
      const out = new Float32Array(BANDS);
      for (let b = 0; b < BANDS; b++) out[b] = this.audio.freq[b] / 255;
      const level = out.reduce((a, v) => a + v, 0) / BANDS;
      const flux = this._prev
        ? out.reduce((a, v, i) => a + Math.max(0, v - this._prev[i]), 0) / BANDS : 0;
      this._prev = out.slice();
      const mode = level > 0.55 ? 2 : flux > 0.02 ? 0 : 1;
      return { out, mode, level };
    }
    const t = performance.now() / 1000;
    return this.demoSpectrum(t);
  }

  freeze() {
    const live = this.ribbons[0];
    if (!live.hist.length) return;
    const snap = live.hist.map((r) => r.slice());
    const slot = this.ribbons.slice(1).reduce((a, b) =>
      (a.hist.length || 0) <= (b.hist.length || 0) ? a : b);
    slot.hist = snap;
    this.sculpt(slot);
    this.stat(`заморожено · ${snap.length} кадров · слой ${this.ribbons.indexOf(slot)}`);
    this.frozen.push({ at: Date.now() });
    if (this.frozen.length > 12) this.frozen.shift();
  }

  clear() {
    // стираем и расплющиваем замороженные ленты: они больше не обновляются
    for (const l of this.ribbons.slice(1)) {
      l.hist = [];
      const posA = l.mesh.geometry.attributes.position;
      posA.array.fill(0);
      posA.needsUpdate = true;
    }
    this.frozen = [];
    this.stat(this.perm ? 'mic live · слои очищены' : 'демо · слои очищены');
  }

  sculpt(layer) {
    const posA = layer.mesh.geometry.attributes.position;
    const H = layer.hist;
    const n = H.length;
    for (let s = 0; s <= STEPS; s++) {
      const frame = H[Math.min(n - 1, Math.floor((s / STEPS) * Math.max(0, n - 1)))] || new Float32Array(BANDS);
      for (let b = 0; b <= BANDS; b++) {
        const v = frame[Math.min(BANDS - 1, b)] || 0;
        posA.setZ((s * (BANDS + 1) + b), v * 0.35);
      }
    }
    posA.needsUpdate = true;
  }

  update() {
    const dt = Math.min(xb.getDeltaTime(), 0.05);
    const { out, mode, level } = this.spectrum();
    const live = this.ribbons[0];
    live.hist.push(out.slice());
    if (live.hist.length > STEPS) live.hist.shift();
    this.sculpt(live);
    // замороженные ленты статичны: они скульптурируются один раз при freeze

    // хлопок = ударная волна кольцом
    if (mode === 2 && level > 0.6 && (!this._lastHit || performance.now() - this._lastHit > 900)) {
      this._lastHit = performance.now();
      const m = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.9,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      m.position.copy(this.group.position);
      m.lookAt(xb.core.camera.position);
      this.add(m);
      this.impacts.push({ mesh: m, t: 0 });
    }
    for (const im of [...this.impacts]) {
      im.t += dt;
      im.mesh.scale.setScalar(0.12 + im.t * 1.15);
      im.mesh.material.opacity = Math.max(0, 0.9 - im.t);
      if (im.t > 1) { this.remove(im.mesh); im.mesh.material.dispose(); this.impacts.splice(this.impacts.indexOf(im), 1); }
    }

    live.mesh.material.color.set(mode === 0 ? 0x9fe8ff : mode === 1 ? 0x54d6ff : 0xffffff);
    this.demoPhase += dt;
    if ((this._st = (this._st || 0) + dt) > 0.5) {
      this._st = 0;
      const mm = ['речь', 'музыка', 'хлопок'][mode];
      this.stat(`${this.perm ? 'mic' : 'демо'} · ${mm} · уровень ${(level * 100) | 0}% · заморожено ${this.frozen.length}`);
    }
  }

  dispose() {
    for (const l of this.ribbons) { l.mesh.geometry.dispose(); l.mesh.material.dispose(); }
    this.audio?.ctx.close().catch(() => {});
  }
}

const options = new xb.Options();
// Микрофон не декларируется заранее: браузеры выдают доступ только из жеста
// пользователя, а ранняя декларация задерживает старт опыта. Доступ
// запрашивается по кнопке MIC — тогда же создаётся AudioContext.
options.enableReticles();
options.xrButton.showEnterSimulatorButton = true;
options.setAppTitle('SOUND//SPACE');
options.setAppDescription('Звук строит 3D-скульптуру. pinch/click = freeze, hold = стереть.');

document.addEventListener('DOMContentLoaded', () => {
  xb.add(new SoundSpace());
  xb.init(options);
});
