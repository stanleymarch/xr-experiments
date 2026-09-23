// XR TESTBED — библиотека GLSL-материалов. Общий визуальный язык всех
// пяти опытов: мягкие светящиеся частицы, шоквейв-кольца по поверхностям,
// лучи-импульсы, FBM-облака, дождь, голограммы, спектральные ленты,
// температурные послесвечения и bloom-постобработка.
//
// Всё пишется под three.js r186 (WebGL2), additive-блендинг + depthWrite:false
// для светящихся слоёв; bloom подключается через XREffects XR Blocks
// (стерео-совместимый пайплайн: options.usePostprocessing = true).

import * as THREE from 'three';
import * as xb from 'xrblocks';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

// ---------- Общие GLSL-куски ----------

export const NOISE_GLSL = /* glsl */ `
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash12(i), b = hash12(i + vec2(1.0, 0.0));
    float c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
    for (int i = 0; i < 4; i++) {
      v += a * vnoise(p);
      p = rot * p * 2.03 + vec2(11.7, 5.3);
      a *= 0.5;
    }
    return v;
  }
  float fbm5(vec2 p) {
    float v = 0.0, a = 0.5;
    mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
    for (int i = 0; i < 5; i++) {
      v += a * vnoise(p);
      p = rot * p * 2.11 + vec2(7.3, 9.1);
      a *= 0.5;
    }
    return v;
  }
`;

// 2D curl-noise (дивергентно-свободный поток) для ветра и лент
export const CURL_GLSL = /* glsl */ `
  vec2 curl2(vec2 p, float t) {
    float e = 0.12;
    float n1 = fbm(p + vec2(0.0, e) + t * 0.05);
    float n2 = fbm(p - vec2(0.0, e) + t * 0.05);
    float n3 = fbm(p + vec2(e, 0.0) - t * 0.04);
    float n4 = fbm(p - vec2(e, 0.0) - t * 0.04);
    return vec2(n1 - n2, n4 - n3) / (2.0 * e);
  }
`;

// ---------- 1. Мягкие светящиеся частицы (Points) ----------
// Круглые спрайты с ярким ядром и гало, мерцание, затухание по дистанции.

export function softParticlesMaterial({
  size = 0.02, color = 0x54d6ff, twinkle = 1.0, opacity = 0.9, map = null,
} = {}) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uSize: { value: size },
      uOpacity: { value: opacity },
      uTwinkle: { value: twinkle },
      uTint: { value: new THREE.Color(color) },
      uScale: { value: 300.0 }, // пересчитывается на resize (px-фактор)
      uMap: { value: map },
      uUseMap: { value: map ? 1 : 0 },
    },
    vertexShader: /* glsl */ `
      attribute float aScale;
      attribute float aTwinkle;
      attribute vec3 aColor;
      uniform float uTime, uSize, uTwinkle, uScale;
      varying vec3 vColor;
      varying float vTw;
      void main() {
        vColor = aColor;
        vTw = 0.75 + 0.25 * sin(uTime * (1.5 + aTwinkle * 2.0) + aTwinkle * 40.0) * uTwinkle;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp(uSize * aScale * uScale / max(-mv.z, 0.1), 1.5, 14.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTint;
      uniform float uOpacity, uUseMap;
      uniform sampler2D uMap;
      varying vec3 vColor;
      varying float vTw;
      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        float d = length(uv);
        float core, halo;
        if (uUseMap > 0.5) {
          // спрайт-текстура задаёт форму пятна (см. common/sprites.js)
          float t = texture2D(uMap, gl_PointCoord).a;
          core = pow(t, 1.25);
          halo = pow(t, 0.38) * 0.28;
        } else {
          if (d > 0.5) discard;
          core = pow(smoothstep(0.5, 0.0, d), 2.2);
          halo = smoothstep(0.5, 0.1, d) * 0.35;
        }
        vec3 col = vColor * core + uTint * halo;
        float a = (core + halo) * uOpacity * vTw;
        gl_FragColor = vec4(col * a, a);
      }
    `,
  });
}

