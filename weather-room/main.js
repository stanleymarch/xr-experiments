// WEATHER//ROOM — погода, взятая из настоящей сводки и разложенная в комнату.
//
// Перед пользователем развёрнут сад-витрина: клумба с бортиком, трава, деревья,
// камни, дальнее поле, гряда холмов и небо — с реально посчитанным положением
// солнца и луны (низкоточная астрономия в weather.js) и с погодой из
// Open-Meteo. Источник всегда назван в интерфейсе:
//   «ПОГОДА РЯДОМ»  — запрос разрешения на геопозицию, затем живая сводка
//                     (кнопка `live`), время/место/восход-закат в статусе;
//   «ПРЕВЬЮ: …»     — явно помеченный демо-набор условий с реальными
//                     локальными часами, чтобы опыт можно было осмотреть
//                     без доступа к геопозиции.
// Никогда не выдаём превью за живые данные: если сводка не пришла, сцена
// остаётся превью или честно помеченной устаревшей.
//
// Осадки, облачность, ветер, влажность земли, снежный покров и сезон —
// производные от сводки; жесты не подменяют данные (тап — только локальный
// порыв ветра, который видно по траве, деревьям и наклону дождя).

import * as THREE from 'three';
import * as xb from 'xrblocks';
import {
  baseOptions, createHud, watchSession, spatialControls,
  anchorRoot, fpsMeter,
} from '../common/shell.js';
import {
  NOISE_GLSL, rainMaterial, makeRainField, ringShockMaterial,
  softParticlesMaterial, particleAttributes,
} from '../common/shaders.js';
import * as W from './weather.js';

const RAD = Math.PI / 180;

const RAIN_LIMIT = 420;
const SNOW_LIMIT = 340;
const GRASS_BLADES = 220;
const PUDDLES = 4;
const BLOOM_POINTS = 40;
const GUST_DUR = 1.2;
const STORE_KEY = 'wr.live.v1';

// Версия опыта: у остальных комнат такой же маркер для внешних проверок.
window.__WR_VER = 2;
document.documentElement.dataset.wrVer = '2';

// Геометрия сцены (метры, y=0 — пол): −Z = юг (сад развёрнут на юг), +X = восток.
const G = {
  plot: { w: 5.0, d: 4.2, top: 0.06, z0: -1.2 },
  field: { w: 30, d: 4.6, z: -7.7 },
  ridge: { w: 26, h: 2.4, y: 0.62, z: -8.3 },
  sky: { w: 90, h: 60, y: 22, z: -9.6 },
  mist: { w: 22, h: 3.0, y: 0.9, z: -6.0 },
  rain: { w: 24, d: 8.6, h: 5.0, z: -5.6 },
};
const WINDS = { x: 1, z: 0 }; // юго-западный по умолчанию, до первой сводки

const SKY_COLORS = {
  dayTop: new THREE.Color(0x2f6fd0),
  dayHor: new THREE.Color(0xcfe4f6),
  nightTop: new THREE.Color(0x03060e),
  nightHor: new THREE.Color(0x0b1428),
  dusk: new THREE.Color(0xff8a4a),
};

/** Палитры сезона: земля клумбы, кончики и низ травы, крона, цветение. */
const SEASON_STYLE = {
  spring: { soil: 0x5e7f4a, tip: 0x8ed166, base: 0x4a7539, canopy: 0x7ecb62, blossom: true },
  summer: { soil: 0x4d7038, tip: 0xa5dc74, base: 0x3f6630, canopy: 0x4a9c42, blossom: false },
  autumn: { soil: 0x8a743a, tip: 0xe0b055, base: 0x6f5a2a, canopy: 0xdb7c2e, blossom: false },
  winter: { soil: 0x8d97a3, tip: 0xb9c3cd, base: 0x77808b, canopy: 0x6d6f74, blossom: false },
};

// ---------- Шейдеры комнаты ----------
// Все материалы — локальные: общий common/shaders.js остаётся нетронутым,
// но его GLSL-шум и «дождь» переиспользуются как есть.

