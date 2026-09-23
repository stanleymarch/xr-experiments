// WEATHER//ROOM — погода, вписанная в реальную комнату.
//
// Над потолком — грозовой купол (FBM-тучи, молнии), в объёме комнаты идёт
// дождь (instanced-штрихи, наклон по ветру), удары капель оживляют пол
// кольцами-сплешами, curl-ветер гоняет ленты-филаменты. Тап/клик — порыв
// ветра от пользователя, жест open-palm — усиление шторма, pinch — затишье.
//
// Платформы: Quest 3 / Android XR (жесты и лучи), смартфон AR (тап = порыв,
// удержание = разгон шторма), десктоп (клик), универсальный тест — ?test=1.

import * as THREE from 'three';
import * as xb from 'xrblocks';
import {
  COLORS, baseOptions, createHud, watchSession, spatialControls,
  anchorRoot, fpsMeter,
} from '../common/shell.js';
import {
  cloudDomeMaterial, rainMaterial, makeRainField, ringShockMaterial,
  windFilamentMaterial, addBloom, tickMaterials,
} from '../common/shaders.js';

const RAIN_COUNT = 700;
const SPLASH_COUNT = 10;
const FILAMENT_COUNT = 14;
const GUST_DUR = 1.1;

window.__WR_VER = 1;
document.documentElement.dataset.wrVer = '1';

class WeatherRoom extends xb.Script {
  init() {
    try { this._init(); }
    catch (e) {
      document.documentElement.dataset.wrInitErr = (e && e.message) || String(e);
      console.error('[WR] INIT FAIL', e);
      throw e;
    }
  }