/** Атрибуты aScale/aTwinkle/aColor для softParticlesMaterial. */
export function particleAttributes(geometry, { scaleRandom = 0.5, count = null } = {}) {
  const n = count ?? geometry.getAttribute('position').count;
  const scale = new Float32Array(n);
  const tw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    scale[i] = 1 + Math.random() * scaleRandom;
    tw[i] = Math.random();
  }
  geometry.setAttribute('aScale', new THREE.BufferAttribute(scale, 1));
  geometry.setAttribute('aTwinkle', new THREE.BufferAttribute(tw, 1));
  if (!geometry.getAttribute('aColor')) {
    geometry.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  }
  return geometry;
}

// ---------- 2. Шоквейв-кольцо по поверхности ----------
// Единичный диск (CircleGeometry r=1, 48 сегментов) кладётся на поверхность
// (lookAt нормали); анимация — uProgress 0→1: главное кольцо + гармоника.

export function ringShockMaterial({ color = 0x54d6ff, harmonics = 2, width = 0.10 } = {}) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uProgress: { value: 0 },
      uColor: { value: new THREE.Color(color) },
      uHarmonics: { value: harmonics },
      uWidth: { value: width },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uProgress, uHarmonics, uWidth;
      uniform vec3 uColor;
      varying vec2 vUv;
      void main() {
        float d = length(vUv - 0.5) * 2.0;      // 0..1 от центра
        float R = uProgress;
        float band = smoothstep(uWidth, 0.0, abs(d - R));
        float trail = smoothstep(R, max(R - 0.45, 0.0), d) * 0.25;
        float harm = 0.0;
        for (int i = 1; i <= 2; i++) {
          if (float(i) > uHarmonics) break;
          float r2 = R * (1.0 - 0.18 * float(i));
          harm += smoothstep(uWidth * 0.6, 0.0, abs(d - r2)) * (0.3 / float(i));
        }
        float fade = (1.0 - uProgress);
        fade *= fade;
        float a = (band + trail + harm) * fade;
        if (a < 0.003) discard;
        gl_FragColor = vec4(uColor * a * 1.6, a);
      }
    `,
  });
}

// ---------- 3. Луч-импульс ----------
// Цилиндр единичной высоты (основание в эмиттере, масштаб по длине).
// Ярче к точке удара, лёгкое мерцание, мягкие края по радиусу.

export function beamMaterial({ color = 0x54d6ff } = {}) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uLife: { value: 0 }, // 0→1 от выстрела до затухания
      uColor: { value: new THREE.Color(color) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime, uLife;
      uniform vec3 uColor;
      varying vec2 vUv;
      void main() {
        float axial = pow(vUv.y, 1.6);                    // разгон яркости к удару
        float radial = 0.55 + 0.45 * sin(vUv.x * 6.2831); // мягкие края цилиндра
        radial = pow(radial, 2.0);
        float flicker = 0.85 + 0.15 * sin(uTime * 90.0);
        float a = axial * radial * flicker * (1.0 - uLife);
        vec3 col = mix(uColor, vec3(1.0), axial * 0.55);  // горячая головка
        gl_FragColor = vec4(col * a * 1.8, a);
      }
    `,
  });
}

// ---------- 4. Облачный купол (weather-room) ----------
// Перевёрнутая полусфера над комнатой; FBM-тучи плывут, кромка тает к горизонту,
// uTemp смещает колор от штормового синего к тёплому янтарю, uFlash — молния.