/** Небо: градиент по высоте, сумерки у солнца, FBM-облака, звёзды, солнце и луна. */
function skyMaterial() {
  return new THREE.ShaderMaterial({
    depthWrite: true,
    uniforms: {
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunAlt: { value: 0.5 },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uMoonRight: { value: new THREE.Vector3(1, 0, 0) },
      uMoonPhase: { value: 0.5 },
      uMoonAlt: { value: -1 },
      uCoverage: { value: 0.2 },
      uMood: { value: 0 },
      uFog: { value: 0 },
      uStars: { value: 0 },
      uFlash: { value: 0 },
      uDrift: { value: new THREE.Vector2(0.2, 0.05) },
      uDayTop: { value: SKY_COLORS.dayTop.clone() },
      uDayHor: { value: SKY_COLORS.dayHor.clone() },
      uNightTop: { value: SKY_COLORS.nightTop.clone() },
      uNightHor: { value: SKY_COLORS.nightHor.clone() },
      uDusk: { value: SKY_COLORS.dusk.clone() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vDir = wp.xyz - cameraPosition;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      ${NOISE_GLSL}
      uniform float uTime, uSunAlt, uMoonPhase, uMoonAlt, uCoverage, uMood, uFog, uStars, uFlash;
      uniform vec3 uSunDir, uMoonDir, uMoonRight;
      uniform vec3 uDayTop, uDayHor, uNightTop, uNightHor, uDusk;
      uniform vec2 uDrift;
      varying vec3 vDir;

      float hash31(vec3 p) {
        p = fract(p * 0.3183099 + vec3(0.11, 0.17, 0.13));
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }

      void main() {
        vec3 d = normalize(vDir);
        float up = d.y;
        float dayK = smoothstep(-0.08, 0.20, uSunAlt);       // 0 ночь … 1 день
        float duskK = exp(-pow(abs(uSunAlt) / 0.14, 2.0));   // пик у горизонта
        float hz = smoothstep(-0.02, 0.60, up);
        vec3 col = mix(mix(uNightHor, uNightTop, hz), mix(uDayHor, uDayTop, hz), dayK);

        // закатная подсветка в стороне солнца
        vec2 sunAz = normalize(uSunDir.xz + vec2(1e-5));
        float toSun = max(dot(normalize(d.xz + vec2(1e-5)), sunAz), 0.0);
        col = mix(col, uDusk, duskK * pow(toSun, 2.5) * (1.0 - hz) * 0.85);

        // облака: проекция направления на горизонтальный слой, FBM + дрейф по ветру
        float cover = 1.05 - 0.95 * uCoverage;
        vec2 cp = d.xz / max(abs(up), 0.055);
        vec2 drift = uDrift * uTime * 0.004;
        float n = fbm(cp * 0.55 + drift) * 1.15 + 0.42 * vnoise(cp * 1.9 - drift * 1.8);
        float cl = smoothstep(cover, cover + 0.24, n * 0.92);
        cl *= smoothstep(-0.03, 0.16, up);                  // не рисуем облака ниже горизонта
        vec3 cloudDark = mix(vec3(0.055, 0.075, 0.12), vec3(0.34, 0.36, 0.42), dayK);
        vec3 cloudLit = mix(vec3(0.10, 0.13, 0.19), vec3(0.88, 0.91, 0.95), dayK);
        cloudLit = mix(cloudLit, uDusk * 0.9, duskK * toSun * 0.45);
        vec3 cloudCol = mix(cloudDark, cloudLit, smoothstep(cover, cover + 0.45, n));
        cloudCol *= 1.0 - 0.42 * uMood;
        col = mix(col, cloudCol, cl);
        // плотная облачность глушит небо и за ней
        col = mix(col, vec3(dot(col, vec3(0.30))) * 0.85, uCoverage * 0.35 * (1.0 - cl));

        // звёзды: редкие хэш-клетки, видны только в темноте
        if (uStars > 0.01 && up > 0.02) {
          vec3 sp = floor(d * 240.0);
          float rnd = hash31(sp);
          if (rnd > 0.9955) {
            float dist = length(normalize((sp + 0.5) / 240.0) - d);
            float tw = 0.55 + 0.45 * sin(uTime * (1.5 + rnd * 8.0) + rnd * 40.0);
            float star = smoothstep(0.0022, 0.0, dist) * uStars * tw * smoothstep(0.0, 0.25, up);
            col += vec3(0.85, 0.90, 1.0) * star;
          }
        }

        // солнце: диск ~0.6° и мягкое гало, краснеет у горизонта;
        // плотные облака прячут диск, остаётся только разлитое свечение
        float sunK = mix(1.0, 0.05, uCoverage);
        if (uSunAlt > -0.04) {
          float sd = clamp(dot(d, uSunDir), -1.0, 1.0);
          float ang = acos(sd);
          float core = smoothstep(0.99994, 0.99999, sd) * sunK;
          float halo = exp(-pow(ang / 0.10, 2.0)) * mix(1.0, 0.25, uCoverage);
          vec3 sunCol = mix(vec3(1.0, 0.58, 0.26), vec3(1.0, 0.96, 0.86), smoothstep(0.0, 0.35, uSunAlt));
          col += sunCol * (core * 2.1 + halo * 0.5);
        }

        // луна: диск с настоящей фазой (терминатор — полуэллипс в плоскости диска)
        if (uMoonAlt > -0.03) {
          float md = clamp(dot(d, uMoonDir), -1.0, 1.0);
          float ang = acos(md);
          float rr = 0.0095;
          if (ang < rr * 1.5) {
            vec3 tangent = d - uMoonDir * md;
            float x = dot(tangent, uMoonRight);
            float y = dot(tangent, cross(uMoonDir, uMoonRight));
            float r = length(vec2(x, y));
            float disk = smoothstep(rr, rr * 0.88, r) * mix(1.0, 0.10, uCoverage);
            float term = (1.0 - 2.0 * uMoonPhase) * sqrt(max(0.0, 1.0 - (y / rr) * (y / rr)));
            float lit = smoothstep(term - rr * 0.12, term + rr * 0.12, x);
            float moonK = disk * (0.94 - 0.82 * dayK);
            col = mix(col, vec3(0.90, 0.92, 0.99), moonK * lit);
            col += vec3(0.30, 0.34, 0.46) * moonK * (1.0 - lit) * 0.6;
            col += vec3(0.32, 0.38, 0.55) * exp(-pow(ang / 0.16, 2.0)) * uMoonPhase * (1.0 - dayK) * 0.22 * mix(1.0, 0.3, uCoverage);
          }
        }

        // молния — только в грозу, короткая вспышка внутри неба
        col += uFlash * vec3(0.92, 0.95, 1.0) * (0.22 + 0.5 * cl);

        // туман / дымка: небо молочно светлеет и обесцвечивается
        if (uFog > 0.001) {
          float greyUp = mix(0.55, 0.42, dayK);
          vec3 fogCol = mix(vec3(0.14, 0.16, 0.19), vec3(greyUp, greyUp + 0.01, greyUp + 0.03), dayK);
          col = mix(col, fogCol * (0.9 + 0.35 * (1.0 - hz)), uFog * smoothstep(-0.1, 0.45, up));
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

/** Гряда холмов: два силуэта (дальний светлее), снег кладётся в тот же шейдер. */
function ridgeMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uNear: { value: new THREE.Color(0x2b3a2c) },
      uFar: { value: new THREE.Color(0x4a5a6e) },
      uSnow: { value: 0 },
      uHaze: { value: 0 },
      uFog: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${NOISE_GLSL}
      uniform vec3 uNear, uFar;
      uniform float uSnow, uHaze, uFog;
      varying vec2 vUv;
      void main() {
        float x = vUv.x * 7.0;
        float farLine = 0.50 + 0.26 * fbm(vec2(x * 0.45, 3.1));
        float nearLine = 0.16 + 0.22 * fbm(vec2(x * 0.85 + 5.0, 8.7));
        float farA = smoothstep(farLine + 0.012, farLine - 0.012, vUv.y);
        float nearA = smoothstep(nearLine + 0.012, nearLine - 0.012, vUv.y);
        vec3 far = mix(uFar, vec3(0.90, 0.93, 0.97), uSnow * 0.8);
        vec3 near = mix(uNear, vec3(0.86, 0.90, 0.95), uSnow * 0.85);
        far = mix(far, vec3(0.62, 0.65, 0.70), uHaze * 0.6);
        near = mix(near, vec3(0.55, 0.58, 0.64), uFog * 0.7);
        vec3 col = mix(far, near, nearA);
        float a = max(farA, nearA);
        gl_FragColor = vec4(col, a);
      }
    `,
  });
}

/** Трава: треугольные лезвия одним мешем, качаются в плоскости ветра. */
function grassMaterial() {
  return new THREE.ShaderMaterial({
    transparent: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uSway: { value: 0.08 },
      uGust: { value: 0 },
      uLight: { value: 1 },
      uWind: { value: new THREE.Vector2(1, 0) },
      uTip: { value: new THREE.Color(0x7ec85a) },
      uBase: { value: new THREE.Color(0x3d6231) },
      uSnow: { value: 0 },
    },
    vertexShader: /* glsl */ `
      attribute float aPhase;
      uniform float uTime, uSway, uGust, uSnow;
      uniform vec2 uWind;
      varying float vH;
      void main() {
        vec3 p = position;
        float h = clamp(p.y / 0.26, 0.0, 1.0);
        vH = h;
        float amp = uSway * (0.35 + uGust * 2.6) * h * h;
        p.x += (uWind.x * 0.7 + sin(uTime * 1.8 + aPhase) * 0.3) * amp;
        p.z += (uWind.y * 0.7 + cos(uTime * 1.5 + aPhase) * 0.3) * amp;
        p.y *= 1.0 - 0.25 * uSnow;          // под снегом трава примята
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTip, uBase;
      uniform float uLight, uSnow;
      varying float vH;
      void main() {
        vec3 col = mix(uBase, uTip, vH);
        col = mix(col, vec3(0.88, 0.91, 0.95), uSnow * 0.55);
        gl_FragColor = vec4(col * (0.35 + 0.65 * uLight), 1.0);
      }
    `,
  });
}

/** Снег: точки с падением, сносом по ветру и покачиванием. */
function snowMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uHeight: { value: G.rain.h },
      uSize: { value: 0.022 },
      uPx: { value: 600 },
      uWind: { value: new THREE.Vector2(0, 0) },
    },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      attribute float aSize;
      uniform float uTime, uIntensity, uHeight, uSize, uPx;
      uniform vec2 uWind;
      varying float vFade;
      void main() {
        float speed = 0.20 + aSeed * 0.26;
        float fall = fract(aSeed * 7.3 + uTime * speed * 0.12);
        float drop = 1.0 - fall;
        vec3 wp = vec3(
          position.x + uWind.x * drop * 1.7 + sin(uTime * (0.4 + aSeed * 0.5) + aSeed * 30.0) * 0.18,
          drop * uHeight,
          position.z + uWind.y * drop * 1.7 + cos(uTime * (0.35 + aSeed * 0.45) + aSeed * 20.0) * 0.18
        );
        vec4 mv = modelViewMatrix * vec4(wp, 1.0);
        gl_PointSize = clamp(uSize * aSize * uPx / max(-mv.z, 0.4), 1.0, 11.0);
        vFade = smoothstep(0.0, 0.06, fall) * smoothstep(1.0, 0.9, fall) * uIntensity;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vFade;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.12, d) * vFade * 0.9;
        if (a < 0.01) discard;
        gl_FragColor = vec4(vec3(0.94, 0.97, 1.0) * (0.7 + 0.3 * (1.0 - d * 2.0)), a);
      }
    `,
  });
}

/** Наземный туман: вертикальный слой мягкого шума перед холмами. */
function mistMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uFog: { value: 0 },
      uDay: { value: 1 },
      uLight: { value: new THREE.Color(0xc9d2da) },
      uDark: { value: new THREE.Color(0x8d97a3) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${NOISE_GLSL}
      uniform float uTime, uFog, uDay;
      uniform vec3 uLight, uDark;
      varying vec2 vUv;
      void main() {
        float n = fbm(vec2(vUv.x * 6.0 + uTime * 0.02, vUv.y * 2.0));
        float band = smoothstep(0.0, 0.35, vUv.y) * smoothstep(1.0, 0.55, vUv.y);
        float a = uFog * band * (0.25 + 0.55 * n);
        if (a < 0.004) discard;
        vec3 col = mix(uDark, uLight, clamp(n + uDay * 0.2, 0.0, 1.0));
        gl_FragColor = vec4(col, a);
      }
    `,
  });
}

// ---------- Геометрия травы и снега ----------

function buildGrass({ count, halfW, z0, depth, baseY }) {
  const pos = [];
  const phase = [];
  for (let i = 0; i < count; i++) {
    const x = (Math.random() * 2 - 1) * halfW;
    const z = z0 - Math.random() * depth;
    const h = 0.16 + Math.random() * 0.16;
    const bw = 0.014 + Math.random() * 0.012;
    const lean = (Math.random() * 2 - 1) * 0.05;
    pos.push(
      x - bw, baseY, z,
      x + bw, baseY, z,
      x + lean, baseY + h, z + lean * 0.6,
    );
    const ph = Math.random() * Math.PI * 2;
    phase.push(ph, ph, ph);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phase, 1));
  return geo;
}

function buildSnowField(count, area) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  const size = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() * 2 - 1) * area.x * 0.5;
    pos[i * 3 + 1] = 0;
    pos[i * 3 + 2] = (Math.random() * 2 - 1) * area.y * 0.5;
    seed[i] = Math.random();
    size[i] = 0.6 + Math.random();
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  return geo;
}

// ---------- Опыт ----------

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
    this.root = new THREE.Group();
    this.root.name = 'weather-room-root';
    this.add(this.root);
    this.anchor = anchorRoot();

    // --- состояние ---
    this.reading = null;       // показываемая сводка: live или preview
    this.live = null;          // последняя удачная живая сводка
    this.ctx = null;
    this.error = null;         // текст последней ошибки (сеть/геопозиция)
    this.fetching = false;
    this.gust = 0;             // локальный порыв ветра, затухает
    this.previewIndex = 0;
    this.hourIndex = 0;
    this.lightningT = 4 + Math.random() * 5;
    this._position = null;     // {lat, lon, at} — только после явного запроса

    this._buildLights();
    this._buildGarden();
    this._buildSky();
    this._buildWeatherLayers();
    this._buildUi();

    this.fpsTick = fpsMeter((fps) => { this.fps = fps; });
    this.fps = 0;
    this.holdHeld = false;
    this.fired = 0;
    this._v = new THREE.Vector3();
    this._moonDir = new THREE.Vector3();
    this._moonRight = new THREE.Vector3();
    // Ветер: направление из сводки (куда дует) + локальный порыв от взгляда.
    this.windDir = new THREE.Vector2(WINDS.x, WINDS.z).normalize();
    this.gustDir = new THREE.Vector2(0, -1);
    this._effWind = new THREE.Vector2(0, -1);

    this._onResize = () => this._updatePixelScale();
    window.addEventListener('resize', this._onResize);

    const restored = this._restoreLive();
    this.setReading(restored ?? W.previewReading({ index: this.previewIndex, hour: W.PREVIEW_HOURS[this.hourIndex] }));
    this._updatePixelScale();
    this._labelButtons();
    this.stat();
    window.__weatherRoom = this;
  }

  _buildLights() {
    // Небо сверху / земля снизу — базовая заливка, поверх неё солнце и луна.
    this.hemi = new THREE.HemisphereLight(0x93b6e0, 0x3a4436, 0.9);
    this.add(this.hemi);
    this.sunLight = new THREE.DirectionalLight(0xfff2dc, 1.6);
    this.sunLight.position.set(6, 10, -6);
    this.add(this.sunLight);
    this.moonLight = new THREE.DirectionalLight(0xa8c0ff, 0.0);
    this.moonLight.position.set(-4, 8, -8);
    this.add(this.moonLight);
  }

  _buildGarden() {
    const season = SEASON_STYLE.summer;

    // Клумба: почва + бортик — «оформленный сад», а не плоскость на полкомнаты.
    this.soilMat = new THREE.MeshStandardMaterial({ color: season.soil, roughness: 0.95 });
    const soil = new THREE.Mesh(new THREE.BoxGeometry(G.plot.w, 0.12, G.plot.d), this.soilMat);
    soil.position.set(0, 0, G.plot.z0 - G.plot.d / 2);
    this.root.add(soil);

    this.rimMat = new THREE.MeshStandardMaterial({ color: 0x4a4f57, roughness: 0.85 });
    const rimW = G.plot.w + 0.2;
    const rimD = G.plot.d + 0.2;
    const rimH = 0.16;
    const rimZ = G.plot.z0 - G.plot.d / 2;
    const rimGeos = [
      [rimW, rimH, 0.1, 0, rimH / 2, G.plot.z0 + 0.05],
      [rimW, rimH, 0.1, 0, rimH / 2, G.plot.z0 - G.plot.d - 0.05],
      [0.1, rimH, rimD, -G.plot.w / 2 - 0.05, rimH / 2, rimZ],
      [0.1, rimH, rimD, G.plot.w / 2 + 0.05, rimH / 2, rimZ],
    ];
    this.rimGeos = [];
    for (const [w, h, d, x, y, z] of rimGeos) {
      const geo = new THREE.BoxGeometry(w, h, d);
      const m = new THREE.Mesh(geo, this.rimMat);
      m.position.set(x, y, z);
      this.root.add(m);
      this.rimGeos.push(geo);
    }

    // Дальнее поле до самых холмов — без травы, чтобы не тратить кадры.
    this.fieldMat = new THREE.MeshStandardMaterial({ color: season.soil, roughness: 0.98 });
    const fieldGeo = new THREE.PlaneGeometry(G.field.w, G.field.d);
    const field = new THREE.Mesh(fieldGeo, this.fieldMat);
    field.rotation.x = -Math.PI / 2;
    field.position.set(0, 0, G.field.z);
    this.root.add(field);

    // Трава одной геометрией.
    this.grassMat = grassMaterial();
    this.grassGeo = buildGrass({
      count: GRASS_BLADES, halfW: G.plot.w / 2 - 0.2,
      z0: G.plot.z0 - 0.15, depth: G.plot.d - 0.3, baseY: G.plot.top,
    });
    this.grass = new THREE.Mesh(this.grassGeo, this.grassMat);
    this.root.add(this.grass);

    // Деревья: ствол + ветвь (зимой) + крона + снежная шапка.
    this.trunkMat = new THREE.MeshStandardMaterial({ color: 0x5b4632, roughness: 0.95 });
    this.canopyMat = new THREE.MeshStandardMaterial({ color: season.canopy, roughness: 0.9 });
    this.capMat = new THREE.MeshStandardMaterial({ color: 0xf1f6fa, roughness: 0.8 });
    this.treeGeos = {
      trunk: new THREE.CylinderGeometry(0.05, 0.085, 1, 8),
      branch: new THREE.CylinderGeometry(0.018, 0.03, 0.7, 6),
      canopy: new THREE.IcosahedronGeometry(0.44, 1),
      cap: new THREE.SphereGeometry(0.34, 10, 7),
    };
    this.treeGeos.trunk.translate(0, 0.5, 0);
    this.treeGeos.branch.translate(0, 0.35, 0);

    this.trees = [];
    const spots = [
      [-1.35, G.plot.z0 - 1.3, 1.85, G.plot.top],
      [0.95, G.plot.z0 - 3.05, 2.25, G.plot.top],
      [1.7, -7.1, 2.6, 0],
    ];
    for (const [x, z, h, baseY] of spots) {
      const group = new THREE.Group();
      group.position.set(x, baseY, z);
      const trunk = new THREE.Mesh(this.treeGeos.trunk, this.trunkMat);
      trunk.scale.set(1, h * 0.6, 1);
      const branch = new THREE.Mesh(this.treeGeos.branch, this.trunkMat);
      branch.position.set(0.12, h * 0.5, -0.08);
      branch.rotation.z = -0.7;
      branch.rotation.x = 0.35;
      const canopy = new THREE.Mesh(this.treeGeos.canopy, this.canopyMat);
      canopy.position.y = h * 0.62;
      const cap = new THREE.Mesh(this.treeGeos.cap, this.capMat);
      cap.position.y = h * 0.62 + 0.22 * (h / 2);
      cap.visible = false;
      group.add(trunk, branch, canopy, cap);
      this.root.add(group);
      this.trees.push({ group, trunk, branch, canopy, cap, h });
    }

    // Камни — приметы земли рядом с травой.
    this.rockMat = new THREE.MeshStandardMaterial({ color: 0x6a6f76, roughness: 0.95 });
    this.rockGeo = new THREE.IcosahedronGeometry(0.16, 0);
    this.rocks = [];
    const rockSpots = [[-0.6, -2.1], [1.9, -2.9], [-1.9, -4.6], [0.2, -4.9], [2.2, -7.6]];
    for (const [x, z] of rockSpots) {
      const m = new THREE.Mesh(this.rockGeo, this.rockMat);
      const onPlot = z > G.plot.z0 - G.plot.d;
      m.position.set(x, onPlot ? G.plot.top + 0.05 : 0.05, z);
      m.scale.set(0.7 + Math.random() * 0.6, 0.5 + Math.random() * 0.4, 0.7 + Math.random() * 0.6);
      m.rotation.y = Math.random() * Math.PI;
      this.root.add(m);
      this.rocks.push(m);
    }

    // Снежный покров: две накладки (клумба и поле), прозрачность = глубина снега.
    this.snowMat = new THREE.MeshStandardMaterial({
      color: 0xeef4f9, roughness: 0.85, transparent: true, opacity: 0, depthWrite: false,
    });
    this.snowGeos = [new THREE.PlaneGeometry(G.plot.w, G.plot.d), new THREE.PlaneGeometry(G.field.w, G.field.d)];
    const plotSnow = new THREE.Mesh(this.snowGeos[0], this.snowMat);
    plotSnow.rotation.x = -Math.PI / 2;
    plotSnow.position.set(0, G.plot.top + 0.012, G.plot.z0 - G.plot.d / 2);
    plotSnow.visible = false;
    const fieldSnow = new THREE.Mesh(this.snowGeos[1], this.snowMat);
    fieldSnow.rotation.x = -Math.PI / 2;
    fieldSnow.position.set(0, 0.012, G.field.z);
    fieldSnow.visible = false;
    this.root.add(plotSnow, fieldSnow);
    this.snowMeshes = [plotSnow, fieldSnow];

    // Цветение весной — точки со спрайтом из common/shaders.
    this.blossomMat = softParticlesMaterial({ size: 0.055, color: 0xffc6da, twinkle: 1 });
    const bGeo = new THREE.BufferGeometry();
    const bp = new Float32Array(BLOOM_POINTS * 3);
    for (let i = 0; i < BLOOM_POINTS; i++) {
      const t = this.trees[i % 2];
      const a = Math.random() * Math.PI * 2;
      const r = (0.18 + Math.random() * 0.3) * (t.h / 2.2);
      bp[i * 3] = t.group.position.x + Math.cos(a) * r;
      bp[i * 3 + 1] = t.group.position.y + t.h * 0.62 + (Math.random() - 0.3) * r;
      bp[i * 3 + 2] = t.group.position.z + Math.sin(a) * r;
    }
    bGeo.setAttribute('position', new THREE.BufferAttribute(bp, 3));
    particleAttributes(bGeo, { scaleRandom: 0.8, count: BLOOM_POINTS });
    this.blossoms = new THREE.Points(bGeo, this.blossomMat);
    this.blossoms.visible = false;
    this.root.add(this.blossoms);
    this.blossomGeo = bGeo;

    // Лужи-круги: переиспользуем кольцевой шоквейв из common/shaders.
    this.splashes = [];
    const sgeo = new THREE.CircleGeometry(1, 32);
    for (let i = 0; i < PUDDLES; i++) {
      const m = new THREE.Mesh(sgeo, ringShockMaterial({ color: 0xbfe8ff, harmonics: 1, width: 0.2 }));
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      this.root.add(m);
      this.splashes.push({ mesh: m, t: 1e9 });
    }
    this.splashGeo = sgeo;
    this.splashTimer = 0;

    // Холмы на горизонте.
    this.ridgeMat = ridgeMaterial();
    this.ridgeGeo = new THREE.PlaneGeometry(G.ridge.w, G.ridge.h);
    const ridge = new THREE.Mesh(this.ridgeGeo, this.ridgeMat);
    ridge.position.set(0, G.ridge.y, G.ridge.z);
    this.root.add(ridge);
  }

  _buildSky() {
    this.skyMat = skyMaterial();
    this.skyGeo = new THREE.PlaneGeometry(G.sky.w, G.sky.h);
    const sky = new THREE.Mesh(this.skyGeo, this.skyMat);
    sky.position.set(0, G.sky.y, G.sky.z);
    this.root.add(sky);
  }

  _buildWeatherLayers() {
    // Дождь — общий instanced-материал: только наклон и интенсивность наши.
    this.rainArea = new THREE.Vector2(G.rain.w, G.rain.d);
    this.rainMat = rainMaterial({ color: 0xa8d8f0, area: this.rainArea, height: G.rain.h });
    this.rainGeo = makeRainField(RAIN_LIMIT, this.rainArea);
    this.rain = new THREE.Mesh(this.rainGeo, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.position.set(0, 0, G.rain.z);
    this.rain.visible = false;
    this.root.add(this.rain);

    this.snowMatPoints = snowMaterial();
    this.snowGeo = buildSnowField(SNOW_LIMIT, this.rainArea);
    this.snow = new THREE.Points(this.snowGeo, this.snowMatPoints);
    this.snow.frustumCulled = false;
    this.snow.position.set(0, 0, G.rain.z);
    this.snow.visible = false;
    this.root.add(this.snow);

    this.mistMat = mistMaterial();
    this.mistGeo = new THREE.PlaneGeometry(G.mist.w, G.mist.h);
    this.mist = new THREE.Mesh(this.mistGeo, this.mistMat);
    this.mist.position.set(0, G.mist.y, G.mist.z);
    this.mist.visible = false;
    this.root.add(this.mist);
  }

  _buildUi() {
    this.hud = createHud({
      title: 'WEATHER//ROOM',
      controls: [
        { id: 'live', label: 'ПОГОДА РЯДОМ', onClick: () => this.onLiveClick() },
        { id: 'preview', label: 'ПРЕВЬЮ: ЯСНО', onClick: () => this.cyclePreview() },
        { id: 'hour', label: 'ЧАС: СЕЙЧАС', onClick: () => this.cycleHour() },
      ],
      hint: 'ПОГОДА РЯДОМ — живая сводка Open-Meteo по твоей геопозиции (спросит разрешение) · '
        + 'ПРЕВЬЮ и ЧАС — демонстрационные условия, не факт · тап в сцене — порыв ветра',
    });
    this.spatial = spatialControls({
      title: 'WEATHER//ROOM',
      status: 'ПРЕВЬЮ · загрузка…',
      controls: [
        { id: 'live', label: 'ПОГОДА РЯДОМ', onClick: () => this.onLiveClick() },
        { id: 'preview', label: 'ПРЕВЬЮ', onClick: () => this.cyclePreview() },
        { id: 'hour', label: 'ЧАС', onClick: () => this.cycleHour() },
      ],
      width: 0.8,
    });
    this.spatial.card.position.set(0.86, 1.38, -1.3);
    this.add(this.spatial.card);
  }

  // --- ввод ---

  onSelectStart(event) {
    if (event?.target?.isUI) return;
    this.holdHeld = true;
  }

  onSelectEnd(event) {
    if (event?.target?.isUI) return;
    this.holdHeld = false;
    this.gustFromUser();
  }

  /** Локальный порыв ветра: направление взгляда → локальный сдвиг потока. */
  gustFromUser() {
    xb.core.camera.getWorldDirection(this._v);
    const flat = Math.hypot(this._v.x, this._v.z);
    if (flat > 0.1) this.gustDir.set(this._v.x, this._v.z).normalize();
    this.gust = 1;
    this.fired = (this.fired || 0) + 1;
  }

  // --- источник данных ---

  /**
   * Кнопка живой сводки. Если живая сводка уже есть, а показано превью —
   * сначала просто возвращаем её на экран (без сети и без нового разрешения).
   * Новый запрос к геопозиции делаем только по явному «ОБНОВИТЬ»/«ПОГОДА РЯДОМ».
   */
  onLiveClick() {
    if (this.fetching) return;
    if (this.reading?.source !== 'live' && this.live) {
      this.setReading(this.live);
      return;
    }
    this.requestLive();
  }

  /** Запрос живой сводки: разрешение на геопозицию → Open-Meteo. */
  async requestLive() {
    if (this.fetching) return;
    this.error = null;
    this.fetching = true;
    this._labelButtons();
    this.stat();
    try {
      const pos = await this._getPosition();
      const reading = await this._fetchWeather(pos.lat, pos.lon);
      this.live = reading;
      this._storeLive(reading);
      this.error = null;
      this.setReading(reading);
      console.info('[WR] живая сводка', reading.info.ru, reading.tempC, reading.windMps);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      this.error = msg;
      console.warn('[WR] не удалось получить живую сводку:', msg);
      // Никаких выдуманных «живых» данных: остаёмся на превью или на старой сводке.
      if (this.live) this.setReading(this.live);
      this.stat();
    } finally {
      this.fetching = false;
      this._labelButtons();
      this.stat();
    }
  }

  async _getPosition() {
    const now = performance.now();
    if (this._position && now - this._position.at < W.POSITION_TTL_MS) return this._position;
    if (!navigator.geolocation) {
      throw new Error(W.geolocationErrorText(null));
    }
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, at: performance.now() }),
        (err) => reject(new Error(W.geolocationErrorText(err))),
        { enableHighAccuracy: false, timeout: 12000, maximumAge: 5 * 60 * 1000 },
      );
    });
    this._position = pos;
    return pos;
  }

  async _fetchWeather(lat, lon) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    try {
      const res = await fetch(W.buildOpenMeteoUrl(lat, lon), { signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status} от Open-Meteo`);
      const json = await res.json();
      return W.parseOpenMeteo(json, { lat, lon, fetchedAt: Date.now() });
    } catch (e) {
      if (e?.name === 'AbortError') throw new Error('таймаут запроса к Open-Meteo (9 с)');
      if (e instanceof TypeError) throw new Error(`сеть недоступна: ${e.message}`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  _storeLive(reading) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(reading));
    } catch { /* приватный режим — не критично */ }
  }

  /** Восстанавливает последнюю живую сводку, если она не безнадёжно стара. */
  _restoreLive() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { saved = null; }
    if (!saved || saved.source !== 'live' || !Number.isFinite(saved.code) || !Number.isFinite(saved.fetchedAt)) return null;
    if (Date.now() - saved.fetchedAt > W.MAX_RESTORE_MS) return null;
    saved.info = W.wmoInfo(saved.code);
    this.live = saved;
    this._position = { lat: saved.lat, lon: saved.lon, at: performance.now() - W.POSITION_TTL_MS };
    return saved;
  }

  cyclePreview() {
    this.previewIndex = (this.previewIndex + 1) % W.PREVIEW_CONDITIONS.length;
    this.applyPreview();
  }

  setPreview(index) {
    const n = W.PREVIEW_CONDITIONS.length;
    this.previewIndex = ((index % n) + n) % n;
    this.applyPreview();
  }

  cycleHour() {
    this.hourIndex = (this.hourIndex + 1) % W.PREVIEW_HOURS.length;
    this.applyPreview();
  }

  /** Показать превью-условие: живые данные при этом не стираются и не подменяются. */
  applyPreview() {
    this.setReading(W.previewReading({
      index: this.previewIndex,
      hour: W.PREVIEW_HOURS[this.hourIndex],
      lat: this.live?.lat ?? W.PREVIEW_LAT,
      lon: this.live?.lon ?? W.PREVIEW_LON,
    }));
  }

  /** Единственная точка смены показываемой сводки. */
  setReading(reading) {
    if (reading?.source === 'live') this.live = reading;
    this.reading = reading;
    this._lastContextAt = 0;
    this._refreshContext();
    this._labelButtons();
    this.stat();
  }

  _refreshContext() {
    if (!this.reading) return;
    const nowMs = Date.now();
    // Превью с «реальными» часами должно идти вместе с локальным временем.
    if (this.reading.source === 'preview' && W.PREVIEW_HOURS[this.hourIndex] == null
      && nowMs - (this.reading.fetchedAt ?? 0) > 30000) {
      this.reading = W.previewReading({
        index: this.previewIndex,
        hour: null,
        lat: this.reading.lat,
        lon: this.reading.lon,
      });
    }
    this.ctx = W.contextOf(this.reading, nowMs);
    this.scene = W.sceneParams(this.reading, this.ctx);
    this.applyScene();
  }

  _labelButtons() {
    const setLabel = (ui, id, text) => {
      if (typeof ui?.setLabel === 'function') { ui.setLabel(id, text); return; }
      const el = document.getElementById(`hud-btn-${id}`);
      if (el) el.textContent = text;
    };
    const liveLabel = this.fetching ? 'ЗАПРОС…'
      : this.reading?.source === 'live' ? 'ОБНОВИТЬ'
        : this.live ? 'К ЖИВОЙ СВОДКЕ'
          : this.error ? 'ПОВТОРИТЬ' : 'ПОГОДА РЯДОМ';
    const prevLabel = `ПРЕВЬЮ: ${W.PREVIEW_CONDITIONS[this.previewIndex].ru.toUpperCase()}`;
    const hour = W.PREVIEW_HOURS[this.hourIndex];
    const hourLabel = hour == null ? 'ЧАС: СЕЙЧАС' : `ЧАС: ${String(hour).padStart(2, '0')}:00`;
    for (const ui of [this.hud, this.spatial]) {
      setLabel(ui, 'live', liveLabel);
      setLabel(ui, 'preview', prevLabel);
      setLabel(ui, 'hour', hourLabel);
    }
  }

  // --- применение сводки к сцене ---

  applyScene() {
    const sp = this.scene;
    const ctx = this.ctx;
    if (!sp || !ctx) return;
    const style = SEASON_STYLE[ctx.season.key] ?? SEASON_STYLE.summer;
    const dayK = ctx.dayK;
    const cover = sp.cloud;

    // Свет: день/ночь, ослабление облаками, тёплый сдвиг у горизонта, луна ночью.
    const sunUp = Math.max(0, Math.sin(ctx.sun.altitudeDeg * RAD));
    const duskK = Math.exp(-Math.pow(Math.abs(Math.sin(ctx.sun.altitudeDeg * RAD)) / 0.14, 2));
    const cloudDamp = 1 - 0.80 * cover;
    this.sunLight.intensity = 3.4 * sunUp * cloudDamp + 0.15;
    this.sunLight.color.setHSL(0.09, 0.55 * duskK, 0.62 + 0.3 * (1 - duskK));
    const dir = W.dirFromAltAz(ctx.sun.altitudeDeg, ctx.sun.azimuthDeg);
    this.sunLight.position.set(dir.x * 12, Math.max(dir.y, 0.02) * 12, dir.z * 12);
    const moonUp = Math.max(0, Math.sin(ctx.moon.altitudeDeg * RAD));
    this.moonLight.intensity = 1.3 * moonUp * (1 - dayK) * ctx.moon.phase * (1 - 0.6 * cover);
    const mdir = W.dirFromAltAz(ctx.moon.altitudeDeg, ctx.moon.azimuthDeg);
    this.moonLight.position.set(mdir.x * 12, Math.max(mdir.y, 0.02) * 12, mdir.z * 12);
    // Облака почти не гасят рассеянный свет неба: пасмурный день остаётся светлым.
    this.hemi.intensity = 0.42 + 1.35 * dayK * (1 - 0.18 * cover);
    this.hemi.color.setHex(dayK > 0.5 ? 0x9dbde4 : 0x3d4d6e);
    this.hemi.groundColor.setHex(style.soil);

    // Небо.
    const u = this.skyMat.uniforms;
    u.uSunDir.value.set(dir.x, dir.y, dir.z);
    u.uSunAlt.value = Math.sin(ctx.sun.altitudeDeg * RAD);
    const mvec = this._moonDir.set(mdir.x, mdir.y, mdir.z);
    u.uMoonDir.value.copy(mvec);
    // «Вправо» для терминатора: проекция направления на солнце на плоскость диска.
    const right = this._moonRight.set(dir.x, dir.y, dir.z);
    right.addScaledVector(mvec, -right.dot(mvec));
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0); else right.normalize();
    u.uMoonRight.value.copy(right);
    u.uMoonPhase.value = ctx.moon.phase;
    u.uMoonAlt.value = Math.sin(ctx.moon.altitudeDeg * RAD);
    u.uCoverage.value = cover;
    // «Настроение» погоды: хмарь и тяжесть тучи.
    u.uMood.value = sp.kind === 'thunder' ? 0.9 : sp.kind === 'rain' || sp.kind === 'drizzle' ? 0.55
      : sp.kind === 'overcast' ? 0.45 : sp.kind === 'snow' ? 0.4 : sp.kind === 'fog' ? 0.3 : 0.1;
    u.uFog.value = sp.fog;
    u.uStars.value = Math.max(0, (1 - dayK) * (1 - 0.85 * cover) * (1 - 0.9 * sp.fog));
    // Ветер сводки — основа потока; порыв пользователя добавляется в _update.
    this.windDir.set(sp.windX, sp.windZ);
    if (this.windDir.lengthSq() < 1e-6) this.windDir.set(0, -1);
    u.uDrift.value.set(this.windDir.x * (0.5 + sp.windMps * 0.12), this.windDir.y * (0.5 + sp.windMps * 0.12));

    // Земля, трава, кроны: сезон, влажность, снег.
    const wetK = 1 - 0.28 * sp.wet;
    this.soilMat.color.setHex(style.soil).multiplyScalar(wetK);
    this.soilMat.roughness = 0.95 - 0.45 * sp.wet;
    this.fieldMat.color.setHex(style.soil).multiplyScalar(wetK * 0.86);
    this.fieldMat.roughness = 0.98 - 0.4 * sp.wet;
    this.canopyMat.color.setHex(style.canopy);
    this.canopyMat.color.multiplyScalar(0.9 + 0.1 * dayK);
    const gu = this.grassMat.uniforms;
    gu.uTip.value.setHex(style.tip).multiplyScalar(0.55 + 0.45 * dayK);
    gu.uBase.value.setHex(style.base).multiplyScalar(0.55 + 0.45 * dayK);
    gu.uSnow.value = sp.snowCover;
    gu.uLight.value = 0.25 + 0.75 * dayK * (1 - 0.3 * cover);

    // Снег на земле и шапки на деревьях.
    this.snowMat.opacity = sp.snowCover;
    this.snowMat.color.setHex(dayK > 0.4 ? 0xeef4f9 : 0xb9cbd8);
    for (const m of this.snowMeshes) m.visible = sp.snowCover > 0.02;
    for (const t of this.trees) {
      t.cap.visible = sp.snowCover > 0.3;
      // Зимой листва опадает: остаются ветви, крона скрывается.
      const bare = ctx.season.key === 'winter';
      t.canopy.visible = !bare;
      if (!bare) t.canopy.scale.set(1.35 * (t.h / 2), 1.0 * (t.h / 2), 1.25 * (t.h / 2));
      if (t.cap.visible) t.cap.scale.set(1.3 * (t.h / 2), 0.45 * (t.h / 2), 1.2 * (t.h / 2));
    }
    for (const r of this.rocks) r.material.color.setHex(dayK > 0.4 ? 0x6a6f76 : 0x4b5158);
    this.blossoms.visible = !!style.blossom && sp.snowCover < 0.1;
    this.blossomMat.uniforms.uOpacity.value = 0.35 + 0.5 * dayK;

    // Холмы и туман.
    const ru = this.ridgeMat.uniforms;
    ru.uNear.value.setHex(style.soil).multiplyScalar(0.42 + 0.5 * dayK);
    ru.uFar.value.setHex(0x5a6b80).multiplyScalar(0.45 + 0.55 * dayK);
    ru.uSnow.value = sp.snowCover;
    ru.uHaze.value = 1 - dayK;
    ru.uFog.value = sp.fog;
    this.mist.visible = sp.fog > 0.03;
    this.mistMat.uniforms.uFog.value = sp.fog * 0.55;
    this.mistMat.uniforms.uDay.value = dayK;

    // Осадки.
    this.rainCount = W.particleCount(RAIN_LIMIT, sp.rain);
    this.rainGeo.instanceCount = Math.max(1, this.rainCount);
    this.rain.visible = this.rainCount > 0;
    this.rainMat.uniforms.uIntensity.value = sp.rain;
    this.snowCount = W.particleCount(SNOW_LIMIT, sp.snow);
    this.snowGeo.setDrawRange(0, Math.max(1, this.snowCount));
    this.snow.visible = this.snowCount > 0;
    this.snowMatPoints.uniforms.uIntensity.value = sp.snow;
  }

  _updatePixelScale() {
    const cam = xb.core?.camera;
    const size = xb.core?.renderer?.getDrawingBufferSize(new THREE.Vector2());
    if (!cam || !size) return;
    const px = (size.y / 2) / Math.tan((cam.fov / 2) * RAD);
    this.snowMatPoints.uniforms.uPx.value = px;
    this.blossomMat.uniforms.uScale.value = px;
  }

  // --- статус ---

  stat() {
    if (!this.ctx) return;
    const d = W.describe(this.reading, this.ctx, { error: this.error, fetching: this.fetching });
    this.desc = d;
    this.hud.setStatus(W.hudLine(d));
    const lines = [
      `${d.source} · ${d.condition} ${d.temp}`,
      `${d.place ? `${d.place} · ` : ''}${d.date} ${d.clock}${d.tz ? ` ${d.tz}` : ''} · ${d.phase} · ${d.season}`,
      `ветер ${d.wind} · порывы ${d.gust} · солнце ${d.sunAlt > 0 ? '+' : ''}${d.sunAlt}° · FPS ${this.fps || '—'}`,
    ];
    if (d.sunrise && d.sunset) lines.push(`восход ${d.sunrise} · закат ${d.sunset}`);
    if (d.moonAlt > 0) lines.push(`луна: ${d.moonPhase} · ${d.moonAlt}° над горизонтом`);
    if (d.ageText) lines.push(`данные получены ${d.ageText} назад — нажми ОБНОВИТЬ`);
    if (d.note) lines.push(d.note);
    if (d.error) lines.push(`ошибка: ${d.error}`);
    this.spatial.setStatus(lines.join('\n'));
    document.documentElement.dataset.wrState = JSON.stringify(this.stateSnapshot());
  }

  /** Машиночитаемый снимок состояния — по нему проверяется честность источника. */
  stateSnapshot() {
    const sp = this.scene ?? {};
    const ctx = this.ctx ?? {};
    return {
      fps: this.fps,
      source: this.reading?.source ?? null,
      showingLive: this.reading?.source === 'live',
      stale: !!ctx.stale,
      ageMin: Math.round((ctx.ageMs ?? 0) / 60000),
      hasLive: !!this.live,
      fetching: this.fetching,
      error: this.error,
      errorTag: this.desc?.errorTag ?? null,
      code: this.reading?.code ?? null,
      kind: sp.kind ?? null,
      condition: this.desc?.condition ?? null,
      tempC: this.reading?.tempC ?? null,
      windMps: this.reading?.windMps ?? null,
      windFromDeg: this.reading?.windFromDeg ?? null,
      windTowardDeg: sp.windTowardDeg ?? null,
      sceneWind: this.windDir ? [ +this.windDir.x.toFixed(3), +this.windDir.y.toFixed(3) ] : null,
      effWind: this._effWind ? [ +this._effWind.x.toFixed(3), +this._effWind.y.toFixed(3) ] : null,
      cloudPct: this.reading?.cloudPct ?? null,
      precipMm: sp.precipMm ?? null,
      snowCm: sp.snowCm ?? null,
      coverage: +(sp.cloud ?? 0).toFixed(3),
      rain: +(sp.rain ?? 0).toFixed(3),
      snow: +(sp.snow ?? 0).toFixed(3),
      fog: +(sp.fog ?? 0).toFixed(3),
      snowCover: +(sp.snowCover ?? 0).toFixed(3),
      wet: +(sp.wet ?? 0).toFixed(3),
      sunAlt: +(ctx.sun?.altitudeDeg ?? 0).toFixed(1),
      sunAz: +(ctx.sun?.azimuthDeg ?? 0).toFixed(1),
      moonAlt: +(ctx.moon?.altitudeDeg ?? 0).toFixed(1),
      moonPhase: ctx.moon ? `${ctx.moon.phaseRu} ${Math.round(ctx.moon.phase * 100)}%` : null,
      phase: ctx.phase ?? null,
      season: ctx.season?.key ?? null,
      seasonRu: ctx.season?.ru ?? null,
      hemisphere: ctx.season?.hemisphere ?? null,
      previewIndex: this.previewIndex,
      previewCondition: W.PREVIEW_CONDITIONS[this.previewIndex].ru,
      hourIndex: this.hourIndex,
      hour: W.PREVIEW_HOURS[this.hourIndex],
      place: this.desc?.place ?? null,
      tz: this.reading?.tz ?? null,
      rainDrawn: this.rainCount ?? 0,
      snowDrawn: this.snowCount ?? 0,
      grassDrawn: GRASS_BLADES,
      trees: this.trees?.length ?? 0,
      gust: +this.gust.toFixed(2),
      gustsFired: this.fired ?? 0,
      anchor: this.anchor.capability,
      drawCalls: xb.core?.renderer?.info.render.calls ?? null,
      triangles: xb.core?.renderer?.info.render.triangles ?? null,
    };
  }

  // --- кадр ---

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
    this._handleCommand();

    if (!this.anchor.active && !this.anchor._pending && this.anchor.capability !== 'unsupported') {
      this.anchor.create(this.root);
    }
    this.anchor.follow(this.root);

    const now = performance.now();
    if (!this.ctx || now - (this._lastContextAt || 0) > 500) {
      this._lastContextAt = now;
      this._refreshContext();
    }

    // Удержание «взгляда» локально усиливает поток, данные при этом не меняются.
    if (this.holdHeld) this.gust = Math.min(1, this.gust + dt * 0.8);
    this.gust = Math.max(0, this.gust - dt / GUST_DUR);

    // Молнии только в грозу: короткая вспышка в небе и подсветка.
    let flash = 0;
    if (this.scene?.lightning) {
      this.lightningT -= dt;
      if (this.lightningT <= 0) {
        this.lightningT = 3 + Math.random() * 5;
        flash = 0.75 + Math.random() * 0.25;
      }
    }
    const sky = this.skyMat.uniforms;
    sky.uTime.value += dt;
    sky.uFlash.value = flash > 0 ? flash : Math.max(0, sky.uFlash.value - dt * 2.2);
    if (flash > 0) this.sunLight.intensity = Math.min(4, this.sunLight.intensity + flash * 0.8);

    // Ветер: направление берётся из сводки, локальный порыв добавляет к нему
    // сдвиг по взгляду и скорость. Одно направление на облака, траву, деревья,
    // дождь и снег.
    const sp = this.scene ?? { windMps: 0, gustK: 0 };
    const g = this.gust;
    this._effWind.set(
      this.windDir.x + this.gustDir.x * g * 2.2,
      this.windDir.y + this.gustDir.y * g * 2.2,
    );
    if (this._effWind.lengthSq() < 1e-6) this._effWind.set(0, -1); else this._effWind.normalize();
    const windStrength = Math.min(0.85, 0.10 + sp.windMps * 0.07 + sp.gustK * 0.28 + g * 0.55);
    const wx = this._effWind.x * windStrength;
    const wz = this._effWind.y * windStrength;
    sky.uDrift.value.set(wx * 3.2, wz * 3.2);
    const gu = this.grassMat.uniforms;
    gu.uTime.value += dt;
    gu.uSway.value = 0.05 + Math.min(0.32, sp.windMps * 0.022);
    gu.uGust.value = g;
    gu.uWind.value.set(wx, wz);
    this.rainMat.uniforms.uTime.value += dt;
    this.rainMat.uniforms.uWind.value.set(wx * 0.55, wz * 0.55);
    const su = this.snowMatPoints.uniforms;
    su.uTime.value += dt;
    su.uWind.value.set(wx, wz);
    this.mistMat.uniforms.uTime.value += dt;

    // Кроны и деревья целиком слегка клонятся по ветру.
    const lean = 0.03 + windStrength * 0.06 + g * 0.05;
    for (const t of this.trees) {
      t.group.rotation.z = -this._effWind.x * lean;
      t.group.rotation.x = this._effWind.y * lean;
    }

    // Круги по воде: частота по интенсивности дождя.
    this.splashTimer -= dt;
    if (this.splashTimer <= 0 && this.scene?.rain > 0.2) {
      this.splashTimer = 0.3 / (0.35 + this.scene.rain);
      this.spawnSplash();
    }
    for (const s of this.splashes) {
      if (s.t >= 0.75) { s.mesh.visible = false; continue; }
      s.t += dt;
      const k = Math.min(s.t / 0.75, 1);
      s.mesh.material.uniforms.uProgress.value = k;
      s.mesh.scale.setScalar(0.05 + k * 0.4);
    }

    this._statT = (this._statT || 0) + dt;
    if (this._statT >= 0.5) { this._statT = 0; this.stat(); }
  }

  spawnSplash() {
    const s = this.splashes.find((x) => x.t >= 0.75) || this.splashes[0];
    s.t = 0;
    s.mesh.visible = true;
    s.mesh.position.set(
      (Math.random() * 2 - 1) * (G.plot.w / 2 - 0.4),
      G.plot.top + 0.02,
      G.plot.z0 - 0.4 - Math.random() * (G.plot.d - 0.8),
    );
    s.mesh.scale.setScalar(0.05);
  }

  _handleCommand() {
    const cmd = document.documentElement.dataset.wrCmd;
    if (!cmd) return;
    delete document.documentElement.dataset.wrCmd;
    try {
      if (cmd === 'gust') this.gustFromUser();
      else if (cmd === 'live') this.requestLive();
      else if (cmd === 'preview') this.cyclePreview();
      else if (cmd.startsWith('preview=')) this.setPreview(parseInt(cmd.slice(8), 10) || 0);
      else if (cmd === 'hour') this.cycleHour();
      else if (cmd.startsWith('hour=')) {
        const h = cmd.slice(5);
        const idx = W.PREVIEW_HOURS.findIndex((v) => String(v) === h);
        this.hourIndex = idx >= 0 ? idx : 0;
        this.applyPreview();
      } else if (cmd === 'probe') {
        document.documentElement.dataset.wrFx = JSON.stringify({
          calls: xb.core.renderer.info.render.calls,
          triangles: xb.core.renderer.info.render.triangles,
          rain: this.rainCount ?? 0, snow: this.snowCount ?? 0,
          sky: this.skyMat.uniforms.uStars.value.toFixed(2),
          sunAlt: +(this.ctx?.sun.altitudeDeg ?? 0).toFixed(1),
          cardInScene: !!this.spatial?.card?.parent,
          rootKids: this.root?.children?.length ?? -1,
        });
      } else if (cmd === 'state') {
        document.documentElement.dataset.wrDump = JSON.stringify(this.stateSnapshot());
      }
      delete document.documentElement.dataset.wrCmdErr;
    } catch (e) {
      document.documentElement.dataset.wrCmdErr = (e && e.message) || String(e);
    }
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.anchor.dispose();
    const kill = (o) => {
      if (!o) return;
      if (o.geometry) o.geometry.dispose();
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
      else if (o.material) o.material.dispose();
    };
    for (const r of this.root.children) kill(r);
    for (const g of this.rimGeos) g.dispose();
    for (const g of Object.values(this.treeGeos)) g.dispose();
    this.rainGeo.dispose();
    this.rainMat.dispose();
    this.snowGeo.dispose();
    this.snowMatPoints.dispose();
    this.soilMat.dispose();
    this.rimMat.dispose();
    this.fieldMat.dispose();
    this.canopyMat.dispose();
    this.capMat.dispose();
    this.trunkMat.dispose();
    this.rockGeo.dispose();
    this.rockMat.dispose();
    this.skyGeo.dispose();
    this.skyMat.dispose();
    this.ridgeGeo.dispose();
    this.ridgeMat.dispose();
    this.grassGeo.dispose();
    this.grassMat.dispose();
    this.mistGeo.dispose();
    this.mistMat.dispose();
    this.blossomGeo.dispose();
    this.blossomMat.dispose();
    this.splashGeo.dispose();
    for (const s of this.splashes) s.mesh.material.dispose();
    delete window.__weatherRoom;
  }
}

const options = baseOptions({
  title: 'WEATHER//ROOM',
  description: 'Погода в комнате: сад с реальным солнцем и луной, дождём, снегом и ветром по живой сводке Open-Meteo (кнопка «ПОГОДА РЯДОМ») либо по помеченному превью.',
  depth: false,
  bloom: false,
});
options.enableHands();
options.controllers.visualizeRays = false;

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const script = new WeatherRoom();
    xb.add(script);
    await xb.init(options);
    watchSession();
  } catch (e) {
    document.documentElement.dataset.wrInitErr = (e && e.message) || String(e);
    console.error('[WR] BOOT FAIL', e);
  }
});
