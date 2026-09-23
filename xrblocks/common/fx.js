// fx.js — общий визуальный кит xr-experiments: шейдеры, палитры, спрайты.
// Никаких текстур с диска: всё процедурное, всё в одном месте, ноль запросов.
// Использование: import { ... } from '../common/fx.js'

import * as THREE from 'three';

// Аддитивное свечение, безопасное для premultiplied-alpha канваса телефонного
// AR. Обычный AdditiveBlending копит не только RGB, но и альфу: композитор
// браузера трактует канвас как premultiplied и гасит камеру под «свечением» —
// вместо света получается грязное пятно. Раздельный blend складывает RGB и
// оставляет альфу канваса нулевой: out = glow + camera. В opaque-VR и на
// тёмном превью различий нет (альфа там не участвует).
export function glowBlending(material) {
  material.blending = THREE.CustomBlending;
  material.blendSrc = THREE.SrcAlphaFactor;
  material.blendDst = THREE.OneFactor;
  material.blendSrcAlpha = THREE.ZeroFactor;
  material.blendDstAlpha = THREE.OneFactor;
  return material;
}

// Процедурный мягкий спрайт: радиальный спад + лёгкое четырёхлучье.
// Рисуется один раз на shared-canvas, раздаётся всем опытам.
let _sprite = null;
export function glowSprite() {
  if (_sprite) return _sprite;
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x - S / 2) / (S / 2), dy = (y - S / 2) / (S / 2);
      const r = Math.hypot(dx, dy);
      if (r > 1) continue;
      const core = Math.pow(Math.max(0, 1 - r), 2.2);
      const star = Math.pow(Math.max(0, 1 - r), 9) * (0.5 + 0.5 * Math.cos(Math.atan2(dy, dx) * 4));
      const v = Math.min(1, core + star * 0.9);
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(v * 255);
    }
  }
  g.putImageData(img, 0, 0);
  _sprite = new THREE.CanvasTexture(cv);
  return _sprite;
}

// Палитры по опытам: [глубокий, основной, вспышка].
export const PALETTES = {
  reality: [0x0a2438, 0x54d6ff, 0xe8fbff],
  weather: [0x0e2a3a, 0x7dd8ff, 0xfff2dd],
  city: [0x0a0a1e, 0x35f2ff, 0xffe9a8],
  sound: [0x120a24, 0xb46aff, 0xffffff],
  echo: [0x08231e, 0x4dffa8, 0xf2fff7],
};

// Мягкие аддитивные точки с затуханием по размеру и глубине.
// color: базовый цвет; per-point цвет идёт через атрибут color.
export function pointsMaterial({ size = 0.035, color = 0xffffff, opacity = 0.9 } = {}) {
  return glowBlending(new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      map: { value: glowSprite() },
      uSize: { value: size },
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
    },
    vertexShader: /* glsl */`
      attribute vec3 color;
      varying vec3 vColor;
      varying float vFog;
      uniform float uSize;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float dist = max(0.1, -mv.z);
        gl_PointSize = uSize * 900.0 / dist;
        vFog = exp(-dist * 0.12);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vColor;
      varying float vFog;
      uniform sampler2D map;
      uniform vec3 uColor;
      uniform float uOpacity;
      void main() {
        float a = texture2D(map, gl_PointCoord).a;
        gl_FragColor = vec4(vColor * uColor * vFog, a * uOpacity);
      }`,
  }));
}

// Светящееся кольцо ударной волны: тонкое кольцо с мягкими краями,
// затухание по нормали к взгляду не нужно — аддитив и так плоский.
export function shockRingMaterial(color = 0x9fe8ff) {
  return glowBlending(new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uT: { value: 0 }, // 0..1 жизнь кольца
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        // RingGeometry даёт uv в квадрате [0,1] — центр в (0.5, 0.5).
        vUv = uv - 0.5;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      varying vec2 vUv;
      uniform vec3 uColor;
      uniform float uT;
      void main() {
        float r = length(vUv) * 2.0;
        float band = smoothstep(0.55, 0.85, r) * (1.0 - smoothstep(0.85, 1.0, r));
        float a = band * (1.0 - uT) * (1.0 - uT);
        gl_FragColor = vec4(uColor * (1.0 + (1.0 - uT) * 2.0), a);
      }`,
  }));
}

// Тонкая светящаяся линия (ленты, слои, лучи): цвет + прозрачность.
export function lineMaterial(color = 0x54d6ff, opacity = 0.6) {
  return glowBlending(new THREE.LineBasicMaterial({
    color, transparent: true, opacity,
  }));
}

// Лента звука (SOUND//SPACE): амплитуда уже записана в position.z геометрии,
// поэтому шейдеру не нужны отдельные атрибуты — он красит по высоте рельефа.
// Живая лента пульсирует сканирующей волной, замороженная застывает ровно.
export function ribbonMaterial({ color = 0x54d6ff, opacity = 0.85, live = false } = {}) {
  return glowBlending(new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
      uLive: { value: live ? 1 : 0 },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */`
      varying float vAmp;
      varying vec2 vUv;
      void main() {
        vAmp = clamp(position.z / 0.35, 0.0, 1.6);
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      uniform float uOpacity, uLive, uTime;
      varying float vAmp;
      varying vec2 vUv;
      void main() {
        float hot = smoothstep(0.04, 0.85, vAmp);
        float scan = 0.5 + 0.5 * sin(vUv.x * 62.0 - uTime * 3.2);
        float edge = smoothstep(0.0, 0.1, vUv.x) * smoothstep(1.0, 0.9, vUv.x)
                   * smoothstep(0.0, 0.14, vUv.y) * smoothstep(1.0, 0.86, vUv.y);
        vec3 c = mix(uColor * 0.22, uColor * 1.7 + vec3(0.22), hot);
        float a = uOpacity * (0.12 + 0.88 * hot) * edge;
        a *= mix(1.0, 0.72 + 0.28 * scan, uLive);
        gl_FragColor = vec4(c, a);
      }`,
  }));
}

// Маркер-точки для города/импульсов: сферический импостер не нужен —
// маленькие квады pointsMaterial рисуют дешевле. Это хелпер сетки точек,
// которой можно двигать позиции напрямую.
export function makePoints(count, { size, color, opacity } = {}) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3).fill(1);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = pointsMaterial({ size, color, opacity });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return { points, geo, pos, col };
}

// Мягкая виньетка-купол вокруг сцены: градиент от прозрачного верха
// к тёмному низу, чтобы частицы не висели в пустоте.
export function dome(radius = 6, top = 0x0a1626, bottom = 0x04070d) {
  const geo = new THREE.SphereGeometry(radius, 24, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      uTop: { value: new THREE.Color(top) },
      uBottom: { value: new THREE.Color(bottom) },
    },
    vertexShader: /* glsl */`
      varying float vY;
      void main() {
        vY = normalize(position).y * 0.5 + 0.5;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      varying float vY;
      uniform vec3 uTop;
      uniform vec3 uBottom;
      void main() { gl_FragColor = vec4(mix(uBottom, uTop, vY), 1.0); }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -10;
  return mesh;
}