export function cloudDomeMaterial({ radius = 4.2 } = {}) {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.NormalBlending,
    uniforms: {
      uTime: { value: 0 },
      uCoverage: { value: 0.55 },
      uTemp: { value: 0.0 },     // −1 холодно … +1 тепло
      uFlash: { value: 0.0 },    // вспышка молнии 0..1
      uWindDir: { value: new THREE.Vector2(1.0, 0.35) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${NOISE_GLSL}
      uniform float uTime, uCoverage, uTemp, uFlash;
      uniform vec2 uWindDir;
      varying vec3 vDir;
      void main() {
        // плоская проекция на купол — тучи «стоят» над головой
        vec2 p = vDir.xz / max(vDir.y, 0.08);
        vec2 drift = uWindDir * uTime * 0.015;
        float n = fbm(p * 1.35 + drift) * 1.15;
        n += 0.3 * fbm(p * 4.2 - drift * 1.7);
        float cl = smoothstep(uCoverage, uCoverage + 0.28, n * 0.9 + vDir.y * 0.25);
        // затухание к горизонту
        float horizon = smoothstep(0.02, 0.35, vDir.y);
        // свет: тёмное брюхо туч + тонкая холодная кромка, молния изнутри
        vec3 storm = vec3(0.035, 0.055, 0.12);
        vec3 warm = vec3(0.22, 0.12, 0.075);
        vec3 base = mix(storm, warm, clamp(uTemp * 0.5 + 0.5, 0.0, 1.0) * 0.42);
        vec3 rim = mix(vec3(0.18, 0.31, 0.48), vec3(0.48, 0.28, 0.13), clamp(uTemp, 0.0, 1.0));
        float rimK = smoothstep(uCoverage + 0.18, uCoverage + 0.02, n);
        vec3 col = mix(base, rim, rimK * 0.24);
        col += uFlash * vec3(0.95, 0.97, 1.0) * (0.35 + 0.65 * smoothstep(uCoverage + 0.3, uCoverage, n));
        float a = cl * horizon * (0.92 + uFlash * 0.3);
        gl_FragColor = vec4(col, a);
      }
    `,
  });
  mat.userData.radius = radius;
  return mat;
}

// ---------- 5. Дождь ----------
// InstancedMesh тонких вертикальных квадов; падение по времени в вершинном
// шейдере, tilt по ветру, альфа по скорости.Splash — ringShockMaterial.

export function rainMaterial({ color = 0xa8d8f0, area = new THREE.Vector2(6, 6), height = 3.2 } = {}) {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 1.0 },
      uWind: { value: new THREE.Vector2(0.35, 0.12) },
      uColor: { value: new THREE.Color(color) },
      uArea: { value: area },
      uHeight: { value: height },
    },
    vertexShader: /* glsl */ `
      uniform float uTime, uHeight, uIntensity;
      uniform vec2 uWind, uArea;
      varying float vFade;
      // instance-атрибуты задаются геометрией (см. makeRainField)
      attribute vec3 aOffset;   // xz — позиция, y — фаза [0..1)
      attribute float aSpeed;   // скорость падения
      attribute float aLen;     // длина штриха
      void main() {
        float fall = fract(aOffset.y + uTime * aSpeed);
        vec3 local = position;
        local.y *= aLen;
        local.xz *= 0.006 + 0.004 * aSpeed;
        // наклон по ветру: смещение пропорционально высоте штриха
        local.xz += uWind * local.y * 0.9;
        vec3 world = vec3(
          aOffset.x + uWind.x * (1.0 - fall) * 0.6,
          (1.0 - fall) * uHeight,
          aOffset.z + uWind.y * (1.0 - fall) * 0.6
        );
        vFade = smoothstep(0.0, 0.12, fall) * smoothstep(1.0, 0.86, fall) * uIntensity;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(world + local, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vFade;
      void main() {
        float a = vFade * 0.55;
        gl_FragColor = vec4(uColor * a, a);
      }
    `,
  });
  return mat;
}

/** Геометрия-заготовка дождя: instanced-квады с aOffset/aSpeed/aLen. */
export function makeRainField(count = 900, area = new THREE.Vector2(6, 6)) {
  const quad = new THREE.PlaneGeometry(1, 1, 1, 4);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.copy(quad);
  quad.dispose();
  const offsets = new Float32Array(count * 3);
  const speeds = new Float32Array(count);
  const lens = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    offsets[i * 3] = (Math.random() * 2 - 1) * area.x * 0.5;
    offsets[i * 3 + 1] = Math.random();
    offsets[i * 3 + 2] = (Math.random() * 2 - 1) * area.y * 0.5;
    speeds[i] = 0.55 + Math.random() * 0.75;
    lens[i] = 0.14 + Math.random() * 0.22;
  }
  geometry.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 3));
  geometry.setAttribute('aSpeed', new THREE.InstancedBufferAttribute(speeds, 1));
  geometry.setAttribute('aLen', new THREE.InstancedBufferAttribute(lens, 1));
  geometry.instanceCount = count;
  return geometry;
}

// ---------- 6. Голограмма (city-orbit) ----------
// Френель-кромка, сканлайны, лёгкий глитч; подсветка выбранного узла.

export function hologramMaterial({ color = 0x54d6ff, rim = 0x8a7bff, opacity = 0.8 } = {}) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uSelected: { value: 0.0 },
      uColor: { value: new THREE.Color(color) },
      uRim: { value: new THREE.Color(rim) },
      uOpacity: { value: opacity },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      varying vec3 vPosW;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vPosW = wp.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vViewDir = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime, uSelected, uOpacity;
      uniform vec3 uColor, uRim;
      varying vec3 vNormalW, vViewDir, vPosW;
      void main() {
        float fres = pow(1.0 - clamp(dot(vNormalW, vViewDir), 0.0, 1.0), 2.4);
        float scan = 0.5 + 0.5 * sin(vPosW.y * 90.0 - uTime * 3.0);
        scan = mix(0.75, 1.0, scan);
        float glitch = 0.92 + 0.08 * sin(uTime * 23.0 + vPosW.y * 40.0);
        vec3 col = uColor * (0.35 + 0.3 * scan) + uRim * fres * 1.5;
        col += uSelected * vec3(1.0, 0.42, 0.36) * (0.6 + fres); // коралл выделения
        float a = (0.3 + fres * 0.9 + uSelected * 0.3) * uOpacity * glitch;
        gl_FragColor = vec4(col * a, a);
      }
    `,
  });
}

// ---------- 7. Спектральная лента (sound-space) ----------
// Полоса из многих сегментов; uBands[] (16) из FFT изгибают её в 3D,
// градиент циан→маджента, бегущие линии потока.

export function ribbonMaterial({ bands = 16 } = {}) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uAmp: { value: 0.35 },
      uBands: { value: new Float32Array(bands) },
      uCount: { value: bands },
    },
    vertexShader: /* glsl */ `
      uniform float uTime, uAmp, uCount;
      uniform float uBands[16];
      varying vec2 vUv;
      void main() {
        vUv = uv;
        float k = uv.x * (uCount - 1.0);
        int i0 = int(floor(k));
        int i1 = min(i0 + 1, int(uCount) - 1);
        float f = fract(k);
        float b0 = uBands[i0];
        float b1 = uBands[i1];
        float band = mix(b0, b1, f);
        vec3 p = position;
        // стоячая волна по длине + вклад спектра
        float wave = sin(uv.x * 18.0 + uTime * 2.2) * 0.06;
        p.z += (band * uAmp + wave) * sin(3.14159 * uv.x);
        p.y += band * uAmp * 0.22 * sin(uv.x * 6.28 + uTime);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv;
      void main() {
        vec3 cyan = vec3(0.33, 0.84, 1.0);
        vec3 magenta = vec3(1.0, 0.29, 0.83);
        vec3 violet = vec3(0.54, 0.48, 1.0);
        vec3 col = mix(cyan, violet, smoothstep(0.0, 0.55, vUv.x));
        col = mix(col, magenta, smoothstep(0.55, 1.0, vUv.x));
        float edge = smoothstep(0.0, 0.18, vUv.y) * smoothstep(1.0, 0.82, vUv.y);
        float flow = 0.75 + 0.25 * sin(vUv.x * 40.0 - uTime * 5.0);
        float a = edge * flow * 0.85;
        gl_FragColor = vec4(col * a * 1.5, a);
      }
    `,
  });
}

