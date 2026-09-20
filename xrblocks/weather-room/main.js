import * as THREE from 'three';
import * as xb from 'xrblocks';
import { pointsMaterial, shockRingMaterial } from '../common/fx.js';
import { installXrGuards, watchXrButton } from '../common/boot.js';

// WEATHER//ROOM — погода снаружи становится телом комнаты.
// Один запрос к Open-Meteo (без ключа), дальше всё локально:
// ветер гонит частицы, дождь падает на реальные горизонтальные поверхности
// (detected planes, а без них — на пол), облака гасят свет, температура
// красит воздух, давление задаёт высоту атмосферы.
// Слайдер −24ч…+24ч — мотай погоду пальцем.

const $ = (id) => document.getElementById(id);
const COUNT = 1100;
const BOX = { x: 3, y: 2.8, z: 3 };
const SPLASH_POOL = 8;

// Синтетика на случай, если сеть недоступна.
function demoData() {
  const hours = [];
  const now = Date.now();
  now -= now % 3600e3;
  for (let i = -24; i <= 48; i++) hours.push(new Date(now + i * 3600e3).toISOString());
  const n = hours.length;
  const wave = (i, p, a, b) => a + b * Math.sin((i / n) * Math.PI * p);
  return {
    hourly: {
      time: hours,
      temperature_2m: hours.map((_, i) => wave(i, 2, 6, 4)),
      precipitation: hours.map((_, i) => (i % 18 < 4 ? 1.2 : 0)),
      cloud_cover: hours.map((_, i) => Math.round(wave(i, 3, 55, 35))),
      wind_speed_10m: hours.map((_, i) => wave(i, 2, 6, 3.5)),
      wind_direction_10m: hours.map((_, i) => 225 + 40 * Math.sin(i / 6)),
      pressure_msl: hours.map((_, i) => wave(i, 1, 1008, 8)),
    },
  };
}

async function fetchWeather(lat, lon) {
  const q = new URL('https://api.open-meteo.com/v1/forecast');
  q.search = new URLSearchParams({
    latitude: String(lat), longitude: String(lon),
    hourly: 'temperature_2m,precipitation,cloud_cover,wind_speed_10m,wind_direction_10m,pressure_msl',
    past_days: '1', forecast_days: '2', timezone: 'auto',
  }).toString();
  const r = await fetch(q);
  if (!r.ok) throw new Error(`meteo ${r.status}`);
  return r.json();
}

class WeatherRoom extends xb.Script {
  init() {
    this.hemi = new THREE.HemisphereLight(0xcfe8ff, 0x334455, 1.2);
    this.sun = new THREE.DirectionalLight(0xfff2dd, 1.6);
    this.sun.position.set(1.2, 3, 0.8);
    this.add(this.hemi, this.sun);

    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(BOX.x * 3, BOX.z * 3),
      new THREE.MeshBasicMaterial({ color: 0x1c3a52, transparent: true, opacity: 0.35 })
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.add(this.floor);

    const pos = new Float32Array(COUNT * 3);
    this.vel = new Float32Array(COUNT * 3);
    this.col = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) this.respawn(i, pos, true);
    this.pgeo = new THREE.BufferGeometry();
    this.pgeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.pgeo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.points = new THREE.Points(this.pgeo, pointsMaterial({ size: 0.05, opacity: 0.85 }));
    this.points.frustumCulled = false;
    this.add(this.points);

    // Всплески капель: пул колец, лежащих горизонтально на поверхности.
    this.splashGeo = new THREE.RingGeometry(0.9, 1.0, 32);
    this.splashes = [];
    for (let i = 0; i < SPLASH_POOL; i++) {
      const mesh = new THREE.Mesh(this.splashGeo, shockRingMaterial(0xcfeaff));
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      this.add(mesh);
      this.splashes.push({ mesh, t: 1e9, dur: 0.5 });
    }

    // Горизонтальные поверхности комнаты (depth/plane detection), пересчёт раз в секунду.
    this.surfaces = [];
    this._surfaceAge = 0;
    this._box = new THREE.Box3();
    this._size = new THREE.Vector3();

    this.data = null;
    this.offset = 0;
    this.state = { temp: 8, cloud: 50, wind: 5, wdir: 225, rain: 0, press: 1010 };
    this._fp = 0;
    this.tmpC = new THREE.Color();

