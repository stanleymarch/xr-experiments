// SOUND//SPACE — спектральная лента и замороженные звуковые скульптуры.
//
// Микрофон включается только явным нажатием МИК и всегда показывает своё
// состояние: ВЫКЛ / ЗАПРОС… / ВКЛ / ОТКАЗ (+ причина) / Н/Д (нет HTTPS).
// Без микрофона лента живёт на детерминированном демо-сигнале — это не сбой.
//
// ГОЛОС / МУЗЫКА / УДАР — это выбор ФОРМЫ скульптуры, то есть визуализации.
// Микрофон ничего не распознаёт и не классифицирует: он даёт только спектр.

import * as THREE from 'three';
import * as xb from 'xrblocks';
import {
  COLORS, baseOptions, createHud, watchSession, spatialControls,
  anchorRoot, fpsMeter, isTestMode,
} from '../common/shell.js';
import { glowBlending, ribbonMaterial, hologramMaterial, ringShockMaterial, tickMaterials } from '../common/shaders.js';
import { glowTexture, spritePool } from '../common/sprites.js';

const BANDS = 16;
// Формы скульптуры. Форма — это выбор пользователя, а не результат анализа звука.
const SHAPES = [
  { id: 'voice', name: 'ГОЛОС', label: 'ГОЛОС · РЕЛЬЕФ', kind: 'рельеф', desc: 'спектральный рельеф', color: 0x54d6ff, text: '#8eeaff' },
  { id: 'music', name: 'МУЗЫКА', label: 'МУЗЫКА · КОЛЬЦА', kind: 'кольца', desc: 'гармонические кольца', color: 0xff4bd4, text: '#ff79df' },
  { id: 'impact', name: 'УДАР', label: 'УДАР · ВСПЫШКА', kind: 'вспышка', desc: 'ядро и фронтальный удар', color: 0x8a7bff, text: '#b8a9ff' },
];
const MIC_LABEL = {
  off: 'МИК: ВЫКЛ', asking: 'МИК: ЗАПРОС…', on: 'МИК: ВКЛ', denied: 'МИК: ОТКАЗ', unsupported: 'МИК: Н/Д',
};
const MIC_NOTE = {
  off: 'мик выкл · демо-сигнал',
  asking: 'ждём доступ к микрофону…',
  on: 'микрофон вкл',
  denied: 'нет доступа · демо-сигнал',
  unsupported: 'мик недоступен · демо-сигнал',
};

window.__SS_VER = 2;
document.documentElement.dataset.ssVer = '2';

function textSprite(text, color = '#dff8ff') {
  const c = document.createElement('canvas'); c.width = 512; c.height = 108;
  const x = c.getContext('2d');
  x.fillStyle = 'rgba(4, 8, 20, .82)';
  x.beginPath(); x.roundRect(34, 14, 444, 78, 24); x.fill();
  x.font = '700 38px ui-monospace, monospace';
  x.textAlign = 'center'; x.textBaseline = 'middle'; x.shadowColor = color; x.shadowBlur = 18;
  x.fillStyle = color; x.fillText(text, 256, 54);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const s = new THREE.Sprite(m); s.scale.set(0.62, 0.13, 1);
  s.userData.dispose = () => { tex.dispose(); m.dispose(); };
  return s;
}

function line(points, color, opacity = 0.8) {
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    glowBlending(new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }))
  );
}

class SoundSpace extends xb.Script {
  init() {
    try { this._init(); }
    catch (e) { document.documentElement.dataset.ssInitErr = (e && e.message) || String(e); console.error('[SS] INIT FAIL', e); throw e; }
  }