// ---------- 8. Послесвечение по возрасту (echo-room) ----------
// Ледяной голубой (сейчас) → фиолетовый → приглушённый коралл (старое).

export function ageGradientMaterial({ maxAge = 4.0 } = {}) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uAge: { value: 0.0 },     // возраст среза в секундах
      uMaxAge: { value: maxAge },
      uAlpha: { value: 0.85 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vViewDir = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uAge, uMaxAge, uAlpha;
      varying vec3 vNormalW, vViewDir;
      void main() {
        float t = clamp(uAge / uMaxAge, 0.0, 1.0);
        vec3 now = vec3(0.62, 0.85, 1.0);   // ice blue
        vec3 mid = vec3(0.58, 0.48, 0.95);  // violet
        vec3 old = vec3(0.94, 0.52, 0.45);  // muted coral
        vec3 col = t < 0.5 ? mix(now, mid, t * 2.0) : mix(mid, old, (t - 0.5) * 2.0);
        float fres = pow(1.0 - clamp(dot(vNormalW, vViewDir), 0.0, 1.0), 1.8);
        float a = (0.25 + fres * 0.75) * uAlpha * (1.0 - t * 0.55);
        gl_FragColor = vec4(col * a * 1.4, a);
      }
    `,
  });
}

// ---------- Ветер-филаменты (weather-room) ----------
// Полоса-лента, гуляющая по curl-noise; белый-циановый поток.

export function windFilamentMaterial({ color = 0xdff4ff } = {}) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(color) },
      uSpeed: { value: 1.0 },
    },
    vertexShader: /* glsl */ `
      ${NOISE_GLSL}
      ${CURL_GLSL}
      uniform float uTime, uSpeed;
      varying vec2 vUv;
      varying float vCurl;
      void main() {
        vUv = uv;
        vec3 p = position;
        vec2 flow = curl2(vec2(uv.x * 2.2, uv.y * 0.8) + vec2(uTime * 0.12 * uSpeed, 0.0), uTime);
        vCurl = length(flow);
        p.y += flow.x * 0.16 * sin(3.14159 * uv.x);
        p.z += flow.y * 0.16 * sin(3.14159 * uv.x);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uTime;
      varying vec2 vUv;
      varying float vCurl;
      void main() {
        float edge = smoothstep(0.0, 0.3, vUv.y) * smoothstep(1.0, 0.7, vUv.y);
        float head = smoothstep(0.0, 0.25, vUv.x) * smoothstep(1.0, 0.75, vUv.x);
        float a = edge * head * (0.35 + 0.5 * clamp(vCurl * 1.4, 0.0, 1.0));
        gl_FragColor = vec4(uColor * a, a);
      }
    `,
  });
}

// ---------- Bloom (пост-обработка XR Blocks) ----------

/**
 * Добавляет UnrealBloomPass в стерео-совместимый пайплайн XREffects.
 * Требует options.usePostprocessing = true (см. shell.baseOptions({bloom:true})).
 * @returns {{pass: UnrealBloomPass, sync(): void} | null}
 */
export function addBloom({ strength = 0.65, radius = 0.45, threshold = 0.72 } = {}) {
  const effects = xb.core?.effects;
  if (!effects) return null;
  const size = xb.core.renderer.getDrawingBufferSize(new THREE.Vector2());
  const pass = new UnrealBloomPass(size.clone(), strength, radius, threshold);
  effects.addPass(pass);
  const last = { w: size.x, h: size.y };
  return {
    pass,
    /** Вызывать в update(): пересинхронизирует размер под канвас. */
    sync() {
      const s = xb.core.renderer.getDrawingBufferSize(new THREE.Vector2());
      if (s.x !== last.w || s.y !== last.h) {
        last.w = s.x; last.h = s.y;
        pass.setSize(s.x, s.y);
      }
    },
  };
}

/** Обновление uTime у массива материалов (удобно в update()). */
export function tickMaterials(time, materials) {
  for (const m of materials) {
    if (m?.uniforms?.uTime) m.uniforms.uTime.value = time;
  }
}
