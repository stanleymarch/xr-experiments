import * as THREE from 'three';
import * as xb from 'xrblocks';
import { SimpleDecalGeometry } from 'xrblocks/addons/objects/SimpleDecalGeometry.js';
import { VolumetricCloud } from 'xrblocks/addons/volumes/VolumetricCloud.js';
import { glowBlending, pointsMaterial, shockRingMaterial } from '../common/fx.js?v=mobile-ux-24';
import { makeHud } from '../common/hud.js?v=mobile-ux-24';
import {
  enableAutomation, hideInPassthrough, installLaunchShell, installXrGuards,
  isAutomation, isPassthrough, previewFromEyeHeight, watchXrButton,
} from '../common/boot.js?v=mobile-ux-24';

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
//
// Облака — двухслойные: шейдерная плита DECK (потолок слоя, видна и на
// десктопе) и объём VolumetricCloud из аддонов SDK, который даёт плите тело.
// Объём рей-марчится и рисует себя в premultiplied-виде, а passthrough-AR
// отдаёт alpha-blend кадр: переключать режим блендинга чужому
// RawShaderMaterial вслепую нельзя, поэтому в alpha-blend объём не ставится
// вообще (isPassthrough → только плита), это честная деградация, а не
// выключенная фича.
//
// Пятна от капель. Кольцо-всплеск — мгновенная презентация попадания, а след
// на поверхности держит декаль: SimpleDecalGeometry проецирует пятно на
// найденную плоскость. Источником служит не сам полигон детектора, а его
// ровная тесселированная копия (полигон — редкая выпуклая оболочка, в объём
// проектора не попадает ни одной её вершины), поэтому декаль повторяет наклон
// и границы настоящей поверхности комнаты.
//
// Звук дождя — progressive enhancement: буфер официальных ассетов SDK
// подтягивается только после жеста SOUND (политика браузера), громкость идёт
// от интенсивности осадков текущего часа. Нет сети или нет звука — опыт
// остаётся визуальным и молчит.

const ATM = { x: 3, z: 3, yMin: 0.03, yMax: 3.4 };
const SPLASH_POOL = 6;
const BELOW = -60; // «припаркованный» слот: под полом, цвет 0 → аддитив его не рисует
const COUNTS = { drizzle: 240, shower: 120, snow: 280, mote: 80, star: 130 };
// Облачный объём аддона SDK: ширина и толщина подобраны под комнату ATM и
// цену рей-марчинга (steps — шагов на луч, при 50 как в сэмпле SDK комната
// на телефоне уже тяжело дышит). Ниже minCover объём выключается целиком.
const CLOUD = { width: 4.6, thick: 0.85, steps: 28, minCover: 0.15 };
// Декали-пятна: пул с жёстким капом (телефон в passthrough дешевле гарнитуры),
// жизнь 6…12 с, дальше слот переиспользуется. step/segMax — сетка-источник
// декали: мельче ячейка — меньше минимальное пятно, но дороже копия геометрии.
const DECAL = {
  phone: 24, quest: 40,
  step: 0.08, segMax: 48,
  water: {
    scale: [0.18, 0.3], life: [6, 10], opacity: 0.5,
    color: new THREE.Color(0xa9d6f2),
  },
  snow: {
    scale: [0.17, 0.26], life: [8, 12], opacity: 0.42,
    color: new THREE.Color(0xf2f8ff),
  },
};
// Звук дождя: официальные ассеты SDK (тот же файл, что в samples/advanced/rain).
const RAIN_SOUND_URL = 'https://cdn.jsdelivr.net/gh/xrblocks/assets@main/demos/rain/rain.opus';
// Ливень рисуется не точками, а полосами-билбордами: width — толщина росчерка,
// exposure — «выдержка» в секундах, на неё умножается скорость падения, поэтому
// при ливне росчерк длиннее, чем при мороси (морось остаётся точками).
const STREAK = { width: 0.014, exposure: 0.045 };
// Depth-осведомлённый дождь. every — каждая вторая капля, fade — на сколько
// метров ухода за реальную геометрию капля гаснет; tie — доля капель, которые
// рождаются прямо на depth-меше.
const DEPTH_RAIN = { every: 2, fov: 0.9, fade: 0.6, tie: 0.1, minDepth: 0.1 };
// Рейкастер рождения капель. Он живёт вне колбэков ввода (там свой
// Raycaster запрещён контрактом: он видел бы другой кадр) и используется
// только в update() для привязки капли к глубине текущего кадра.
const DEPTH_RAYCASTER = new THREE.Raycaster();

// Палитра: осадки — только голубой и белый, температура их не трогает.
const C = {
  drizzle: new THREE.Color(0x9fd0ff),
  shower: new THREE.Color(0xcfe8ff),
  snow: new THREE.Color(0xeef6ff),
  star: new THREE.Color(0xdfeaff),
  moteCold: new THREE.Color(0x9fc4ff),
  moteWarm: new THREE.Color(0xffd2a0),
  splash: new THREE.Color(0xcfeaff),
  deckDay: new THREE.Color(0x18243a),
  deckNight: new THREE.Color(0x080e1c),
  cloudDay: new THREE.Color(0x9fb4cf),
  cloudNight: new THREE.Color(0x2c3550),
  hazeDay: new THREE.Color(0x334861),
  hazeNight: new THREE.Color(0x11182b),
};

// Коды WMO: [от, до, имя].
const WMO = [
  [0, 0, 'CLEAR'], [1, 1, 'MOSTLY CLEAR'], [2, 2, 'PARTLY CLOUDY'], [3, 3, 'OVERCAST'],
  [45, 48, 'FOG'], [51, 55, 'DRIZZLE'], [56, 57, 'FREEZING DRIZZLE'],
  [61, 61, 'LIGHT RAIN'], [63, 63, 'RAIN'], [65, 65, 'HEAVY RAIN'],
  [66, 67, 'FREEZING RAIN'], [71, 71, 'LIGHT SNOW'], [73, 73, 'SNOW'],
  [75, 75, 'HEAVY SNOW'], [77, 77, 'SNOW GRAINS'], [80, 80, 'SHOWERS'],
  [81, 81, 'HEAVY SHOWERS'], [82, 82, 'VIOLENT SHOWERS'], [85, 86, 'SNOW SHOWERS'],
  [95, 95, 'THUNDERSTORM'], [96, 99, 'THUNDERSTORM + HAIL'],
];
const ROSE = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

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
    vec2 p = vUv * 7.0 + uDrift;
    float n = vnoise(p, 7.0) * 0.62 + vnoise(p * 2.3, 16.0) * 0.26 + vnoise(p * 4.7, 33.0) * 0.12;
    float t = clamp((n - (1.06 - uCover * 1.05)) / 0.22, 0.0, 1.0);
    float edge = smoothstep(1.0, 0.3, length(vUv - 0.5) * 2.0);
    gl_FragColor = vec4(uColor * uLum * (0.5 + 0.6 * t), uCover * t * edge * 0.92);
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
function rainMaterial({ size, color, opacity }) {
  return glowBlending(new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    vertexColors: true,
    uniforms: {
      uSize: { value: size },
      uColor: { value: color.clone() },
      uOpacity: { value: opacity },
      uTilt: { value: new THREE.Vector2() },
    },
    vertexShader: `
      varying vec3 vColor;
      uniform float uSize;
      uniform vec2 uTilt;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float dist = max(0.45, -mv.z);
        gl_PointSize = clamp(uSize * 900.0 / dist, 6.0, 26.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec3 vColor;
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform vec2 uTilt;
      void main() {
        vec2 p = gl_PointCoord - 0.5;
        vec2 q = vec2(
          p.x * uTilt.y - p.y * uTilt.x,
          p.x * uTilt.x + p.y * uTilt.y
        );
        float shaft = smoothstep(0.16, 0.0, abs(q.x));
        float caps = smoothstep(0.6, 0.3, abs(q.y));
        float head = mix(0.5, 1.0, 0.5 - q.y);
        float a = shaft * caps * head * uOpacity;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor * vColor * 1.35, a);
      }`,
  }));
}