  _init() {
    this.add(new THREE.HemisphereLight(0xffffff, 0x19162e, 1.4));
    this.root = new THREE.Group(); this.root.name = 'sound-space-root'; this.add(this.root);
    this.root.position.set(0, 1.34, -1.5); this.anchor = anchorRoot();

    // Живая spectral ribbon — широкая полоса, которую 16 FFT-band изгибают в 3D.
    this.ribbonMat = ribbonMaterial({ bands: BANDS });
    this.ribbon = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.28, 96, 12), this.ribbonMat);
    this.ribbon.rotation.x = -0.32;
    this.root.add(this.ribbon);

    // Две вторичные полупрозрачные ленты дают глубину, не дублируя сигнал.
    this.echoRibbons = [];
    for (let i = 0; i < 2; i++) {
      const m = ribbonMaterial({ bands: BANDS }); m.uniforms.uAmp.value = 0.2 - i * 0.04;
      const r = new THREE.Mesh(new THREE.PlaneGeometry(1.72 - i * 0.12, 0.18, 72, 8), m);
      r.position.set(0, -0.1 - i * 0.085, 0.1 + i * 0.08); r.rotation.x = -0.18;
      this.root.add(r); this.echoRibbons.push({ mesh: r, mat: m, lag: new Float32Array(BANDS) });
    }

    this.frozenRoot = new THREE.Group(); this.frozenRoot.position.y = -0.5; this.root.add(this.frozenRoot);
    this.frozen = [];

    // Маленькие цветные вспышки по форме: 0.11 → максимум ~0.14 мира.
    this.sparks = SHAPES.map((s) => {
      const p = spritePool(glowTexture({ core: 0.18 }), { count: 3, dur: 0.42, grow: 1.3, color: s.color });
      this.frozenRoot.add(p.group);
      return p;
    });

    this.bands = new Float32Array(BANDS);
    this.freq = new Uint8Array(256);
    this.shapeIndex = 0; this.freezeCount = 0;
    this.micState = 'off'; this.micError = null; this.audio = null;

    const freeze = () => this.freeze();
    const nextShape = () => { this.shapeIndex = (this.shapeIndex + 1) % SHAPES.length; this.stat(); };
    const toggleMic = () => this.toggleMic();
    this.hud = createHud({
      title: 'SOUND//SPACE',
      controls: [
        { id: 'freeze', label: 'ЗАМОРОЗИТЬ', onClick: freeze },
        { id: 'type', label: SHAPES[0].label, onClick: nextShape },
        { id: 'mic', label: MIC_LABEL.off, onClick: toggleMic },
      ],
      hint: 'тап — заморозить момент · ФОРМА задаёт вид скульптуры (голос — рельеф, музыка — кольца, удар — вспышка: это визуализация, не распознавание звука) · МИК включает и выключает микрофон',
    });
    this.spatial = spatialControls({
      title: 'SOUND//SPACE', status: '…',
      controls: [
        { id: 'freeze', label: 'ЗАМОРОЗИТЬ', onClick: freeze },
        { id: 'type', label: SHAPES[0].label, onClick: nextShape },
        { id: 'mic', label: MIC_LABEL.off, onClick: toggleMic },
      ], width: 0.78,
    });
    this.spatial.card.position.set(-0.78, 1.72, -1.25); this.add(this.spatial.card);

    this.fpsTick = fpsMeter((fps) => { this.fps = fps; }); this.fps = 0;
    this.stat();
    window.__soundSpace = this;
  }

  /** Полное состояние микрофона строкой для UI: причина отказа не теряется. */
  micLine() {
    const note = MIC_NOTE[this.micState];
    let line = this.micError && this.micState !== 'asking' ? `${note} (${this.micError})` : note;
    if (this.micState === 'on' && this.audio && this.audio.ctx.state !== 'running') {
      line += ' (аудио-контекст ждёт жеста)';
    }
    return line;
  }

  toggleMic() {
    if (this.micState === 'on') this.stopMic('мик выключен пользователем');
    else if (this.micState === 'asking') {
      // Запрос нельзя отменить программно, но пользователь не должен застрять
      // в «ЗАПРОС…»: снимаем состояние, а пришедший поток отбрасываем.
      this.stopMic('запрос доступа отменён');
    } else this.startMic();
  }

  async startMic() {
    if (this.micState === 'on' || this.micState === 'asking') return;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.micState = 'unsupported';
      this.micError = 'нет navigator.mediaDevices (нужен HTTPS)';
      document.documentElement.dataset.ssMicErr = this.micError;
      this.stat();
      return;
    }
    this.micState = 'asking'; this.micError = null; this.stat();
    const req = (this._micReq = (this._micReq || 0) + 1);
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false }, video: false });
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      // resume() не должен блокировать состояние: в среде без аудио-выхода
      // промис может не разрешиться, а лента оживёт, когда контекст пойдёт.
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.82; src.connect(analyser);
      // Запрос отменён или перезапущен, пока ждали разрешения — поток не наш.
      if (this.micState !== 'asking' || this._micReq !== req) {
        for (const t of stream.getTracks()) t.stop();
        await ctx.close();
        return;
      }
      this.audio = { stream, ctx, src, analyser };
      this.freq = new Uint8Array(analyser.frequencyBinCount);
      this.micState = 'on'; this.micError = null;
      delete document.documentElement.dataset.ssMicErr;
      // Дорожку могут закрыть извне (система/пользователь) — не молчим об этом.
      stream.getAudioTracks()[0]?.addEventListener('ended', () => {
        if (this.audio?.stream !== stream) return;
        this.stopMic('поток микрофона закрыт системой');
      });
    } catch (e) {
      if (stream) for (const t of stream.getTracks()) t.stop();
      if (this._micReq !== req) return; // устаревший отказ — не перетирает новое состояние
      this.micState = 'denied';
      this.micError = (e && (e.name ? `${e.name}: ${e.message}` : e.message)) || 'микрофон недоступен';
      document.documentElement.dataset.ssMicErr = this.micError;
    }
    this.stat();
  }

  stopMic(reason = '') {
    const a = this.audio; this.audio = null;
    if (a) {
      for (const t of a.stream.getTracks()) t.stop();
      try { a.ctx.close(); } catch { /* контекст уже закрыт */ }
    }
    this.micState = 'off';
    if (reason) this.micError = reason;
    this.stat();
  }

  sampleBands(t) {
    if (this.audio?.analyser) {
      this.audio.analyser.getByteFrequencyData(this.freq);
      for (let i = 0; i < BANDS; i++) {
        const a = Math.floor(Math.pow(i / BANDS, 1.8) * (this.freq.length - 6));
        let sum = 0; for (let k = 0; k < 6; k++) sum += this.freq[a + k];
        this.bands[i] += (sum / 1530 - this.bands[i]) * 0.22;
      }
    } else {
      for (let i = 0; i < BANDS; i++) {
        const voice = Math.pow(Math.sin(t * 2.2 + i * 0.7) * 0.5 + 0.5, 3);
        const beat = Math.pow(Math.max(0, Math.sin(t * 1.8 - i * 0.18)), 8);
        this.bands[i] = 0.08 + voice * 0.36 + beat * (i < 5 ? 0.46 : 0.16);
      }
    }
  }

  freeze() {
    const shape = SHAPES[this.shapeIndex];
    const color = shape.color;
    const group = new THREE.Group();
    const slot = this.freezeCount % 3;
    group.position.set((slot - 1) * 0.7, -0.08, 0.18 + slot * 0.02);
    group.scale.setScalar(1.15);
    // Тихая запись не должна давать плоский ноль — оставляем видимую базу.
    const snapshot = Array.from(this.bands, (v) => Math.max(v, 0.04));

    if (shape.id === 'voice') {
      // Голос — заполненный спектральный рельеф с тремя смещёнными контурами.
      const positions = []; const indices = [];
      for (let i = 0; i < BANDS; i++) {
        const x = (i / (BANDS - 1) - 0.5) * 0.5;
        const z = Math.sin(i * 0.8) * 0.035;
        positions.push(x, 0.02, z, x, 0.06 + snapshot[i] * 0.38, z);
        if (i < BANDS - 1) {
          const a = i * 2;
          indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
      const reliefGeometry = new THREE.BufferGeometry();
      reliefGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      reliefGeometry.setIndex(indices); reliefGeometry.computeVertexNormals();
      const reliefMaterial = glowBlending(new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.32, side: THREE.DoubleSide,
        depthWrite: false,
      }));
      group.add(new THREE.Mesh(reliefGeometry, reliefMaterial));
      for (let layer = 0; layer < 3; layer++) {
        const p = [];
        for (let i = 0; i < BANDS; i++) {
          const x = (i / (BANDS - 1) - 0.5) * 0.5;
          p.push(new THREE.Vector3(x, 0.06 + snapshot[i] * 0.38 + layer * 0.018, Math.sin(i * 0.8 + layer) * 0.04));
        }
        group.add(line(p, color, 1 - layer * 0.2));
      }
    } else if (shape.id === 'music') {
      // Музыка — объёмная гармоническая клетка из замкнутых спектральных траекторий.
      for (let ring = 0; ring < 4; ring++) {
        const p = [];
        for (let i = 0; i < 64; i++) {
          const a = i / 64 * Math.PI * 2; const b = snapshot[(i + ring * 3) % BANDS];
          const r = 0.13 + ring * 0.035 + b * 0.09;
          p.push(new THREE.Vector3(Math.cos(a) * r, 0.16 + Math.sin(a * (ring + 2)) * b * 0.08, Math.sin(a) * r));
        }
        const curve = new THREE.CatmullRomCurve3(p, true, 'centripetal');
        const tube = new THREE.Mesh(
          new THREE.TubeGeometry(curve, 96, 0.007 + ring * 0.0015, 6, true),
          glowBlending(new THREE.MeshBasicMaterial({ color: ring % 2 ? COLORS.violet : color, transparent: true, opacity: 0.72, depthWrite: false }))
        );
        group.add(tube);
      }
    } else {
      // Удар — горячее ядро + фронтальная shockwave-мембрана.
      const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.12, 3), hologramMaterial({ color, rim: 0xff4bd4, opacity: 0.95 }));
      core.position.y = 0.15; group.add(core);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.24, 64), ringShockMaterial({ color, harmonics: 2, width: 0.16 }));
      disc.position.y = 0.15; disc.material.uniforms.uProgress.value = 0.72; group.add(disc);
    }
    const label = textSprite(`${shape.name} ${String(this.freezeCount + 1).padStart(2, '0')}`, shape.text);
    label.position.y = 0.4; group.add(label);
    this.frozenRoot.add(group); this.frozen.push(group);
    if (this.frozen.length > 3) { const old = this.frozen.shift(); old.removeFromParent(); old.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); o.userData?.dispose?.(); }); }
    this.sparks[this.shapeIndex].spawn(group.position, 0.11);
    this.freezeCount++; this.stat();
  }

  onSelectEnd(event) { if (this.spatial.owns(event?.target)) return; if (event?.completed === false || event?.target?.isUI) return; this.freeze(); }

  stat() {
    const s = SHAPES[this.shapeIndex];
    const mic = this.micLine();
    this.hud.setStatus(`${s.name} — ${s.kind} · ${mic} · сохранено ${this.freezeCount} · ${this.fps || '—'} FPS`);
    this.spatial.setStatus(`${s.name} — ${s.desc}\n${mic}\nсохранено: ${this.freezeCount}\nформа скульптуры: визуализация, не распознавание звука`);
    this.hud.setLabel('type', s.label);
    this.spatial.setLabel('type', s.label);
    this.hud.setLabel('mic', MIC_LABEL[this.micState]);
    this.spatial.setLabel('mic', MIC_LABEL[this.micState]);
    this.hud.setToggle('mic', this.micState === 'on');
    this.spatial.setToggle('mic', this.micState === 'on');
    document.documentElement.dataset.ssState = JSON.stringify({
      fps: this.fps, mic: this.micState, micError: this.micError, micSupported: !!navigator.mediaDevices?.getUserMedia,
      shape: s.name, shapeId: s.id, shapeKind: s.kind, frozen: this.freezeCount, bands: BANDS,
      demoSignal: this.micState !== 'on', anchor: this.anchor.capability,
    });
  }

  update() {
    const dt = Math.min(xb.getDeltaTime(), 0.05); this.fpsTick(dt);
    const cmd = document.documentElement.dataset.ssCmd;
    if (cmd) {
      delete document.documentElement.dataset.ssCmd;
      if (cmd === 'freeze') this.freeze();
      else if (cmd === 'type') { this.shapeIndex = (this.shapeIndex + 1) % SHAPES.length; this.stat(); }
      else if (cmd === 'mic') this.toggleMic();
    }
    if (!this.anchor.active && !this.anchor._pending && this.anchor.capability !== 'unsupported') this.anchor.create(this.root);
    this.anchor.follow(this.root);
    const t = xb.getElapsedTime?.() ?? performance.now() / 1000;
    this.sampleBands(t); this.ribbonMat.uniforms.uBands.value.set(this.bands);
    for (let j = 0; j < this.echoRibbons.length; j++) {
      const e = this.echoRibbons[j]; for (let i = 0; i < BANDS; i++) e.lag[i] += (this.bands[i] - e.lag[i]) * (0.055 - j * 0.012);
      e.mat.uniforms.uBands.value.set(e.lag);
    }
    tickMaterials(t, [this.ribbonMat, ...this.echoRibbons.map((e) => e.mat)]);
    for (const p of this.sparks) p.update(dt);
    this._statT = (this._statT || 0) + dt; if (this._statT > 0.5) { this._statT = 0; this.stat(); }
  }

  dispose() {
    this.anchor.dispose();
    for (const p of this.sparks) p.dispose();
    if (this.audio) { for (const t of this.audio.stream.getTracks()) t.stop(); try { this.audio.ctx.close(); } catch { /* уже закрыт */ } }
    this.root.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); o.userData?.dispose?.(); });
    delete window.__soundSpace;
  }
}

const options = baseOptions({ title: 'SOUND//SPACE', description: 'Живая спектральная лента и замороженные звуковые скульптуры. Форма (голос/музыка/удар) — выбор визуализации, микрофон включается кнопкой МИК.', bloom: false });
options.controllers.visualizeRays = false;

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const script = new SoundSpace(); xb.add(script); await xb.init(options); watchSession();
    if (isTestMode()) { script.freeze(); script.shapeIndex = 1; script.freeze(); script.shapeIndex = 2; script.freeze(); script.shapeIndex = 0; }
  } catch (e) { document.documentElement.dataset.ssInitErr = (e && e.message) || String(e); console.error('[SS] BOOT FAIL', e); }
});
