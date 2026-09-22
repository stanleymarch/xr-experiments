import * as THREE from 'three';
import * as xb from 'xrblocks';
import { pointsMaterial, shockRingMaterial } from '../common/fx.js';
import { makeHud } from '../common/hud.js?v=spatial-ui-9';
import { installXrGuards, watchXrButton } from '../common/boot.js';

// WEATHER//ROOM — погода снаружи становится телом комнаты.
// Один запрос к Open-Meteo (без ключа), дальше всё локально. Каждое поле
// ответа имеет видимую причину, а не только цифру в телеметрии:
//
//   rain / showers / snowfall → три слоя: мелкая морось, крупный ливень,
//       медленный турбулентный снег. Цвет осадков нейтральный (голубой…белый)
//       и НЕ зависит от температуры.
//   weather_code → имя состояния, мгла для 45/48, вспышки для грозы 95+.
//   cloud_cover  → плотность облачной плиты над головой.
//   visibility   → аддитивная мгла у пола и падение контраста (lum).
//   humidity     → плотность и яркость аэрозоля.
//   temperature  → только цвет аэрозоля и мглы.
//   wind_speed_10m + wind_direction_10m → снос по X И Z для капель, снега,
//       аэрозоля и плиты облаков.
//   wind_gusts_10m → турбулентность аэрозоля.
//   pressure_msl → высота базы облаков, откуда стартуют осадки.
//   is_day → ночь: звёзды, холодные цвета, низкий уровень света.
//
// Комнату в AR осветить нельзя (passthrough не принимает THREE-лампы),
// поэтому «свет» здесь — emissive-усиление слоёв (lum): облака и мгла его
// гасят, день и ночь задают. Слайдер −24ч…+24ч мотает погоду; пол и
// найденные плоскости ловят капли.

const ATM = { x: 3, z: 3, yMin: 0.03, yMax: 3.4 };
const SPLASH_POOL = 6;
const BELOW = -60; // «припаркованный» слот: под полом, цвет 0 → аддитив его не рисует
const COUNTS = { drizzle: 240, shower: 120, snow: 280, mote: 80, star: 130 };

// Палитра: осадки — только голубой и белый, температура их не трогает.
const C = {
  drizzle: new THREE.Color(0x9fd0ff),
  shower: new THREE.Color(0xcfe8ff),
  snow: new THREE.Color(0xeef6ff),
  star: new THREE.Color(0xdfeaff),
  moteCold: new THREE.Color(0x9fc4ff),
  moteWarm: new THREE.Color(0xffd2a0),
  splash: new THREE.Color(0xcfeaff),
  deckDay: new THREE.Color(0xfff2e2),
  deckNight: new THREE.Color(0x33405f),
  hazeDay: new THREE.Color(0xbcd2e6),
  hazeNight: new THREE.Color(0x2c3a56),
};