  _init() {
    this.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.2));

    this.root = new THREE.Group();
    this.root.name = 'weather-room-root';
    this.add(this.root);
    this.anchor = anchorRoot();

    // --- грозовой купол над головой ---
    this.domeMat = cloudDomeMaterial({ radius: 4.2 });
    // Купол опускаем ниже потолка симулятора/AR-комнаты: иначе его полностью
    // перекрывает непрозрачный потолок и тучи не видны.
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(3.6, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.55), this.domeMat);
    this.dome.position.set(0, -1.2, 0);
    this.root.add(this.dome);

    // --- дождь ---
    this.rainMat = rainMaterial({ color: 0xa8d8f0, area: new THREE.Vector2(6, 6), height: 3.2 });
    this.rainGeo = makeRainField(RAIN_COUNT, new THREE.Vector2(6, 6));
    this.rain = new THREE.Mesh(this.rainGeo, this.rainMat);
    this.rain.frustumCulled = false;
    this.root.add(this.rain);
    this.splashes = [];
    const sgeo = new THREE.CircleGeometry(1, 32);
    for (let i = 0; i < SPLASH_COUNT; i++) {
      const m = new THREE.Mesh(sgeo, ringShockMaterial({ color: 0xbfe8ff, harmonics: 1, width: 0.22 }));
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      this.root.add(m);
      this.splashes.push({ mesh: m, t: 1e9 });
    }
    this.splashTimer = 0;

    // --- ленты ветра ---
    this.filamentMat = windFilamentMaterial({ color: 0xdff4ff });
    this.filaments = [];
    const fgeo = new THREE.PlaneGeometry(1.6, 0.07, 36, 1);
    for (let i = 0; i < FILAMENT_COUNT; i++) {
      const m = new THREE.Mesh(fgeo, this.filamentMat);
      m.position.set((Math.random() * 2 - 1) * 2, 0.6 + Math.random() * 1.6, (Math.random() * 2 - 1) * 2);
      m.rotation.y = Math.random() * Math.PI;
      m.frustumCulled = false;
      this.root.add(m);
      this.filaments.push(m);
    }

    // --- состояние погоды ---
    this.storm = 0.45;       // 0 затишье … 1 ураган
    this.stormTarget = 0.45;
    this.gust = 0;           // затухающий порыв 1→0
    this.windDir = new THREE.Vector2(1, 0.35).normalize();
    this.lightningT = 3 + Math.random() * 4;

    this.raycaster = new THREE.Raycaster();
    this._v = new THREE.Vector3();

    const g = xb.core.gestureRecognition;
    this._gs = (e) => this.onGesture(e.detail, true);
    this._ge = (e) => this.onGesture(e.detail, false);
    g.addEventListener('gesturestart', this._gs);
    g.addEventListener('gestureend', this._ge);

    const stormUp = () => { this.stormTarget = Math.min(1, this.stormTarget + 0.25); this.stat(); };
    const stormDown = () => { this.stormTarget = Math.max(0, this.stormTarget - 0.25); this.stat(); };
    this.hud = createHud({
      title: 'WEATHER//ROOM',
      controls: [
        { id: 'up', label: 'STORM+', onClick: stormUp },
        { id: 'down', label: 'STORM−', onClick: stormDown },
      ],
      hint: 'тап — порыв ветра · удержание — разгон шторма · open-palm/fist — сила',
    });
    this.spatial = spatialControls({
      title: 'WEATHER//ROOM',
      status: 'STORM 45% · FPS —',
      controls: [
        { id: 'up', label: 'STORM+', onClick: stormUp },
        { id: 'down', label: 'STORM−', onClick: stormDown },
      ],
    });
    this.spatial.card.position.set(0.8, 1.72, -1.3);
    this.add(this.spatial.card);

    this.fpsTick = fpsMeter((fps) => { this.fps = fps; });
    this.fps = 0;
    this.holdHeld = false;
    this.fired = 0;
    window.__weatherRoom = this;
  }

  onSelectStart(event) {
    if (event?.target?.isUI) return;
    this.holdHeld = true;
  }

  onSelectEnd(event) {
    if (event?.target?.isUI) return;
    this.holdHeld = false;
    this.gustFromUser();
  }

  onGesture(detail, start) {
    const n = detail.name;
    if (n === 'open-palm') this.stormTarget = start ? 1.0 : 0.45;
    else if (n === 'fist') this.stormTarget = start ? 0.1 : 0.45;
    else if (n === 'pinch' && start) this.stormTarget = Math.max(0, this.stormTarget - 0.25);

  }

  /** Порыв ветра от пользователя: направление взгляда → ветер. */
  gustFromUser() {
    xb.core.camera.getWorldDirection(this._v);
    const flat = Math.hypot(this._v.x, this._v.z);
    if (flat > 0.1) this.windDir.set(this._v.x, this._v.z).normalize();
    this.gust = 1;
    this.fired++;
  }

  spawnSplash() {
    const s = this.splashes.find((x) => x.t >= 0.7) || this.splashes[0];
    s.t = 0;
    s.mesh.visible = true;
    s.mesh.position.set((Math.random() * 2 - 1) * 2.6, 0.01, (Math.random() * 2 - 1) * 2.6);
    s.mesh.scale.setScalar(0.05);
  }

  stat() {
    const pct = Math.round(this.storm * 100);
    const s = `FPS ${this.fps || '—'} · STORM ${pct}% · RAIN ${RAIN_COUNT} · GUST ${this.gust.toFixed(2)}`;
    this.hud.setStatus(s);
    this.spatial.setStatus(`STORM ${pct}% · FPS ${this.fps || '—'}`);
    document.documentElement.dataset.wrState = JSON.stringify({
      fps: this.fps, storm: pct, gust: +this.gust.toFixed(2),
      rain: RAIN_COUNT, filaments: FILAMENT_COUNT, fired: this.fired,
      anchor: this.anchor.capability,
      dome: this.dome?.visible ?? null,
    });
  }

  update() {
    try { this._update(); }
    catch (e) {
      document.documentElement.dataset.wrUpdateErr = (e && e.message) || String(e);
      console.error('[WR] UPDATE FAIL', e);
    }
  }
  _update() {
    const dt = Math.min(xb.getDeltaTime(), 0.05);
    this.fpsTick(dt);
    const cmd = document.documentElement.dataset.wrCmd;
    if (cmd) {
      delete document.documentElement.dataset.wrCmd;
      try {
        if (cmd === 'gust') this.gustFromUser();
        else if (cmd === 'storm') { this.stormTarget = 1; this.stat(); }
        else if (cmd === 'debugdome') {
          // форс-тест: полное покрытие, холодный тёмный колор
          this.domeMat.uniforms.uCoverage.value = 0.0;
          this.domeMat.uniforms.uTemp.value = -1.0;
          this.domeMat.uniforms.uFlash.value = 0;
        }
        else if (cmd === 'probe') {
          document.documentElement.dataset.wrFx = JSON.stringify({
            domeVis: this.dome.visible,
            storm: +this.storm.toFixed(2),
            gust: +this.gust.toFixed(2),
            kids: this.children?.length ?? -1,
            rootKids: this.root?.children?.length ?? -1,
            cardInScene: !!this.spatial?.card?.parent,
            drawCalls: xb.core.renderer.info.render.calls,
            triangles: xb.core.renderer.info.render.triangles,
          });
        }
        delete document.documentElement.dataset.wrCmdErr;
      } catch (e) {
        document.documentElement.dataset.wrCmdErr = (e && e.message) || String(e);
      }
    }

    if (!this.anchor.active && !this.anchor._pending && this.anchor.capability !== 'unsupported') {
      this.anchor.create(this.root);
    }
    this.anchor.follow(this.root);

    // удержание разгоняет шторм
    if (this.holdHeld) this.stormTarget = Math.min(1, this.stormTarget + dt * 0.25);
    this.storm += (this.stormTarget - this.storm) * Math.min(1, dt * 1.2);
    this.gust = Math.max(0, this.gust - dt / GUST_DUR);

    // молнии при высоком шторме
    this.lightningT -= dt * (0.4 + this.storm * 1.8);
    let flash = 0;
    if (this.lightningT <= 0) {
      this.lightningT = 2.5 + Math.random() * 6;
      flash = 0.7 + Math.random() * 0.3;
    }

    // параметры шейдеров
    // больше шторма → НИЖЕ порог покрытия: тучи затягивают небо плотнее
    this.domeMat.uniforms.uCoverage.value = 0.62 - this.storm * 0.38;
    this.domeMat.uniforms.uTemp.value = this.storm * 0.4 - 0.2;
    this.domeMat.uniforms.uFlash.value = flash > 0
      ? flash
      : Math.max(0, this.domeMat.uniforms.uFlash.value - dt * 1.8);
    this.domeMat.uniforms.uWindDir.value.copy(this.windDir);
    this.rainMat.uniforms.uTime.value += dt;
    this.rainMat.uniforms.uIntensity.value = 0.25 + this.storm * 0.9;
    this.rainMat.uniforms.uWind.value.copy(wind);
    this.filamentMat.uniforms.uTime.value += dt;
    this.filamentMat.uniforms.uSpeed.value = 0.6 + this.storm * 1.4 + this.gust;

    // ленты дрейфуют по ветру
    for (const f of this.filaments) {
      f.position.x += wind.x * dt * 0.4;
      f.position.z += wind.y * dt * 0.4;
      if (Math.abs(f.position.x) > 2.8) f.position.x = Math.sign(f.position.x) * 2.8;
      if (Math.abs(f.position.z) > 2.8) f.position.z = Math.sign(f.position.z) * 2.8;
    }

    // сплэши: частота пропорциональна шторму
    this.splashTimer -= dt;
    if (this.splashTimer <= 0 && this.storm > 0.15) {
      this.splashTimer = 0.24 / (0.3 + this.storm);
      this.spawnSplash();
    }
    for (const s of this.splashes) {
      if (s.t >= 0.7) { s.mesh.visible = false; continue; }
      s.t += dt;
      const k = Math.min(s.t / 0.7, 1);
      s.mesh.material.uniforms.uProgress.value = k;
      s.mesh.scale.setScalar(0.05 + k * 0.26);
    }

    tickMaterials(0, []); // uTime обновлены вручную выше
    this.bloom?.sync();

    this._statT = (this._statT || 0) + dt;
    if (this._statT >= 0.5) { this._statT = 0; this.stat(); }
  }

  dispose() {
    const g = xb.core.gestureRecognition;
    g.removeEventListener('gesturestart', this._gs);
    g.removeEventListener('gestureend', this._ge);
    this.anchor.dispose();
    this.rainGeo.dispose();
    this.rainMat.dispose();
    this.domeMat.dispose();
    this.filamentMat.dispose();
    for (const s of this.splashes) s.mesh.material.dispose();
    delete window.__weatherRoom;
  }
}

const options = baseOptions({
  title: 'WEATHER//ROOM',
  description: 'Погода в комнате: грозовой купол, дождь, ветер и молнии. Тап — порыв, удержание — разгон шторма.',
  depth: false,
  bloom: false,
});
options.enableHands();
options.controllers.visualizeRays = false;
options.enableGestures();

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const script = new WeatherRoom();
    xb.add(script);
    await xb.init(options);
    script.bloom = addBloom({ strength: 0.55, radius: 0.5, threshold: 0.7 });
    watchSession();
  } catch (e) {
    document.documentElement.dataset.wrInitErr = (e && e.message) || String(e);
    console.error('[WR] BOOT FAIL', e);
  }
});