    $('time').addEventListener('input', (e) => {
      this.offset = +e.target.value;
      this.applyHour();
    });
    $('btn-now').onclick = () => {
      this.offset = 0; $('time').value = 0; this.applyHour();
    };
    $('btn-geo').onclick = () => this.load(+$('lat').value, +$('lon').value);

    this.stat('запрос геопозиции…');
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (p) => {
          $('lat').value = p.coords.latitude.toFixed(3);
          $('lon').value = p.coords.longitude.toFixed(3);
          this.load(p.coords.latitude, p.coords.longitude);
        },
        () => this.load(+$('lat').value, +$('lon').value),
        { timeout: 6000 }
      );
    } else this.load(+$('lat').value, +$('lon').value);
  }

  stat(s) { $('stat').textContent = s; }

  async load(lat, lon) {
    this.stat(`метео ${lat.toFixed(2)}, ${lon.toFixed(2)} …`);
    try {
      this.data = await fetchWeather(lat, lon);
      this.stat(`live · open-meteo · ${lat.toFixed(2)}, ${lon.toFixed(2)}`);
    } catch (e) {
      this.data = demoData();
      this.stat(`офлайн-демо (сеть недоступна): ${e.message}`);
    }
    this.applyHour();
  }

  nowIndex() {
    const t = this.data.hourly.time;
    const now = Date.now();
    let best = 0, bd = Infinity;
    for (let i = 0; i < t.length; i++) {
      const d = Math.abs(Date.parse(t[i]) - now);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  applyHour() {
    const h = this.data.hourly;
    const i = Math.min(h.time.length - 1, Math.max(0, this.nowIndex() + this.offset));
    this.state = {
      temp: h.temperature_2m[i], cloud: h.cloud_cover[i],
      wind: h.wind_speed_10m[i], wdir: h.wind_direction_10m[i],
      rain: h.precipitation[i], press: h.pressure_msl[i],
    };
    const when = new Date(Date.parse(h.time[i]));
    $('tlabel').textContent =
      `${this.offset === 0 ? 'NOW · ' : ''}${when.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} ` +
      `· ${this.offset >= 0 ? '+' : ''}${this.offset}ч`;
  }

  respawn(i, pos, randomY = false) {
    const ix = i * 3;
    pos[ix] = (Math.random() * 2 - 1) * BOX.x;
    pos[ix + 1] = randomY ? Math.random() * BOX.y + 0.05 : BOX.y;
    pos[ix + 2] = (Math.random() * 2 - 1) * BOX.z;
    this.vel[ix] = this.vel[ix + 1] = this.vel[ix + 2] = 0;
  }

  // Горизонтальные плоскости комнаты: стол, пол, столешница. Держим только
  // боксы с малой толщиной по Y — вертикальные стены дождь не задерживают.
  sampleSurfaces() {
    this.surfaces.length = 0;
    let planes = [];
    try { planes = xb.world.planes.get(); } catch { /* plane detection выключена */ }
    for (const plane of planes) {
      this._box.setFromObject(plane);
      this._box.getSize(this._size);
      const flat = Math.min(this._size.x, this._size.z);
      if (this._size.y > Math.max(0.05, flat * 0.35)) continue;
      if (this._box.max.y <= 0.02 || this._box.max.y > BOX.y) continue;
      this.surfaces.push({
        x0: this._box.min.x, x1: this._box.max.x,
        z0: this._box.min.z, z1: this._box.max.z,
        y: this._box.max.y,
      });
    }
  }

  // Высота, на которой капля в этой точке встречает поверхность.
  floorY(x, z) {
    let y = 0;
    for (const s of this.surfaces) {
      if (s.y > y && x >= s.x0 && x <= s.x1 && z >= s.z0 && z <= s.z1) y = s.y;
    }
    return y;
  }

  splash(x, y, z) {
    const s = this.splashes.find((c) => c.t >= c.dur) || this.splashes[0];
    s.t = 0;
    s.mesh.visible = true;
    s.mesh.position.set(x, y + 0.005, z);
  }

  onSelectEnd() { this.offset = 0; $('time').value = 0; this.applyHour(); }

  update() {
    const dt = Math.min(xb.getDeltaTime(), 0.05);
    const s = this.state;
    if ((this._surfaceAge += dt) > 1) { this._surfaceAge = 0; this.sampleSurfaces(); }
    // ветер: направление «откуда» → вектор «куда», север = −z
    const a = ((s.wdir + 180) % 360) * Math.PI / 180;
    const wx = Math.sin(a) * s.wind * 0.12;
    const wz = -Math.cos(a) * s.wind * 0.12;
    const raining = s.rain > 0.05;
    // свет и атмосфера
    this.sun.intensity = Math.max(0.25, 1.7 * (1 - s.cloud / 130));
    this.hemi.intensity = Math.max(0.4, 1.3 * (1 - s.cloud / 160));
    const ceil = 1.4 + ((s.press - 990) / 40) * 1.6; // ~1.4–3.0 м
    // цвет воздуха по температуре: −15..+30 → синий..оранжевый
    const t = Math.min(1, Math.max(0, (s.temp + 15) / 45));
    this.tmpC.setHSL(0.62 - t * 0.55, 0.85, 0.55);

    const p = this.pgeo.attributes.position.array;
    const speedK = 0.6 + Math.abs(s.temp) / 12;
    for (let i = 0; i < COUNT; i++) {
      const ix = i * 3;
      let x = p[ix], y = p[ix + 1], z = p[ix + 2];
      const isRain = raining && (i % 3 === 0);
      if (isRain) {
        y -= (2.2 + s.rain * 0.8) * dt;
        x += wx * dt * 0.4;
        const landing = this.floorY(x, z);
        if (y <= landing) {
          this.splash(x, landing, z);
          this.respawn(i, p);
          x = p[ix]; y = p[ix + 1]; z = p[ix + 2];
        }
      } else {
        x += (wx * speedK + this.vel[ix]) * dt * 3;
        y += (-0.05 + Math.sin(x * 2 + performance.now() * 0.001) * 0.05) * dt * 3;
        z += (wz * speedK + this.vel[ix + 2]) * dt * 3;
        if (x > BOX.x || x < -BOX.x || z > BOX.z || z < -BOX.z || y > ceil || y < 0.02) {
          if (y <= 0.02 && !raining) { y = 0.02; }
          else this.respawn(i, p);
          x = p[ix]; y = p[ix + 1]; z = p[ix + 2];
        }
      }
      p[ix] = x; p[ix + 1] = y; p[ix + 2] = z;
      const glow = isRain ? 0.25 : 0;
      this.col[ix] = this.tmpC.r + glow;
      this.col[ix + 1] = this.tmpC.g + glow;
      this.col[ix + 2] = this.tmpC.b + glow;
    }
    this.pgeo.attributes.position.needsUpdate = true;
    this.pgeo.attributes.color.needsUpdate = true;

    for (const sp of this.splashes) {
      if (sp.t >= sp.dur) { sp.mesh.visible = false; continue; }
      sp.t += dt;
      const k = Math.min(1, sp.t / sp.dur);
      sp.mesh.scale.setScalar(0.03 + k * 0.16);
      sp.mesh.material.uniforms.uT.value = k;
    }

    this._fp += dt;
    if (this._fp > 0.5) {
      this._fp = 0;
      this.stat(
        `T ${s.temp.toFixed(1)}°C · ветер ${s.wind.toFixed(1)} м/с ${Math.round(s.wdir)}° · ` +
        `облака ${s.cloud}% · осадки ${s.rain.toFixed(1)} мм · ${Math.round(s.press)} гПа` +
        (raining ? ' · ДОЖДЬ' : '') +
        ` · поверхностей ${this.surfaces.length}`
      );
    }
  }

  dispose() {
    this.pgeo.dispose(); this.points.material.dispose();
    for (const sp of this.splashes) sp.mesh.material.dispose();
    this.splashGeo.dispose();
  }
}

const options = new xb.Options();
options.enableReticles();
options.enablePlaneDetection();
options.world.planes.showDebugVisualizations =
  new URLSearchParams(window.location.search).has('debug');
options.xrButton.showEnterSimulatorButton = true;
options.setAppTitle('WEATHER//ROOM');
options.setAppDescription('Погода снаружи — частицы внутри. Слайдер мотает ±24 ч.');

installXrGuards();

document.addEventListener('DOMContentLoaded', () => {
  xb.add(new WeatherRoom());
  xb.init(options);
  watchXrButton();
});