// Коды WMO: [от, до, имя].
const WMO = [
  [0, 0, 'ЯСНО'], [1, 1, 'ПРЕИМ. ЯСНО'], [2, 2, 'ПЕРЕМЕННАЯ ОБЛАЧНОСТЬ'], [3, 3, 'ПАСМУРНО'],
  [45, 48, 'ТУМАН'], [51, 55, 'МОРОСЬ'], [56, 57, 'ЛЕДЯНАЯ МОРОСЬ'],
  [61, 61, 'НЕБОЛЬШОЙ ДОЖДЬ'], [63, 63, 'ДОЖДЬ'], [65, 65, 'СИЛЬНЫЙ ДОЖДЬ'],
  [66, 67, 'ЛЕДЯНОЙ ДОЖДЬ'], [71, 71, 'НЕБОЛЬШОЙ СНЕГ'], [73, 73, 'СНЕГ'],
  [75, 75, 'СИЛЬНЫЙ СНЕГ'], [77, 77, 'СНЕЖНАЯ КРУПА'], [80, 80, 'ЛИВЕНЬ'],
  [81, 81, 'СИЛЬНЫЙ ЛИВЕНЬ'], [82, 82, 'ОЧЕНЬ СИЛЬНЫЙ ЛИВЕНЬ'], [85, 86, 'СНЕЖНЫЙ ЛИВЕНЬ'],
  [95, 95, 'ГРОЗА'], [96, 99, 'ГРОЗА С ГРАДОМ'],
];
const ROSE = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const dirName = (deg) => ROSE[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

function conditionName(code) {
  for (const [a, b, label] of WMO) if (code >= a && code <= b) return label;
  return 'НЕИЗВЕСТНО';
}

// Синтетика на случай, если сеть недоступна. Поля согласованы между собой:
// суточный ход температуры и влажности, фронт раз в ~56 ч (ливни), страты
// (дождь), холодная волна превращает осадки в снег, провал видимости — туман.
function demoData() {
  const now = Date.now();
  const base = now - (now % 3600e3);
  const time = [];
  for (let i = -24; i <= 48; i++) time.push(new Date(base + i * 3600e3).toISOString());
  const n = time.length;
  const h = {
    time, temperature_2m: [], relative_humidity_2m: [], precipitation: [],
    rain: [], showers: [], snowfall: [], weather_code: [], cloud_cover: [],
    visibility: [], wind_speed_10m: [], wind_gusts_10m: [], wind_direction_10m: [],
    pressure_msl: [], is_day: [],
  };
  for (let i = 0; i < n; i++) {
    const hour = new Date(time[i]).getHours();
    const diurnal = Math.sin(((hour - 9) / 24) * Math.PI * 2); // пик в 15:00
    const storm = Math.sin((i + 5) / 9); // фронт: ливни в максимуме, туман в провале
    const temp = 2 + 9 * diurnal + 4 * Math.sin(i / 13);
    const foggy = storm < -0.7;
    let rain = 0, showers = 0, snow = 0, code = 1;
    if (foggy) {
      code = 45;
    } else if (storm > 0.5) {
      showers = 0.6 + 2.4 * (storm - 0.5);
      code = showers > 1.8 ? 82 : showers > 1.0 ? 81 : 80;
    } else if (storm > 0.1) {
      rain = 0.15 + 0.75 * storm;
      code = rain > 0.6 ? 63 : 61;
    } else if (storm > -0.3) {
      code = 2;
    } else {
      code = 0;
    }
    if (temp < 1.2 && rain + showers > 0) {
      // тот же фронт, но мороз: вода выпадает снегом
      snow = (rain + showers) * 0.8;
      rain = showers = 0;
      code = snow > 0.8 ? 75 : snow > 0.3 ? 73 : 71;
    }
    const wet = rain + showers + snow;
    let cloud = foggy ? 95 : clamp(14 + 62 * Math.max(0, storm) + 34 * Math.min(1, wet), 4, 98);
    if (wet > 0.02) cloud = Math.max(cloud, 62 + 33 * Math.min(1, wet)); // осадки не падают из ясного неба
    cloud = Math.round(cloud);
    h.temperature_2m.push(Math.round(temp * 10) / 10);
    h.relative_humidity_2m.push(Math.round(clamp(52 + 0.35 * cloud + 14 * Math.min(1, wet) - 10 * diurnal, 28, 99)));
    h.precipitation.push(Math.round((rain + showers + snow * 0.7) * 100) / 100);
    h.rain.push(Math.round(rain * 100) / 100);
    h.showers.push(Math.round(showers * 100) / 100);
    h.snowfall.push(Math.round(snow * 100) / 100);
    h.weather_code.push(code);
    h.cloud_cover.push(cloud);
    h.visibility.push(Math.round(clamp(26000 - 170 * cloud - 4200 * wet - (foggy ? 24500 : 0), 250, 32000)));
    h.wind_speed_10m.push(Math.round((1.8 + 5.2 * Math.abs(storm)) * 10) / 10);
    h.wind_gusts_10m.push(Math.round((1.8 + 5.2 * Math.abs(storm)) * (1.6 + 0.5 * Math.abs(storm)) * 10) / 10);
    h.wind_direction_10m.push(Math.round(235 + 45 * Math.sin(i / 13)));
    h.pressure_msl.push(Math.round((1014 + 9 * Math.sin(i / 17) - 10 * Math.max(0, storm)) * 10) / 10);
    h.is_day.push(hour >= 7 && hour < 21 ? 1 : 0);
  }
  return { hourly: h };
}

async function fetchWeather(lat, lon) {
  const q = new URL('https://api.open-meteo.com/v1/forecast');
  q.search = new URLSearchParams({
    latitude: String(lat), longitude: String(lon),
    hourly: [
      'temperature_2m', 'relative_humidity_2m', 'precipitation', 'rain', 'showers',
      'snowfall', 'weather_code', 'cloud_cover', 'visibility', 'wind_speed_10m',
      'wind_gusts_10m', 'wind_direction_10m', 'pressure_msl', 'is_day',
    ].join(','),
    past_days: '1', forecast_days: '2', timezone: 'auto',
  }).toString();
  const r = await fetch(q);
  if (!r.ok) throw new Error(`meteo ${r.status}`);
  return r.json();
}

// Облачная плита: тайлящийся value-noise едет по ветру без швов и без потери
// точности (mod по периоду ячеек), поэтому снос можно копить сколько угодно.
const DECK_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const DECK_FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform vec2 uDrift;
  uniform float uCover, uLum;
  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  float vnoise(vec2 p, float period) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    vec2 a = mod(i, period), b = mod(i + 1.0, period);
    return mix(
      mix(hash(vec2(a.x, a.y)), hash(vec2(b.x, a.y)), f.x),
      mix(hash(vec2(a.x, b.y)), hash(vec2(b.x, b.y)), f.x),
      f.y);
  }

  void main() {
    vec2 p = vUv * 6.0 + uDrift;
    float n = vnoise(p, 6.0) * 0.68 + vnoise(p * 2.0, 12.0) * 0.32;
    float t = clamp((n - (1.02 - uCover)) / 0.3, 0.0, 1.0);
    float edge = smoothstep(1.0, 0.35, length(vUv - 0.5) * 2.0);
    gl_FragColor = vec4(uColor * uLum * (0.55 + 0.45 * t), t * edge * 0.6);
  }`;

// Мгла — сфера вокруг комнаты: чем хуже видимость, тем гуще аддитивная пелена,
// гуще у пола (там же, где оседают капли).
const HAZE_VERT = /* glsl */`
  varying float vY;
  void main() {
    vY = clamp(normalize(position).y * 0.5 + 0.5, 0.0, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const HAZE_FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform float uFog, uLum;
  varying float vY;
  void main() {
    gl_FragColor = vec4(uColor * uLum, uFog * mix(0.5, 0.05, vY));
  }`;

class WeatherRoom extends xb.Script {
  init() {
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(ATM.x * 3, ATM.z * 3),
      new THREE.MeshBasicMaterial({ color: 0x1c3a52, transparent: true, opacity: 0.35 })
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.add(this.floor);

    this.state = {
      temp: 8, rh: 65, cloud: 50, wind: 4, gust: 6, wdir: 225, press: 1010,
      vis: 15000, rain: 0, showers: 0, snow: 0, code: 2, isDay: 1, precip: 0,
    };
    this.spawnY = 2.3;
    this.deckY = 2.3;
    this.rate = { drizzle: 0, shower: 0, snow: 0 };
    this.cloud = 0.5;
    this.fogK = 0;
    this.dayK = 1;
    this.lumK = 0.8;
    this.starK = 0;
    this.flash = 0;
    this.flashT = 4;
    this.deckColorT = C.deckDay.clone();
    this.hazeColorT = C.hazeDay.clone();

    this.drizzle = this.makeLayer('drizzle', C.drizzle, COUNTS.drizzle, 0.028, 0.6);
    this.shower = this.makeLayer('shower', C.shower, COUNTS.shower, 0.06, 0.7);
    this.snow = this.makeLayer('snow', C.snow, COUNTS.snow, 0.04, 0.8);
    this.mote = this.makeLayer('mote', C.moteCold, COUNTS.mote, 0.01, 0.2);
    this.star = this.makeLayer('star', C.star, COUNTS.star, 0.03, 0.9);
    // не this.layers: так называется THREE.Layers у Object3D, и рендер падает.
    this.strata = [this.drizzle, this.shower, this.snow, this.mote, this.star];
    for (const L of [this.drizzle, this.shower, this.snow]) {
      for (let i = 0; i < L.count; i++) this.spawnSlot(L, i, true);
      this.setActive(L, 0);
    }
    this.seedMotes();
    this.seedStars();

    this.deckMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: C.deckDay.clone() },
        uDrift: { value: new THREE.Vector2() },
        uCover: { value: 0.5 },
        uLum: { value: 1 },
      },
      vertexShader: DECK_VERT, fragmentShader: DECK_FRAG,
    });
    this.deckMesh = new THREE.Mesh(new THREE.PlaneGeometry(7, 7), this.deckMat);
    this.deckMesh.rotation.x = Math.PI / 2;
    this.deckMesh.position.y = this.deckY;
    this.add(this.deckMesh);
    this.drift = new THREE.Vector2();

    this.hazeMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: C.hazeDay.clone() }, uFog: { value: 0 }, uLum: { value: 1 } },
      vertexShader: HAZE_VERT, fragmentShader: HAZE_FRAG,
    });
    this.hazeMesh = new THREE.Mesh(new THREE.SphereGeometry(5.2, 24, 16), this.hazeMat);
    this.hazeMesh.position.y = 1;
    this.hazeMesh.renderOrder = -5;
    this.add(this.hazeMesh);

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
    this.lat = 59.934; this.lon = 30.335; // как в старых полях ввода
    this._fp = 0;

    this.hud = makeHud({
      title: 'WEATHER//ROOM',
      stat: 'запрос геопозиции…',
      slider: {
        min: -24, max: 24, step: 1, value: 0, ariaLabel: 'время ±24ч',
        onInput: (v) => { this.offset = v; this.applyHour(); },
      },
      buttons: [
        {
          id: 'now', label: 'NOW',
          onTap: () => { this.hud.setSliderValue(0); this.offset = 0; this.applyHour(); },
        },
        { id: 'geo', label: 'LOCATE', onTap: () => this.locate() },
      ],
    });
    this.add(this.hud.card);
    this.locate();
  }

  stat(s) { this.hud.setStat(s); }

  // Points-слой: свой буфер позиций, свой per-point цвет (джиттер яркости или 0
  // у припаркованных), свои цели цвета/прозрачности на текущий час.
  makeLayer(kind, base, count, size, opacity) {
    const pos = new Float32Array(count * 3).fill(BELOW);
    const col = new Float32Array(count * 3);
    const geo = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(pos, 3);
    pa.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', pa);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = pointsMaterial({ size, opacity });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    this.add(points);
    return {
      kind, count, pos, col, geo, mat, points, active: 0,
      phase: new Float32Array(count).map(() => Math.random() * Math.PI * 2),
      base: base.clone(), baseT: base.clone(), gain: 0, op: opacity, opT: opacity,
    };
  }

  spawnSlot(L, i, randomY = false) {
    const ix = i * 3;
    L.pos[ix] = (Math.random() * 2 - 1) * ATM.x;
    L.pos[ix + 1] = randomY ? 0.2 + Math.random() * (this.spawnY - 0.2) : this.spawnY;
    L.pos[ix + 2] = (Math.random() * 2 - 1) * ATM.z;
  }

  // Переводит слой на нужное число частиц: лишние уходят под пол с нулевым
  // цветом (аддитив их не рисует), вернувшиеся получают свежий джиттер.
  setActive(L, n) {
    if (L.active === n) return;
    const p = L.pos, c = L.col;
    for (let i = 0; i < L.count; i++) {
      const ix = i * 3;
      if (i < n) {
        if (p[ix + 1] <= BELOW + 0.01) this.spawnSlot(L, i, true);
        if (c[ix] === 0) {
          const g = 0.62 + Math.random() * 0.38;
          c[ix] = c[ix + 1] = c[ix + 2] = g;
        }
      } else if (c[ix] !== 0 || p[ix + 1] > BELOW + 0.01) {
        c[ix] = c[ix + 1] = c[ix + 2] = 0;
        p[ix + 1] = BELOW;
      }
    }
    L.active = n;
    L.geo.attributes.color.needsUpdate = true;
    L.geo.attributes.position.needsUpdate = true;
  }

  seedMotes() {
    const L = this.mote, p = L.pos, c = L.col;
    for (let i = 0; i < L.count; i++) {
      const ix = i * 3;
      p[ix] = (Math.random() * 2 - 1) * ATM.x;
      p[ix + 1] = ATM.yMin + Math.random() * (ATM.yMax - ATM.yMin);
      p[ix + 2] = (Math.random() * 2 - 1) * ATM.z;
      const g = 0.5 + Math.random() * 0.5;
      c[ix] = c[ix + 1] = c[ix + 2] = g;
    }
  }

  // Звёзды — купол над комнатой: днём и в облаках гаснут цветом слоя.
  seedStars() {
    const L = this.star, p = L.pos, c = L.col;
    for (let i = 0; i < L.count; i++) {
      const u = Math.random() * 0.9 + 0.1;
      const phi = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - u * u)) * 5;
      const ix = i * 3;
      p[ix] = Math.cos(phi) * r;
      p[ix + 1] = 1.2 + u * 3.8;
      p[ix + 2] = Math.sin(phi) * r;
      const g = 0.55 + Math.random() * 0.45;
      c[ix] = c[ix + 1] = c[ix + 2] = g;
    }
  }

  locate() {
    if (!navigator.geolocation) return this.load(this.lat, this.lon);
    this.stat('запрос геопозиции…');
    navigator.geolocation.getCurrentPosition(
      (p) => {
        this.lat = +p.coords.latitude.toFixed(3);
        this.lon = +p.coords.longitude.toFixed(3);
        this.load(this.lat, this.lon);
      },
      () => this.load(this.lat, this.lon),
      { timeout: 6000 }
    );
  }

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
    const g = (key, d = 0) => num(h[key] && h[key][i], d);
    const rain = g('rain');
    const showers = g('showers');
    this.state = {
      temp: g('temperature_2m', 8),
      rh: g('relative_humidity_2m', 65),
      cloud: g('cloud_cover', 50),
      wind: g('wind_speed_10m', 4),
      gust: g('wind_gusts_10m', num(h.wind_speed_10m && h.wind_speed_10m[i], 4) * 1.6),
      wdir: g('wind_direction_10m', 225),
      press: g('pressure_msl', 1010),
      vis: g('visibility', 15000),
      rain, showers, snow: g('snowfall'),
      code: Math.round(g('weather_code', 2)),
      isDay: g('is_day', 1) > 0.5 ? 1 : 0,
      precip: g('precipitation', rain + showers),
    };
    this.derive();
    this.refreshLook();
    const when = new Date(Date.parse(h.time[i]));
    this.hud.setSliderLabel(
      `${this.offset === 0 ? 'NOW · ' : ''}${when.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} ` +
      `· ${this.offset >= 0 ? '+' : ''}${this.offset}ч`);
  }

  // Физика состояния → числа для сцены: высота базы облаков, мгла, уровень
  // света и интенсивности трёх слоёв осадков.
  derive() {
    const s = this.state;
    this.deckY = clamp(1.75 + ((s.press - 990) / 40) * 1.5, 1.5, 3.3);
    this.spawnY = this.deckY;
    let fog = Math.pow(1 - Math.min(s.vis, 12000) / 12000, 2.2);
    if (s.code === 45 || s.code === 48) fog = Math.max(fog, 0.72);
    this.fogK = clamp(fog, 0, 1);
    this.dayK = s.isDay ? 1 : 0.34;
    const cloud01 = clamp(s.cloud / 100, 0, 1);
    this.lumK = clamp(this.dayK * (1 - cloud01 * 0.5) * (1 - this.fogK * 0.45), 0.22, 1);
    this.rate = {
      drizzle: clamp(s.rain / 0.6, 0, 1),   // 0.6 мм/ч — плотная морось
      shower: clamp(s.showers / 3, 0, 1),   // 3 мм/ч — сильный ливень
      snow: clamp(s.snow / 1.2, 0, 1),      // 1.2 см/ч — сильный снег
    };
  }

  refreshLook() {
    const s = this.state;
    const cloud01 = clamp(s.cloud / 100, 0, 1);
    this.cloudT = cloud01;
    this.mote.baseT.copy(C.moteCold).lerp(C.moteWarm, clamp((s.temp + 15) / 45, 0, 1));
    this.drizzle.opT = 0.45 + 0.35 * this.rate.drizzle;
    this.shower.opT = 0.5 + 0.4 * this.rate.shower;
    this.snow.opT = 0.6 + 0.3 * this.rate.snow;
    const rh01 = clamp((s.rh - 25) / 74, 0, 1);
    this.mote.opT = (0.05 + 0.15 * rh01) * (1 - 0.4 * this.fogK);
    this.starK = (1 - s.isDay) * Math.pow(1 - cloud01, 1.5) * (1 - this.fogK);
    this.deckColorT.copy(s.isDay ? C.deckDay : C.deckNight);
    this.hazeColorT.copy(s.isDay ? C.hazeDay : C.hazeNight);
    this.setActive(this.drizzle, Math.round(this.rate.drizzle * COUNTS.drizzle));
    this.setActive(this.shower, Math.round(this.rate.shower * COUNTS.shower));
    this.setActive(this.snow, Math.round(this.rate.snow * COUNTS.snow));
  }

  // Имя текущего состояния: физика осадков важнее кода модели.
  condition() {
    const s = this.state;
    if (s.snow > 0.05 && s.code < 70) return 'СНЕГ';
    if (s.rain + s.showers > 0.05 && s.code < 50) return 'ДОЖДЬ';
    return conditionName(s.code);
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
      if (this._box.max.y <= 0.02 || this._box.max.y > ATM.yMax) continue;
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

  // Капли: падают быстро, обе горизонтальные компоненты ветра сносят их
  // пропорционально скорости; встреча с поверхностью даёт всплеск.
  stepRain(L, dt, wx, wz, fall, advect) {
    const p = L.pos;
    for (let i = 0; i < L.active; i++) {
      const ix = i * 3;
      const x = p[ix] + wx * advect * dt;
      const z = p[ix + 2] + wz * advect * dt;
      const y = p[ix + 1] - fall * dt;
      const landing = this.floorY(x, z);
      if (y <= landing) {
        this.splash(x, landing, z);
        this.spawnSlot(L, i, false);
        continue;
      }
      p[ix] = x; p[ix + 1] = y; p[ix + 2] = z;
    }
    L.geo.attributes.position.needsUpdate = true;
  }

  // Снег: медленно, с турбулентным вихрем на своей фазе и слабым сносом.
  stepSnow(L, dt, wx, wz, t) {
    const p = L.pos, ph = L.phase;
    const fall = 0.35 + 0.25 * this.rate.snow;
    for (let i = 0; i < L.active; i++) {
      const ix = i * 3, a = ph[i];
      const x = p[ix] + (wx * 0.4 + Math.sin(t * 1.3 + a) * 0.22) * dt;
      const z = p[ix + 2] + (wz * 0.4 + Math.cos(t * 1.1 + a * 1.7) * 0.22) * dt;
      const y = p[ix + 1] - (fall + Math.sin(t * 2.1 + a * 2.3) * 0.06) * dt;
      if (y <= this.floorY(x, z)) {
        this.spawnSlot(L, i, false);
        continue;
      }
      p[ix] = x; p[ix + 1] = y; p[ix + 2] = z;
    }
    L.geo.attributes.position.needsUpdate = true;
  }

  // Аэрозоль: дрейфует по ветру (обе компоненты), дрожит от порывов,
  // заворачивается по границам бокса — комната остаётся наполненной.
  stepMotes(dt, wx, wz, t) {
    const L = this.mote, p = L.pos, ph = L.phase;
    const gust = clamp(this.state.gust / 14, 0, 1);
    for (let i = 0; i < L.count; i++) {
      const ix = i * 3, a = ph[i];
      let x = p[ix] + (wx * 0.35 + Math.sin(t * 0.9 + a) * 0.4 * gust) * dt;
      let y = p[ix + 1] + (Math.sin(t * 0.7 + a * 2.3) * 0.2 + 0.04) * dt;
      let z = p[ix + 2] + (wz * 0.35 + Math.cos(t * 0.8 + a * 1.3) * 0.4 * gust) * dt;
      if (x > ATM.x) x -= ATM.x * 2; else if (x < -ATM.x) x += ATM.x * 2;
      if (z > ATM.z) z -= ATM.z * 2; else if (z < -ATM.z) z += ATM.z * 2;
      if (y > ATM.yMax) y = ATM.yMin; else if (y < ATM.yMin) y = ATM.yMax;
      p[ix] = x; p[ix + 1] = y; p[ix + 2] = z;
    }
    L.geo.attributes.position.needsUpdate = true;
  }


  update() {
    const dt = Math.min(xb.getDeltaTime(), 0.05);
    const t = performance.now() * 0.001;
    const s = this.state;
    if ((this._surfaceAge += dt) > 1) { this._surfaceAge = 0; this.sampleSurfaces(); }

    // гроза: редкие вспышки поверх всего emissive-слоя
    if (s.code >= 95) {
      this.flashT -= dt;
      if (this.flashT <= 0) { this.flash = 1; this.flashT = 3.5 + Math.random() * 6; }
    }
    this.flash = Math.max(0, this.flash - dt * 3.2);

    // ветер: направление «откуда» → вектор «куда», север = −z, обе компоненты
    const a = ((s.wdir + 180) % 360) * Math.PI / 180;
    const wx = Math.sin(a) * s.wind;
    const wz = -Math.cos(a) * s.wind;

    this.stepRain(this.drizzle, dt, wx, wz, 2.6 + 1.4 * this.rate.drizzle, 0.7);
    this.stepRain(this.shower, dt, wx, wz, 3.6 + 2.2 * this.rate.shower, 0.6);
    this.stepSnow(this.snow, dt, wx, wz, t);
    this.stepMotes(dt, wx, wz, t);

    // Плавная подстройка слоёв к целям текущего часа: часы на слайдере
    // не должны «щёлкать», а цвета — это только uniform-ы, без перезаписи буферов.
    const k = Math.min(1, dt * 2.2);
    const lit = this.lumK * (1 + this.flash * 0.9);
    for (const L of this.strata) {
      const gainT = L.kind === 'star' ? this.starK : lit;
      L.gain += (gainT - L.gain) * k;
      L.base.lerp(L.baseT, k);
      L.op += (L.opT - L.op) * k;
      L.mat.uniforms.uColor.value.copy(L.base).multiplyScalar(L.gain);
      L.mat.uniforms.uOpacity.value = L.op;
    }

    this.cloud += (this.cloudT - this.cloud) * k;
    this.deckMat.uniforms.uCover.value = this.cloud;
    this.deckMat.uniforms.uColor.value.lerp(this.deckColorT, k);
    this.deckMat.uniforms.uLum.value = lit * (1 - 0.7 * this.fogK);
    this.deckMesh.position.y = this.deckY;
    this.drift.x = (this.drift.x + wx * dt * 0.012) % 6;
    this.drift.y = (this.drift.y + wz * dt * 0.012) % 6;
    this.deckMat.uniforms.uDrift.value.copy(this.drift);

    this.hazeMat.uniforms.uFog.value += (this.fogK - this.hazeMat.uniforms.uFog.value) * k;
    this.hazeMat.uniforms.uColor.value.lerp(this.hazeColorT, k);
    this.hazeMat.uniforms.uLum.value = 0.5 + 0.5 * this.dayK + this.flash * 0.3;

    const splashLit = 0.45 + 0.85 * lit;
    for (const sp of this.splashes) {
      sp.mesh.material.uniforms.uColor.value.copy(C.splash).multiplyScalar(splashLit);
      if (sp.t >= sp.dur) { sp.mesh.visible = false; continue; }
      sp.t += dt;
      const f = Math.min(1, sp.t / sp.dur);
      sp.mesh.scale.setScalar(0.03 + f * 0.16);
      sp.mesh.material.uniforms.uT.value = f;
    }

    this._fp += dt;
    if (this._fp > 0.5) {
      this._fp = 0;
      const vis = s.vis >= 1000 ? `${(s.vis / 1000).toFixed(1)} км` : `${Math.round(s.vis)} м`;
      this.stat(
        `${this.condition()} · ${s.temp.toFixed(1)}°C · ветер ${s.wind.toFixed(1)} м/с ${dirName(s.wdir)}, порыв ${s.gust.toFixed(1)} · ` +
        `облака ${Math.round(s.cloud)}% · влажн ${Math.round(s.rh)}% · видим ${vis} · ${Math.round(s.press)} гПа · ` +
        `дождь ${s.rain.toFixed(2)} · ливень ${s.showers.toFixed(2)} · снег ${s.snow.toFixed(2)} см/ч · ` +
        `частиц ${this.drizzle.active}/${this.shower.active}/${this.snow.active}`
      );
    }
  }

  dispose() {
    for (const L of this.strata) { L.geo.dispose(); L.mat.dispose(); }
    for (const sp of this.splashes) sp.mesh.material.dispose();
    this.splashGeo.dispose();
    this.deckMesh.geometry.dispose();
    this.deckMat.dispose();
    this.hazeMesh.geometry.dispose();
    this.hazeMat.dispose();
    this.floor.geometry.dispose();
    this.floor.material.dispose();
  }
}

const options = new xb.Options();
options.enableReticles();
options.enablePlaneDetection();
options.world.planes.showDebugVisualizations =
  new URLSearchParams(window.location.search).has('debug');
options.xrButton.showEnterSimulatorButton = true;
options.setAppTitle('WEATHER//ROOM');
options.setAppDescription('Погода снаружи — слои частиц внутри. Каждое поле метео видно глазом.');

installXrGuards();

document.addEventListener('DOMContentLoaded', () => {
  xb.add(new WeatherRoom());
  xb.init(options);
  watchXrButton();
});