const AXIS_Z = new THREE.Vector3(0, 0, 1);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
// Кольцо-всплеск и сетка декали лежат в своей плоскости нормалью по Z, поэтому
// горизонтальный вариант — это поворот Z вверх.
const FLAT_QUAT = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0), -Math.PI / 2);
// Материал сетки-источника декали: она живёт вне сцены и не рисуется никогда,
// нужна только геометрии SimpleDecalGeometry.
const PATCH_MATERIAL = new THREE.MeshBasicMaterial({ visible: false });

// Пятно всплеска: процедурная canvas-текстура — мягкий центр и несколько
// боковых капель, чтобы след не выглядел идеальным кругом. Файлов не
// добавляем, текстура рисуется в рантайме.
function spotTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const blobs = [
    [64, 64, 46, 0.5], [40, 52, 20, 0.3], [88, 74, 24, 0.28],
    [58, 92, 16, 0.22], [84, 40, 14, 0.18],
  ];
  for (const [cx, cy, r, a] of blobs) {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(0.65, `rgba(255,255,255,${a * 0.35})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// Ровная тесселированная копия поверхности — источник декали. Полигон
// плоскости от plane detection это редкая выпуклая оболочка: у большого пола
// все вершины лежат на границе, а SimpleDecalGeometry оставляет только
// треугольники, у которых есть вершина внутри объёма проектора, — на таком
// полигоне это ноль треугольников. Сетка повторяет наклон и границы настоящей
// поверхности, в сцену не добавляется и нужна только геометрии пятна.
function surfacePatch(sizeX, sizeZ, quaternion, x, y, z) {
  const segX = clamp(Math.round(sizeX / DECAL.step), 1, DECAL.segMax);
  const segZ = clamp(Math.round(sizeZ / DECAL.step), 1, DECAL.segMax);
  const geometry = new THREE.PlaneGeometry(sizeX, sizeZ, segX, segZ);
  const mesh = new THREE.Mesh(geometry, PATCH_MATERIAL);
  mesh.position.set(x, y, z);
  mesh.quaternion.copy(quaternion);
  mesh.updateWorldMatrix(true, false);
  // Объём проектора с вписанным радиусом меньше полудиагонали ячейки может не
  // поймать ни одной вершины сетки — пятно мельче этого уже ничего не даст.
  const minScale = 1.5 * Math.hypot(sizeX / segX, sizeZ / segZ);
  return { mesh, geometry, minScale };
}


// Высота плоскости в точке (x, z). (ox, oy, oz) — любая точка поверхности,
// (nx, ny, nz) — её нормаль: у наклонённой столешницы верх бокса это её угол,
// а не плоскость. Скаляры, а не объекты: вызывается на каждую каплю в кадре.
function planeY(ox, oy, oz, nx, ny, nz, x, z) {
  return oy - ((x - ox) * nx + (z - oz) * nz) / Math.max(0.25, ny);
}

// Полосы ливня. Квад растягивается по вектору падения со сносом, а ширина
// строится как перпендикуляр к этому вектору в сторону камеры: полоса всегда
// развёрнута к наблюдателю и не наклоняется вместе с головой (в
// samples/advanced/rain полоса точно так же поворачивается только по азимуту до
// камеры — atan по toCamera в плоскости XZ; их uniform uCameraRotationMatrix в
// шейдере не читается вовсе). Длина = скорость падения × выдержка,
// индивидуальный множитель на каплю приходит атрибутом aLen.
// Аддитив через glowBlending: в passthrough камера тёмная, и светлый росчерк
// читается заметно лучше полупрозрачного «стекла», а в VR сохраняется один
// язык с моросью, нитями ветра и всплесками.
function streakMaterial({ color, opacity }) {
  return glowBlending(new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uColor: { value: color.clone() },
      uOpacity: { value: opacity },
      uDir: { value: new THREE.Vector3(0, -1, 0) },
      uFall: { value: 5 },
      uWidth: { value: STREAK.width },
      uExposure: { value: STREAK.exposure },
    },
    vertexShader: `
      attribute float aLen;
      attribute float aFade;
      uniform vec3 uDir;
      uniform float uFall;
      uniform float uWidth;
      uniform float uExposure;
      varying vec2 vUv;
      varying float vFade;
      void main() {
        vUv = uv;
        vFade = aFade;
        vec4 origin = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vec3 dir = normalize(uDir);
        // cameraPosition — встроенный uniform three, мировая позиция камеры.
        vec3 toCam = cameraPosition - origin.xyz;
        vec3 wide = cross(dir, toCam);
        wide = dot(wide, wide) < 1e-6 ? vec3(1.0, 0.0, 0.0) : normalize(wide);
        float len = uFall * uExposure * aLen;
        vec3 world = origin.xyz + wide * (position.x * uWidth) + dir * (position.y * len);
        // Корень комнаты — единичная матрица, поэтому позиция инстанса уже
        // мировая и view применяется без modelMatrix (как в референсе).
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec2 vUv;
      varying float vFade;
      void main() {
        float side = smoothstep(0.5, 0.15, abs(vUv.x - 0.5));
        float head = smoothstep(0.0, 0.45, vUv.y);
        float tail = smoothstep(1.0, 0.5, vUv.y);
        float a = side * head * tail * uOpacity * vFade;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a);
      }`,
  }));
}

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
    this.cloudTint = C.cloudDay.clone();
    this._cloudTint = new THREE.Color();
    // Объём облака строится после первых кадров: аддон генерирует 128³
    // perlin-текстуру на CPU, и на старте это заметная пауза.
    this.cloudVolume = null;
    this._cloudFrames = 2;
    this.decalTexture = null;
    this.decals = null;
    this._decalCd = 0;
    this._decalPos = new THREE.Vector3();
    this._decalScale = new THREE.Vector3();
    this._decalQuat = new THREE.Quaternion();
    this._roll = new THREE.Quaternion();
    this._fallDir = new THREE.Vector3(0, -1, 0);
    this._depthPos = new THREE.Vector3();
    this._depthView = new THREE.Vector3();
    this._depthNdc = new THREE.Vector3();
    this._depthSurface = new THREE.Vector3();
    this._depthHit = new THREE.Vector3();
    this._ndcPick = new THREE.Vector2();
    this._depthFrame = 0;
    this._depthOn = false;
    this._depthWasOn = false;
    this.listener = null;
    this.rainSound = null;
    this.soundOn = false;
    this.soundReady = false;
    this.soundFailed = false;

    this.drizzle = this.makeLayer('drizzle', C.drizzle, COUNTS.drizzle, 0.028, 0.6);
    this.shower = this.makeStreakLayer(C.shower, COUNTS.shower, 0.7);
    this.snow = this.makeLayer('snow', C.snow, COUNTS.snow, 0.04, 0.8);
    this.mote = this.makeLayer('mote', C.moteCold, COUNTS.mote, 0.01, 0.2);
    this.star = this.makeLayer('star', C.star, COUNTS.star, 0.03, 0.9);
    // не this.layers: так называется THREE.Layers у Object3D, и рендер падает.
    this.strata = [this.drizzle, this.shower, this.snow, this.mote, this.star];
    // Капельные системы: по ним идёт depth-проход, снег и аэрозоль он не трогает.
    this.rainStrata = [this.drizzle, this.shower];
    for (const L of this.rainStrata.concat(this.snow)) {
      for (let i = 0; i < L.count; i++) this.spawnSlot(L, i, true);
      this.setActive(L, 0);
    }
    this.seedMotes();
    this.seedStars();

    this.deckMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
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
      blending: THREE.NormalBlending,
      uniforms: { uColor: { value: C.hazeDay.clone() }, uFog: { value: 0 }, uLum: { value: 1 } },
      vertexShader: HAZE_VERT, fragmentShader: HAZE_FRAG,
    });
    this.hazeMesh = new THREE.Mesh(new THREE.SphereGeometry(5.2, 24, 16), this.hazeMat);
    this.hazeMesh.position.y = 1;
    this.hazeMesh.renderOrder = -5;
    this.add(this.hazeMesh);
    // Поток ветра читается отдельными объёмными нитями, а не только сносом капель.
    this.windRibbons = new THREE.Group();
    for (let ribbon = 0; ribbon < 12; ribbon++) {
      const path = [];
      const y = 0.4 + ribbon % 4 * 0.55;
      const z = -1.5 + Math.floor(ribbon / 4) * 1.5;
      for (let step = 0; step <= 32; step++) {
        const u = step / 32;
        path.push(new THREE.Vector3(
          -3.2 + u * 6.4,
          y + Math.sin(u * Math.PI * 3 + ribbon) * 0.06,
          z + Math.sin(u * Math.PI * 2 + ribbon * 0.7) * 0.16
        ));
      }
      const curve = new THREE.CatmullRomCurve3(path, false, 'centripetal');
      const material = glowBlending(new THREE.MeshBasicMaterial({
        color: ribbon % 3 ? 0x8fdcff : 0xc5a7ff,
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
      }));
      const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 64, 0.004, 5, false), material);
      mesh.userData.phase = ribbon * 0.71;
      this.windRibbons.add(mesh);
    }
    this.add(this.windRibbons);

    // Всплески капель: пул колец, лежащих горизонтально на поверхности.
    this.splashGeo = new THREE.RingGeometry(0.9, 1.0, 32);
    this.splashes = [];
    for (let i = 0; i < SPLASH_POOL; i++) {
      const mesh = new THREE.Mesh(this.splashGeo, shockRingMaterial(0xcfeaff));
      mesh.quaternion.copy(FLAT_QUAT);
      mesh.visible = false;
      this.add(mesh);
      this.splashes.push({ mesh, t: 1e9, dur: 0.5 });
    }

    // Горизонтальные поверхности комнаты (plane detection), пересчёт раз в секунду.
    this.surfaces = [];
    this._surfaceAge = 0;
    this._box = new THREE.Box3();
    this._size = new THREE.Vector3();
    this._center = new THREE.Vector3();
    this._origin = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._normal = new THREE.Vector3();
    this._hitY = 0;

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
        { id: 'sound', label: 'SOUND OFF', onTap: () => this.toggleSound() },
      ],
    });
    this.add(this.hud.card);
    // Дымка, палуба и пол — VR-костюм комнаты. В AR-passthrough это тёмные
    // кляксы поверх камеры: остаются только погодные слои (частицы, всплески,
    // ленты ветра). Объём облака в этот список не идёт: он не костюм комнаты, а
    // погода, и его видимостью управляет update по isPassthrough (см. облако).
    hideInPassthrough([this.hazeMesh, this.deckMesh, this.floor]);
    // В AR слои ярче: свечение поверх камеры нуждается в запасе яркости.
    this._arGain = 1;
    this._arOp = 1;
    const xr = xb.core?.renderer?.xr;
    const syncArGain = () => {
      this._arGain = isPassthrough() ? 1.3 : 1;
      this._arOp = isPassthrough() ? 1.5 : 1;
    };
    xr?.addEventListener('sessionstart', syncArGain);
    xr?.addEventListener('sessionend', syncArGain);
    if (isAutomation()) {
      this.state = {
        temp: 7, rh: 92, cloud: 94, wind: 8.5, gust: 14, wdir: 225,
        press: 994, vis: 5000, rain: 1.2, showers: 3.8, snow: 0,
        code: 95, isDay: 1, precip: 5,
      };
      this.derive();
      this.refreshLook();
      this.hud.setSliderLabel('NOW · DEMO STORM');
    } else {
      this.locate();
    }
  }

  stat(s) { this.hud.setStat(s); }

  // Объём облака из аддонов SDK. Строится не на старте, а через пару кадров:
  // аддон генерирует 128³ perlin-текстуру синхронно на CPU. Материал аддона —
  // GLSL3 RawShaderMaterial с premultiplied-накоплением; blend-режим не
  // трогаем (см. шапку), только depthWrite: объём должен оставаться обычным
  // прозрачным слоем, а не вырезать дыру в звёздах и дымке.
  buildCloudVolume() {
    if (this.cloudVolume) return;
    const cloud = new VolumetricCloud();
    cloud.mesh.scale.set(CLOUD.width, CLOUD.thick, CLOUD.width);
    cloud.mesh.position.set(0, 0, 0);
    cloud.mesh.renderOrder = -2;
    cloud.mesh.material.depthWrite = false;
    cloud.mesh.material.uniforms.steps.value = CLOUD.steps;
    cloud.visible = false;
    this.add(cloud);
    this.cloudVolume = cloud;
  }

  // Звук: слушатель и буфер создаются только после жеста (политика браузера),
  // поэтому до нажатия SOUND контекста и загрузки нет вовсе.
  toggleSound() {
    if (this.soundOn) {
      this.soundOn = false;
      this.hud.setLabel('sound', 'SOUND OFF');
      return;
    }
    this.soundOn = true;
    this.hud.setLabel('sound', this.soundReady ? 'SOUND ON' : 'SOUND …');
    this.ensureAudio();
    this.playRain();
  }

  ensureAudio() {
    if (this.listener) return;
    const camera = xb.core?.camera;
    if (!camera) {
      this.soundOn = false;
      this.soundFailed = true;
      this.hud.setLabel('sound', 'SOUND OFF');
      return;
    }
    this.listener = new THREE.AudioListener();
    camera.add(this.listener);
    this.rainSound = new THREE.Audio(this.listener);
    new THREE.AudioLoader().load(
      RAIN_SOUND_URL,
      (buffer) => {
        this.soundReady = true;
        this.rainSound.setBuffer(buffer);
        this.rainSound.setLoop(true);
        this.rainSound.setVolume(0);
        if (this.soundOn) {
          this.playRain();
          this.hud.setLabel('sound', 'SOUND ON');
        }
      },
      undefined,
      // Офлайн или файл недоступен — просто тишина, без шума в консоли.
      () => {
        this.soundFailed = true;
        this.soundOn = false;
        this.hud.setLabel('sound', 'SOUND OFF');
      }
    );
  }

  playRain() {
    if (!this.soundOn || !this.soundReady || !this.rainSound) return;
    const context = this.listener.context;
    if (context.state === 'suspended') void context.resume();
    if (!this.rainSound.isPlaying) this.rainSound.play();
  }

  // Points-слой: свой буфер позиций, свой per-point цвет (джиттер яркости или 0
  // у припаркованных), свои цели цвета/прозрачности на текущий час. Джиттер
  // лежит ещё и в jit: реальная геометрия гасит каплю через цвет, а вернуть ей
  // исходную яркость можно только из отдельной копии.
  makeLayer(kind, base, count, size, opacity) {
    const pos = new Float32Array(count * 3).fill(BELOW);
    const col = new Float32Array(count * 3);
    const geo = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(pos, 3);
    pa.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', pa);
    const ca = new THREE.BufferAttribute(col, 3);
    geo.setAttribute('color', ca);
    const mat = kind === 'drizzle'
      ? rainMaterial({ size, color: base, opacity })
      : pointsMaterial({ size, opacity });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    this.add(points);
    const layer = {
      kind, count, pos, col, geo, mat, points, active: 0,
      posAttr: pa, colAttr: ca,
      phase: new Float32Array(count).map(() => Math.random() * Math.PI * 2),
      jit: new Float32Array(count),
      prevLen: new Float32Array(count),
      base: base.clone(), baseT: base.clone(), gain: 0, op: opacity, opT: opacity,
    };
    layer.setFade = (i, f) => {
      const ix = i * 3;
      const c = layer.jit[i] * f;
      layer.col[ix] = layer.col[ix + 1] = layer.col[ix + 2] = c;
    };
    layer.markFade = () => { layer.colAttr.needsUpdate = true; };
    layer.flush = () => { layer.posAttr.needsUpdate = true; };
    return layer;
  }

  // Ливень: буфер позиций тот же, что у точек (падающий дождь их не различает),
  // но рисует InstancedMesh квадов, а матрицы инстансов несут только сдвиг —
  // полосу растягивает вершинный шейдер по скорости падения. Гасить каплю за
  // реальной геометрией здесь нужно атрибутом (в InstancedMesh нет per-point
  // цвета), поэтому у полос свой aFade.
  makeStreakLayer(base, count, opacity) {
    const pos = new Float32Array(count * 3).fill(BELOW);
    const len = new Float32Array(count);
    const fade = new Float32Array(count).fill(1);
    for (let i = 0; i < count; i++) len[i] = 0.7 + Math.random() * 0.6;
    const geo = new THREE.PlaneGeometry(1, 1);
    const lenAttr = new THREE.InstancedBufferAttribute(len, 1);
    const fadeAttr = new THREE.InstancedBufferAttribute(fade, 1);
    fadeAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aLen', lenAttr);
    geo.setAttribute('aFade', fadeAttr);
    const mat = streakMaterial({ color: base, opacity });
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, identity);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.count = 0;
    mesh.frustumCulled = false;
    this.add(mesh);
    const layer = {
      kind: 'shower', count, pos, col: null, geo, mat, mesh, active: 0,
      phase: new Float32Array(count).map(() => Math.random() * Math.PI * 2),
      jit: new Float32Array(count).fill(1),
      prevLen: new Float32Array(count),
      base: base.clone(), baseT: base.clone(), gain: 0, op: opacity, opT: opacity,
    };
    layer.setFade = (i, f) => { fade[i] = f; };
    layer.markFade = () => { fadeAttr.needsUpdate = true; };
    // Позиции живут в матрицах инстансов: тот же буфер, что и у точек, просто
    // переписывается в сдвиг перед отправкой на GPU.
    layer.flush = () => {
      const a = mesh.instanceMatrix.array;
      for (let i = 0; i < layer.active; i++) {
        const ix = i * 3, o = i * 16;
        a[o + 12] = pos[ix];
        a[o + 13] = pos[ix + 1];
        a[o + 14] = pos[ix + 2];
      }
      mesh.instanceMatrix.needsUpdate = true;
    };
    return layer;
  }

  spawnSlot(L, i, randomY = false) {
    const ix = i * 3;
    L.prevLen[i] = 0;
    // Новая капля снова видна: гашение за геометрией начинается с чистого листа.
    L.setFade(i, 1);
    L.markFade();
    // Каждая десятая капля рождается прямо на реальной геометрии комнаты, если
    // depth жив — тогда дождь идёт сквозь настоящий объём, а не из купола.
    // Снега и аэрозоля это не касается: у них своя физика.
    const rain = L.kind === 'drizzle' || L.kind === 'shower';
    if (rain && this.depthTie(L, i)) return;
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
        if (c && c[ix] === 0) {
          const g = 0.62 + Math.random() * 0.38;
          L.jit[i] = g;
          c[ix] = c[ix + 1] = c[ix + 2] = g;
        }
      } else if (p[ix + 1] > BELOW + 0.01 || (c && c[ix] !== 0)) {
        if (c) c[ix] = c[ix + 1] = c[ix + 2] = 0;
        p[ix + 1] = BELOW;
      }
    }
    L.active = n;
    if (L.mesh) L.mesh.count = n; // полосы: лишние инстансы просто не рисуются
    if (L.colAttr) L.colAttr.needsUpdate = true;
    if (L.posAttr) L.posAttr.needsUpdate = true;
    if (L.mesh) L.mesh.instanceMatrix.needsUpdate = true;
  }

  seedMotes() {
    const L = this.mote, p = L.pos, c = L.col;
    for (let i = 0; i < L.count; i++) {
      const ix = i * 3;
      p[ix] = (Math.random() * 2 - 1) * ATM.x;
      p[ix + 1] = ATM.yMin + Math.random() * (ATM.yMax - ATM.yMin);
      p[ix + 2] = (Math.random() * 2 - 1) * ATM.z;
      const g = 0.5 + Math.random() * 0.5;
      L.jit[i] = g;
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
      L.jit[i] = g;
      c[ix] = c[ix + 1] = c[ix + 2] = g;
    }
  }

  locate() {
    if (!navigator.geolocation) return this.load(this.lat, this.lon);
    this.stat('LOCATING…');
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
    this.stat(`METEO ${lat.toFixed(2)}, ${lon.toFixed(2)} …`);
    try {
      this.data = await fetchWeather(lat, lon);
      this.stat(`LIVE · OPEN-METEO · ${lat.toFixed(2)}, ${lon.toFixed(2)}`);
    } catch (e) {
      this.data = demoData();
      this.stat(`OFFLINE DEMO (no network): ${e.message}`);
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
    // Mobile controls are available before geolocation/network resolves.
    // Until hourly data exists the displayed loading state is authoritative.
    if (!this.data?.hourly) return;
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
      `${this.offset === 0 ? 'NOW · ' : ''}${when.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} ` +
      `· ${this.offset >= 0 ? '+' : ''}${this.offset}h`);
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
    this.cloudTint.copy(s.isDay ? C.cloudDay : C.cloudNight);
    this.setActive(this.drizzle, Math.round(this.rate.drizzle * COUNTS.drizzle));
    this.setActive(this.shower, Math.round(this.rate.shower * COUNTS.shower));
    this.setActive(this.snow, Math.round(this.rate.snow * COUNTS.snow));
  }

  // Имя текущего состояния: физика осадков важнее кода модели.
  condition() {
    const s = this.state;
    if (s.snow > 0.05 && s.code < 70) return 'SNOW';
    if (s.rain + s.showers > 0.05 && s.code < 50) return 'RAIN';
    return conditionName(s.code);
  }

  // Горизонтальные плоскости комнаты: стол, пол, столешница. Держим только
  // боксы с малой толщиной по Y — вертикальные стены дождь не задерживают.
  // Вместе с боксом сохраняем наклон поверхности и её тесселированный источник
  // для декалей.
  sampleSurfaces() {
    const next = [];
    let planes = [];
    try { planes = xb.world.planes.get(); } catch { /* plane detection выключена */ }
    for (const plane of planes) {
      plane.updateWorldMatrix(true, false);
      this._box.setFromObject(plane);
      this._box.getSize(this._size);
      const flat = Math.min(this._size.x, this._size.z);
      if (this._size.y > Math.max(0.05, flat * 0.35)) continue;
      if (this._box.max.y <= 0.02 || this._box.max.y > ATM.yMax) continue;
      this._box.getCenter(this._center);
      // Поза детектора лежит на самой плоскости (полигон собран в локальной
      // XZ), поэтому она и есть точка поверхности для уравнения высоты.
      plane.getWorldPosition(this._origin);
      // Нормаль поверхности — локальная Y детектора в мировых осях, вверх.
      this._normal.copy(AXIS_Y)
        .applyQuaternion(plane.getWorldQuaternion(this._quat))
        .normalize();
      if (this._normal.y < 0) this._normal.negate();
      // Ось Z проектора декали — по нормали поверхности; сетка и пятно берут
      // один и тот же поворот, поэтому объём проектора ложится по сетке.
      const quaternion = new THREE.Quaternion().setFromUnitVectors(AXIS_Z, this._normal);
      const prev = this.surfaces.find((s) => s.plane === plane);
      const moving = !prev ||
        Math.abs(prev.oy - this._origin.y) > 0.01 ||
        Math.abs(prev.ox - this._origin.x) > 0.01 ||
        Math.abs(prev.oz - this._origin.z) > 0.01 ||
        Math.abs(prev.x1 - prev.x0 - this._size.x) > 0.01 ||
        Math.abs(prev.z1 - prev.z0 - this._size.z) > 0.01;
      const patch = moving
        ? surfacePatch(
          this._size.x, this._size.z, quaternion,
          this._center.x,
          planeY(
            this._origin.x, this._origin.y, this._origin.z,
            this._normal.x, this._normal.y, this._normal.z,
            this._center.x, this._center.z),
          this._center.z)
        : prev.patch;
      next.push({
        plane,
        x0: this._box.min.x, x1: this._box.max.x,
        z0: this._box.min.z, z1: this._box.max.z,
        ox: this._origin.x, oy: this._origin.y, oz: this._origin.z,
        normal: this._normal.clone(), quaternion, patch,
      });
    }
    // Тесселяции исчезнувших поверхностей освобождаем: они жили вне сцены.
    const alive = new Set(next.map((s) => s.patch.geometry));
    for (const s of this.surfaces) if (!alive.has(s.patch.geometry)) s.patch.geometry.dispose();
    this.surfaces = next;
  }

  // Ближайшая сверху горизонтальная поверхность под точкой; её высота остаётся
  // в this._hitY, чтобы падающая капля не считала её дважды за кадр.
  surfaceAt(x, z) {
    let hit = null;
    let top = -Infinity;
    for (const s of this.surfaces) {
      if (x < s.x0 || x > s.x1 || z < s.z0 || z > s.z1) continue;
      const n = s.normal;
      const y = planeY(s.ox, s.oy, s.oz, n.x, n.y, n.z, x, z);
      if (y > top) { top = y; hit = s; }
    }
    this._hitY = top;
    return hit;
  }

  // Пул декалей создаётся при первом попадании: до него ни текстур, ни
  // материалов, ни геометрий в памяти нет.
  ensureDecals() {
    if (this.decals) return;
    this.decalTexture = spotTexture();
    this.decals = [];
    for (let i = 0; i < DECAL.quest; i++) {
      this.decals.push({ mesh: null, material: null, geometry: null, life: 1e9, dur: 1, opacity: 0 });
    }
  }

  // Depth жив: есть данные и сенсор видит комнату. minDepth — поле SDK (в TS
  // приватное), но именно так его читает референс samples/advanced/rain: 8 там
  // означает «данных нет», 0.1 — «сенсор видит что-то в упор».
  depthLive(depth, mesh) {
    if (!depth || !mesh || depth.depthArray?.[0] === undefined) return false;
    if (!depth.depthViewMatrices?.length) return false;
    const min = mesh.minDepth;
    return typeof min === 'number' && min > DEPTH_RAIN.minDepth && min < 8;
  }

  // Рождение капли на реальной геометрии: луч из камеры в случайную точку
  // кадра находит depth-меш. Рейкастер здесь и только здесь — не в колбэках
  // ввода, где свой Raycaster видел бы другой кадр сцены.
  depthTie(L, i) {
    if (Math.random() >= DEPTH_RAIN.tie) return false;
    const depth = xb.core?.depth;
    const mesh = depth?.depthMesh;
    if (!this.depthLive(depth, mesh)) return false;
    this._ndcPick.set(Math.random() * 1.6 - 0.8, Math.random() * 1.6 - 0.8);
    DEPTH_RAYCASTER.setFromCamera(this._ndcPick, xb.core.camera);
    const hits = DEPTH_RAYCASTER.intersectObject(mesh);
    if (!hits.length) return false;
    const point = hits[0].point;
    const ix = i * 3;
    L.pos[ix] = point.x;
    L.pos[ix + 1] = clamp(point.y + 0.02, 0.02, ATM.yMax);
    L.pos[ix + 2] = point.z;
    return true;
  }

  // Depth-осведомлённый дождь. Один проход по обеим капельным системам: капля,
  // ушедшая за реальную геометрию, гаснет, а капля, прошедшая сквозь неё между
  // двумя проверками, садится ровно туда, где стоит поверхность. Проверяется
  // каждая вторая капля и только через кадр: getDepth, проекция и точка
  // поверхности — это работа на каплю, а 15 Гц для окклюзии незаметны.
  updateDepthRain() {
    const depth = xb.core?.depth;
    const mesh = depth?.depthMesh;
    this._depthOn = this.depthLive(depth, mesh);
    if (!this._depthOn) {
      // Depth ушёл — сессия закончилась, сенсор не отдаёт данных. Возвращаем
      // каплям полную видимость один раз: иначе последние погашенные так и
      // висели бы невидимыми до своего перерождения.
      if (this._depthWasOn) {
        this._depthWasOn = false;
        for (const L of this.rainStrata) {
          for (let i = 0; i < L.count; i++) L.setFade(i, 1);
          L.markFade();
        }
      }
      return;
    }
    this._depthWasOn = true;
    const camera = xb.core.camera;
    const parity = this._depthFrame & 1;
    this._depthFrame++;
    for (const L of this.rainStrata) {
      const p = L.pos;
      for (let i = parity; i < L.active; i += DEPTH_RAIN.every) {
        const ix = i * 3;
        this._depthPos.set(p[ix], p[ix + 1], p[ix + 2]);
        // За кадром проверять нечего: FoV depth-сенсора уже кадра, а его данные
        // там нули. Это только экономия — ниже всё равно решается по длине.
        this._depthNdc.copy(this._depthPos).project(camera);
        if (this._depthNdc.z < 0 || this._depthNdc.z > 1 ||
          Math.abs(this._depthNdc.x) > DEPTH_RAIN.fov ||
          Math.abs(this._depthNdc.y) > DEPTH_RAIN.fov) {
          L.setFade(i, 1);
          L.prevLen[i] = 0;
          continue;
        }
        const surface = depth.getProjectedDepthViewPositionFromWorldPosition(
          this._depthPos, this._depthSurface);
        const surfaceLen = surface.length();
        if (!(surfaceLen > 0)) {
          // Данных по этому лучу нет — гасить нечем, капля идёт как обычно.
          L.setFade(i, 1);
          L.prevLen[i] = 0;
          continue;
        }
        const viewLen = this._depthView.copy(this._depthPos)
          .applyMatrix4(depth.depthViewMatrices[0]).length();
        const prevLen = L.prevLen[i];
        if (viewLen <= surfaceLen) {
          // Капля ещё перед геометрией.
          L.prevLen[i] = viewLen;
          L.setFade(i, 1);
          continue;
        }
        if (prevLen > 0 && prevLen <= surfaceLen) {
          // Она была перед поверхностью и оказалась за ней: между кадрами капля
          // прошла сквозь реальную геометрию. Сажаем её в точку поверхности по
          // своему лучу: она уже в системе depth-камеры, а поза меша — это и
          // есть переход в мир (той же матрицей собрана его геометрия).
          mesh.updateWorldMatrix(true, false);
          this._depthHit.copy(surface).applyMatrix4(mesh.matrixWorld);
          this.landOnDepth(this._depthHit.x, this._depthHit.y, this._depthHit.z);
          this.spawnSlot(L, i, false);
          continue;
        }
        // Уже за геометрией: гаснет тем сильнее, чем глубже ушла.
        L.prevLen[i] = 0;
        L.setFade(i, clamp(DEPTH_RAIN.fade - (viewLen - surfaceLen), 0, DEPTH_RAIN.fade));
      }
      L.markFade();
    }
  }

  // Посадка на реальную геометрию: кольцо горизонтальное (нормали у depth нет,
  // а всплеск — короткая вспышка) и пятно, спроецированное прямо на depth-меш:
  // геометрией пятна становятся настоящие треугольники комнаты.
  landOnDepth(x, y, z) {
    this.ring(x, y, z, FLAT_QUAT);
    if (this._decalCd > 0) return;
    const depth = xb.core?.depth;
    const mesh = depth?.depthMesh;
    const source = mesh?.downsampledMesh ?? mesh;
    if (!source?.geometry?.index) return;
    // Мелкая сетка depth-меша обновляется каждый кадр; полную (десятки тысяч
    // вершин) трогаем только если мелкой нет — копия такой геометрии на пятно
    // слишком дорога.
    if (source === mesh) depth.updateFullResolutionDepthMesh();
    this._decalCd = this.decalCooldown();
    this._decalQuat.setFromUnitVectors(AXIS_Z, this._fallDir);
    this._decalPos.set(x, y, z);
    this.spawnDecalAt(source, this._decalPos, this._decalQuat, DECAL.water, 0);
  }

  // Кольцо-всплеск: короткая вспышка попадания. Пул, наклон по поверхности —
  // у реальной геометрии нормали нет, там кольцо лежит горизонтально.
  ring(x, y, z, quaternion) {
    const s = this.splashes.find((c) => c.t >= c.dur) || this.splashes[0];
    s.t = 0;
    s.mesh.visible = true;
    s.mesh.position.set(x, y + 0.005, z);
    s.mesh.quaternion.copy(quaternion);
  }

  // Пятна не чаще, чем раз в 0.12…0.5 с: чем сильнее осадки, тем чаще след.
  decalCooldown() {
    return 0.5 - 0.38 * clamp(
      this.rate.drizzle * 0.5 + this.rate.shower * 0.75 + this.rate.snow * 0.35, 0, 1);
  }

  // Пятно на найденной поверхности комнаты. Кап, рецикл и жизнь общие для
  // плоскостей и реальной геометрии (см. spawnDecalAt).
  spawnDecal(surface, x, y, z, cfg) {
    const patch = surface.patch;
    if (!patch) return;
    this._decalQuat.copy(surface.quaternion).multiply(
      this._roll.setFromAxisAngle(AXIS_Z, Math.random() * Math.PI * 2));
    // Центр объёма проектора — на самой поверхности: над её верхним углом
    // пятно у наклонной столешницы просто не пересекло бы сетку.
    this._decalPos.set(x, y + 0.004, z);
    this.spawnDecalAt(patch.mesh, this._decalPos, this._decalQuat, cfg, patch.minScale);
  }

  // Ядро пятна: любая тесселированная поверхность (сетка плоскости комнаты или
  // depth-меш) + кватерний проектора. Пул с жёстким капом, рецикл старейшего
  // слота, пустая геометрия отбрасывается.
  spawnDecalAt(source, position, orientation, cfg, minScale) {
    if (!source?.geometry?.index || !source.geometry.attributes?.uv) return;
    this.ensureDecals();
    const cap = Math.min(this.decals.length, isPassthrough() ? DECAL.phone : DECAL.quest);
    let slot = null;
    let oldest = -1;
    for (let i = 0; i < cap; i++) {
      const s = this.decals[i];
      if (s.life >= s.dur) { slot = s; break; }
      if (s.life > oldest) { oldest = s.life; slot = s; }
    }
    if (!slot) return;
    const spread = cfg.scale[1] - cfg.scale[0];
    const scale = Math.max(minScale, cfg.scale[0] + Math.random() * spread);
    let geometry = null;
    try {
      geometry = new SimpleDecalGeometry(
        source, position, orientation, this._decalScale.setScalar(scale));
    } catch {
      geometry = null; // у геометрии поверхности нет uv или индекса
    }
    if (!geometry || !geometry.index?.count || !geometry.attributes?.position?.count) {
      geometry?.dispose();
      return;
    }
    if (!slot.material) {
      // Полупрозрачная заливка: аддитив (glowBlending) для пятна на
      // поверхности не годится — он рисует свет, а не след.
      slot.material = new THREE.MeshBasicMaterial({
        map: this.decalTexture,
        color: cfg.color.clone(),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.NormalBlending,
      });
    }
    slot.material.color.copy(cfg.color);
    slot.material.opacity = cfg.opacity;
    slot.geometry = geometry;
    if (!slot.mesh) {
      slot.mesh = new THREE.Mesh(geometry, slot.material);
      this.add(slot.mesh);
    } else {
      slot.mesh.geometry = geometry;
    }
    slot.mesh.position.set(0, 0, 0);
    slot.mesh.visible = true;
    slot.life = 0;
    slot.opacity = cfg.opacity;
    slot.dur = cfg.life[0] + Math.random() * (cfg.life[1] - cfg.life[0]);
  }

  // Всплеск: кольцо — мгновенная презентация попадания, декаль — след на самой
  // поверхности. Декали только на настоящих поверхностях комнаты.
  splash(x, y, z, surface, cfg) {
    // В телефонном AR без найденных поверхностей всплеск рисуется по
    // виртуальному полу y=0 — случайные пятна поверх реального. Только
    // реальные поверхности (planes/depth) дают всплеск в passthrough.
    if (isPassthrough() && !this.surfaces.length) return;
    // Кольцо ложится по наклону поверхности, а не всегда горизонтально.
    this.ring(x, y, z, surface ? surface.quaternion : FLAT_QUAT);
    if (!surface || this._decalCd > 0) return;
    this._decalCd = this.decalCooldown();
    this.spawnDecal(surface, x, y, z, cfg);
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
      const surface = this.surfaceAt(x, z);
      const landing = surface ? this._hitY : 0;
      if (y <= landing) {
        this.splash(x, landing, z, surface, DECAL.water);
        this.spawnSlot(L, i, false);
        continue;
      }
      p[ix] = x; p[ix + 1] = y; p[ix + 2] = z;
    }
    L.flush();
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
      const surface = this.surfaceAt(x, z);
      const landing = surface ? this._hitY : 0;
      if (y <= landing) {
        this.splash(x, landing, z, surface, DECAL.snow);
        this.spawnSlot(L, i, false);
        continue;
      }
      p[ix] = x; p[ix + 1] = y; p[ix + 2] = z;
    }
    L.flush();
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
    this.hud.update();
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
    const drizzleFall = 2.6 + 1.4 * this.rate.drizzle;
    const showerFall = 3.6 + 2.2 * this.rate.shower;
    // Вектор падения ливня со сносом: по нему растянута полоса и по нему же
    // ориентируется пятно на реальной геометрии.
    this._fallDir.set(wx * 0.6, -showerFall, wz * 0.6).normalize();

    this.stepRain(this.drizzle, dt, wx, wz, drizzleFall, 0.7);
    this.stepRain(this.shower, dt, wx, wz, showerFall, 0.6);
    this.stepSnow(this.snow, dt, wx, wz, t);
    this.stepMotes(dt, wx, wz, t);
    // Морось — точки: наклон росчерка в экране следует за сносом ветра.
    {
      const horiz = Math.hypot(wx, wz) || 1e-3;
      const tiltX = clamp(horiz / drizzleFall, 0, 1.2) * Math.sign(wx || 1);
      this.drizzle.mat.uniforms.uTilt.value.set(tiltX, 1).normalize();
    }
    // Ливень — полосы: билборд и длина живут в шейдере, сюда приходит только
    // направление падения, скорость и позиция камеры.
    {
      const u = this.shower.mat.uniforms;
      u.uFall.value = showerFall;
      u.uDir.value.copy(this._fallDir);
    }
    // Реальная геометрия: гасит капли за собой и ловит те, что до неё дошли.
    this.updateDepthRain();

    // Плавная подстройка слоёв к целям текущего часа: часы на слайдере
    // не должны «щёлкать», а цвета — это только uniform-ы, без перезаписи буферов.
    const k = Math.min(1, dt * 2.2);
    const lit = this.lumK * (1 + this.flash * 0.9) * this._arGain;
    for (const L of this.strata) {
      const gainT = L.kind === 'star' ? this.starK : lit;
      L.gain += (gainT - L.gain) * k;
      L.base.lerp(L.baseT, k);
      L.op += (L.opT - L.op) * k;
      L.mat.uniforms.uColor.value.copy(L.base).multiplyScalar(L.gain);
      if (L.mat.uniforms.uOpacity) L.mat.uniforms.uOpacity.value = L.op * this._arOp;
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
    this.hazeMat.uniforms.uLum.value = 0.35 + 0.65 * this.dayK + this.flash * 0.3;

    // Объём облака. Появляется через пару кадров после старта (см.
    // buildCloudVolume). В alpha-blend passthrough он не ставится: см. шапку —
    // чужой RawShaderMaterial с premultiplied-накоплением переключать в
    // alpha-blend-кадре вслепую нельзя, плита DECK остаётся честной заменой.
    if (this._cloudFrames > 0 && --this._cloudFrames === 0) this.buildCloudVolume();
    if (this.cloudVolume) {
      const volume = this.cloudVolume;
      volume.visible = !isPassthrough() && this.cloud > CLOUD.minCover;
      if (volume.visible) {
        volume.position.y = this.deckY;
        volume.update(xb.core.camera);
        const uniforms = volume.mesh.material.uniforms;
        this._cloudTint.copy(this.cloudTint).multiplyScalar(0.45 + 0.75 * this.lumK);
        uniforms.base.value.lerp(this._cloudTint, k);
        uniforms.threshold.value = 0.27 - 0.15 * this.cloud;
        uniforms.opacity.value = (0.12 + 0.38 * this.cloud) * (1 - 0.45 * this.fogK) * (1 + this.flash * 0.4);
      }
    }

    // Пятна: линия жизни, гаснут по общей яркости комнаты. Пока слот занят,
    // его геометрия и материал ждут переиспользования — без аллокаций в кадре.
    if (this._decalCd > 0) this._decalCd -= dt;
    if (this.decals) {
      const decalLit = 0.5 + 0.5 * lit;
      for (const d of this.decals) {
        if (d.life >= d.dur) {
          if (d.mesh?.visible) d.mesh.visible = false;
          continue;
        }
        d.life += dt;
        const f = Math.min(1, d.life / d.dur);
        d.material.opacity = d.opacity * (1 - f) * (1 - f) * decalLit;
      }
    }

    // Громкость дождя — от интенсивности осадков текущего часа слайдера.
    if (this.soundOn && this.rainSound && this.soundReady) {
      const wet = clamp(
        this.rate.drizzle * 0.5 + this.rate.shower * 0.75 + this.rate.snow * 0.35, 0, 1);
      this.rainSound.setVolume(wet < 0.02 ? 0 : 0.12 + 0.5 * wet);
    }
    // Нити ветра дышат силой потока и плывут по его же направлению.
    const windK = clamp(this.state.wind / 10, 0.1, 1.3);
    for (const ribbon of this.windRibbons.children) {
      const phase = ribbon.userData.phase || 0;
      ribbon.material.opacity = (0.05 + 0.1 * windK)
        * (0.55 + 0.45 * Math.sin(t * 0.9 + phase));
      ribbon.position.x = Math.sin(t * 0.5 + phase) * 0.25 * windK;
      ribbon.position.z = Math.cos(t * 0.4 + phase * 0.6) * 0.25 * windK;
    }

    const splashLit = 0.45 + 0.85 * lit;
    for (const sp of this.splashes) {
      sp.mesh.material.uniforms.uColor.value.copy(C.splash).multiplyScalar(splashLit);
      if (sp.t >= sp.dur) { sp.mesh.visible = false; continue; }
      sp.t += dt;
      const f = Math.min(1, sp.t / sp.dur);
      sp.mesh.scale.setScalar(0.012 + f * 0.048);
      sp.mesh.material.uniforms.uT.value = f;
    }

    this._fp += dt;
    if (this._fp > 0.5) {
      this._fp = 0;
      const vis = s.vis >= 1000 ? `${(s.vis / 1000).toFixed(1)} km` : `${Math.round(s.vis)} m`;
      const sound = this.soundOn ? (this.soundReady ? 'on' : 'loading') : this.soundFailed ? 'unavailable' : 'off';
      this.stat(
        `${this.condition()} · ${s.temp.toFixed(1)}°C · wind ${s.wind.toFixed(1)} m/s ${dirName(s.wdir)}, gust ${s.gust.toFixed(1)} · ` +
        `cloud ${Math.round(s.cloud)}% · rh ${Math.round(s.rh)}% · vis ${vis} · ${Math.round(s.press)} hPa · ` +
        `rain ${s.rain.toFixed(2)} · showers ${s.showers.toFixed(2)} · snow ${s.snow.toFixed(2)} cm/h · ` +
        `drops ${this.drizzle.active}/${this.shower.active}/${this.snow.active} · surfaces ${this.surfaces.length} · ` +
        `depth ${this._depthOn ? 'live' : 'off'} · sound ${sound}`
      );
    }
  }

  dispose() {
    for (const L of this.strata) { L.geo.dispose(); L.mat.dispose(); }
    for (const ribbon of this.windRibbons.children) {
      ribbon.geometry.dispose();
      ribbon.material.dispose();
    }
    this.splashGeo.dispose();
    this.deckMesh.geometry.dispose();
    this.deckMat.dispose();
    this.hazeMesh.geometry.dispose();
    this.hazeMat.dispose();
    this.floor.geometry.dispose();
    this.floor.material.dispose();
    for (const s of this.surfaces) s.patch.geometry.dispose();
    this.surfaces.length = 0;
    if (this.decals) {
      for (const d of this.decals) {
        d.geometry?.dispose();
        d.material?.dispose();
        if (d.mesh) this.remove(d.mesh);
      }
      this.decals = null;
    }
    this.decalTexture?.dispose();
    if (this.cloudVolume) {
      const { material, geometry } = this.cloudVolume.mesh;
      material.uniforms.map.value?.dispose();
      material.dispose();
      geometry.dispose();
      this.remove(this.cloudVolume);
      this.cloudVolume = null;
    }
    if (this.rainSound) {
      if (this.rainSound.isPlaying) this.rainSound.stop();
      this.rainSound.disconnect();
      this.rainSound = null;
    }
    if (this.listener) {
      xb.core?.camera?.remove(this.listener);
      this.listener = null;
    }
  }
}

const options = new xb.Options();
options.enableReticles();
options.enablePlaneDetection();
// Depth — второй источник реальных поверхностей: на Quest дождь гаснет за
// реальной геометрией и садится на неё. Там, где сенсора нет (телефон,
// immersive-vr на гарнитуре), requestSession с depth-sensing отклоняется, и
// installXrGuards повторяет запрос без него — опыт остаётся на плоскостях.
options.enableDepth();
options.world?.enableAnchors?.();
options.world.planes.showDebugVisualizations =
  new URLSearchParams(window.location.search).has('debug');
options.xrButton.showEnterSimulatorButton = true;
options.setAppTitle('WEATHER//ROOM');
options.setAppDescription('Погода снаружи — слои частиц внутри. Каждое поле метео видно глазом.');

enableAutomation(options);
installXrGuards();
installLaunchShell(options, [
  'Вход — кнопка внизу: погода встанет вокруг тебя',
  'Слайдер — время −24…+24 ч, LOCATE — погода в твоей точке',
  'SOUND — звук дождя по интенсивности часа, включается жестом',
  'Найденные поверхности ловят капли: кольцо и мокрое пятно',
]);
previewFromEyeHeight();

document.addEventListener('DOMContentLoaded', () => {
  xb.add(new WeatherRoom());
  xb.init(options);
  watchXrButton();
});
