// SOUND//SPACE — звук как живая спектральная лента и замороженные скульптуры.
// Микрофон запускается только явным нажатием START MIC; без разрешения и в
// ?test=1 работает детерминированный синтетический сигнал.

import * as THREE from 'three';
import * as xb from 'xrblocks';
import {
  COLORS, baseOptions, createHud, watchSession, spatialControls,
  anchorRoot, fpsMeter, isTestMode,
} from '../common/shell.js';
import { ribbonMaterial, hologramMaterial, ringShockMaterial, tickMaterials } from '../common/shaders.js';
import { glowTexture, starTexture, spritePool } from '../common/sprites.js';

const BANDS = 16;
const TYPES = ['VOICE', 'MUSIC', 'IMPACT'];
const TYPE_COLORS = [0x54d6ff, 0xff4bd4, 0x8a7bff];

window.__SS_VER = 1;
document.documentElement.dataset.ssVer = '1';

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
    new THREE.LineBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false })
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
    this.glints = spritePool(starTexture({ rays: 6 }), { count: 8, dur: 0.9, grow: 2.1, color: 0xffffff });
    this.root.add(this.glints.group);

    this.bands = new Float32Array(BANDS);
    this.freq = new Uint8Array(256);
    this.typeIndex = 0; this.freezeCount = 0; this.audioMode = 'SYNTH';

    const freeze = () => this.freeze();
    const nextType = () => { this.typeIndex = (this.typeIndex + 1) % TYPES.length; this.stat(); };
    const startMic = () => this.startMic();
    this.hud = createHud({
      title: 'SOUND//SPACE',
      controls: [
        { id: 'freeze', label: 'FREEZE', onClick: freeze },
        { id: 'type', label: 'VOICE', onClick: nextType },
        { id: 'mic', label: 'START MIC', onClick: startMic },
      ],
      hint: 'звук лепит ленту · FREEZE сохраняет голос / музыку / удар в пространстве',
    });
    this.spatial = spatialControls({
      title: 'SOUND//SPACE', status: 'LIVE · SYNTH · VOICE',
      controls: [
        { id: 'freeze', label: 'FREEZE', onClick: freeze },
        { id: 'type', label: 'TYPE', onClick: nextType },
        { id: 'mic', label: 'MIC', onClick: startMic },
      ], width: 0.68,
    });
    this.spatial.card.position.set(-0.78, 1.72, -1.25); this.add(this.spatial.card);

    this.fpsTick = fpsMeter((fps) => { this.fps = fps; }); this.fps = 0;
    window.__soundSpace = this;
  }

  async startMic() {
    if (this.audioMode === 'MIC') return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false }, video: false });
      const ctx = new AudioContext(); const src = ctx.createMediaStreamSource(stream); const a = ctx.createAnalyser();
      a.fftSize = 512; a.smoothingTimeConstant = 0.82; src.connect(a);
      this.audio = { stream, ctx, analyser: a }; this.freq = new Uint8Array(a.frequencyBinCount); this.audioMode = 'MIC';
    } catch (e) {
      this.audioMode = 'SYNTH';
      document.documentElement.dataset.ssMicErr = (e && e.message) || String(e);
    }
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
    const type = TYPES[this.typeIndex]; const color = TYPE_COLORS[this.typeIndex];
    const group = new THREE.Group();
    const slot = this.freezeCount % 3;
    group.position.set((slot - 1) * 0.7, -0.08, 0.18 + slot * 0.02);
    group.scale.setScalar(1.15);
    const snapshot = Array.from(this.bands);

    if (type === 'VOICE') {
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
      const reliefMaterial = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.32, side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      group.add(new THREE.Mesh(reliefGeometry, reliefMaterial));
      for (let layer = 0; layer < 3; layer++) {
        const p = [];
        for (let i = 0; i < BANDS; i++) {
          const x = (i / (BANDS - 1) - 0.5) * 0.5;
          p.push(new THREE.Vector3(x, 0.06 + snapshot[i] * 0.38 + layer * 0.018, Math.sin(i * 0.8 + layer) * 0.04));
        }
        group.add(line(p, color, 1 - layer * 0.2));
      }
    } else if (type === 'MUSIC') {
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
          new THREE.MeshBasicMaterial({ color: ring % 2 ? COLORS.violet : color, transparent: true, opacity: 0.72, blending: THREE.AdditiveBlending, depthWrite: false })
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
    const label = textSprite(`${type} ${String(this.freezeCount + 1).padStart(2, '0')}`, ['#8eeaff', '#ff79df', '#b8a9ff'][this.typeIndex]);
    label.position.y = 0.4; group.add(label);
    this.frozenRoot.add(group); this.frozen.push(group);
    if (this.frozen.length > 3) { const old = this.frozen.shift(); old.removeFromParent(); old.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); o.userData?.dispose?.(); }); }
    this.glints.spawn(group.position.clone().add(this.frozenRoot.position).add(new THREE.Vector3(0, 0.18, 0)), 0.28);
    this.freezeCount++; this.stat();
  }

  onSelectEnd(event) { if (!event?.target?.isUI) this.freeze(); }

  stat() {
    const type = TYPES[this.typeIndex];
    const s = `LIVE / ${this.audioMode} / ${type} / SAVED ${this.freezeCount} / ${this.fps || 0} FPS`;
    this.hud.setStatus(s); this.spatial.setStatus(`LIVE / ${this.audioMode}\n${type} / SAVED ${this.freezeCount}`);
    this.hud.setToggle('type', this.typeIndex > 0);
    document.documentElement.dataset.ssState = JSON.stringify({ fps: this.fps, audio: this.audioMode, type, frozen: this.freezeCount, bands: BANDS, anchor: this.anchor.capability });
  }

  update() {
    const dt = Math.min(xb.getDeltaTime(), 0.05); this.fpsTick(dt);
    const cmd = document.documentElement.dataset.ssCmd;
    if (cmd) { delete document.documentElement.dataset.ssCmd; if (cmd === 'freeze') this.freeze(); else if (cmd === 'type') { this.typeIndex = (this.typeIndex + 1) % TYPES.length; this.stat(); } }
    if (!this.anchor.active && !this.anchor._pending && this.anchor.capability !== 'unsupported') this.anchor.create(this.root);
    this.anchor.follow(this.root);
    const t = xb.getElapsedTime?.() ?? performance.now() / 1000;
    this.sampleBands(t); this.ribbonMat.uniforms.uBands.value.set(this.bands);
    for (let j = 0; j < this.echoRibbons.length; j++) {
      const e = this.echoRibbons[j]; for (let i = 0; i < BANDS; i++) e.lag[i] += (this.bands[i] - e.lag[i]) * (0.055 - j * 0.012);
      e.mat.uniforms.uBands.value.set(e.lag);
    }
    tickMaterials(t, [this.ribbonMat, ...this.echoRibbons.map((e) => e.mat)]);
    this.glints.update(dt);
    this._statT = (this._statT || 0) + dt; if (this._statT > 0.5) { this._statT = 0; this.stat(); }
  }

  dispose() {
    this.anchor.dispose(); this.glints.dispose();
    if (this.audio) { for (const t of this.audio.stream.getTracks()) t.stop(); this.audio.ctx.close(); }
    this.root.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); o.userData?.dispose?.(); });
    delete window.__soundSpace;
  }
}

const options = baseOptions({ title: 'SOUND//SPACE', description: 'Живая спектральная лента и замороженные звуковые скульптуры. FREEZE сохраняет момент.', bloom: false });
options.enableHands();
options.controllers.visualizeRays = false;

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const script = new SoundSpace(); xb.add(script); await xb.init(options); watchSession();
    if (isTestMode()) { script.freeze(); script.typeIndex = 1; script.freeze(); script.typeIndex = 2; script.freeze(); script.typeIndex = 0; }
  } catch (e) { document.documentElement.dataset.ssInitErr = (e && e.message) || String(e); console.error('[SS] BOOT FAIL', e); }
});
