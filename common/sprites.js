// XR TESTBED — процедурные спрайт-текстуры (canvas, без внешних ассетов).
//
// Зачем: у «галерейного» свечения нужна авторская форма пятна — гамма
// градиента, длина лучей звезды, мягкость кроны всплеска. Процедурная
// генерация даёт полный контроль и ноль сетевых зависимостей.
//
// Использование: THREE.Sprite с SpriteMaterial({map, blending: Additive,
// depthWrite:false}) для одиночных вспышек; либо как uMap в точечных
// шейдерах (семплирование в gl_PointCoord) для тысяч частиц.

import * as THREE from 'three';

const cache = new Map();

function canvasTexture(key, size, draw) {
  if (cache.has(key)) return cache.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  draw(canvas.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  cache.set(key, tex);
  return tex;
}

/** Мягкий светящийся диск: яркое ядро + широкое гало (для частиц/аур). */
export function glowTexture({ size = 128, core = 0.18, gamma = 2.2 } = {}) {
  return canvasTexture(`glow_${size}_${core}_${gamma}`, size, (ctx, s) => {
    const c = s / 2;
    // гало: несколько вложенных радиальных градиентов — плавный хвост
    for (const [stop, alpha] of [[0.5, 0.28], [0.35, 0.2], [0.22, 0.22]]) {
      const g = ctx.createRadialGradient(c, c, 0, c, c, c * stop * 2);
      g.addColorStop(0, `rgba(255,255,255,${alpha})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    }
    // ядро: степенное затухание, рисуем кольцами по гамме
    const steps = 42;
    for (let i = steps; i >= 1; i--) {
      const t = i / steps;
      const r = core * c * t;
      const a = Math.pow(1 - t, gamma);
      ctx.beginPath();
      ctx.arc(c, c, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${a.toFixed(4)})`;
      ctx.fill();
    }
  });
}

/** Звезда-искра: 6 лучей + ядро (tap-импульсы, глинты удара). */
export function starTexture({ size = 128, rays = 6, rayLen = 0.48, core = 0.1 } = {}) {
  return canvasTexture(`star_${size}_${rays}_${rayLen}_${core}`, size, (ctx, s) => {
    const c = s / 2;
    ctx.translate(c, c);
    // лучи: линейные градиенты от центра, тонкие к концам
    for (let i = 0; i < rays; i++) {
      ctx.save();
      ctx.rotate((i / rays) * Math.PI * 2);
      const len = c * rayLen * (i % 2 === 0 ? 1 : 0.62); // чередуем длину
      const g = ctx.createLinearGradient(0, 0, len, 0);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.4, 'rgba(255,255,255,0.35)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, -c * 0.028);
      ctx.lineTo(len, 0);
      ctx.lineTo(0, c * 0.028);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    // ядро
    const g2 = ctx.createRadialGradient(0, 0, 0, 0, 0, c * core * 2.4);
    g2.addColorStop(0, 'rgba(255,255,255,1)');
    g2.addColorStop(0.5, 'rgba(255,255,255,0.55)');
    g2.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g2;
    ctx.beginPath();
    ctx.arc(0, 0, c * core * 2.4, 0, Math.PI * 2);
    ctx.fill();
  });
}

/** Кольцо-крона всплеска: тонкое яркое кольцо + внутренняя дымка. */
export function splashTexture({ size = 128, thickness = 0.06 } = {}) {
  return canvasTexture(`splash_${size}_${thickness}`, size, (ctx, s) => {
    const c = s / 2;
    const g = ctx.createRadialGradient(c, c, c * 0.5, c, c, c);
    g.addColorStop(0, 'rgba(255,255,255,0.12)');
    g.addColorStop(1 - thickness * 2, 'rgba(255,255,255,0.65)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    // доводим кольцо до яркости
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = s * thickness;
    ctx.beginPath();
    ctx.arc(c, c, c * (1 - thickness), 0, Math.PI * 2);
    ctx.stroke();
  });
}

/** Ветровой штрих: горизонтальный smear с головкой (дождь/течения). */
export function streakTexture({ size = 128 } = {}) {
  return canvasTexture(`streak_${size}`, size, (ctx, s) => {
    const g = ctx.createLinearGradient(0, s / 2, s, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.45)');
    g.addColorStop(0.92, 'rgba(255,255,255,0.95)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    // клин: узкий у хвоста, чуть шире у головки
    ctx.beginPath();
    ctx.moveTo(0, s / 2 - s * 0.02);
    ctx.quadraticCurveTo(s * 0.8, s / 2 - s * 0.035, s, s / 2);
    ctx.quadraticCurveTo(s * 0.8, s / 2 + s * 0.035, 0, s / 2 + s * 0.02);
    ctx.closePath();
    ctx.fill();
  });
}

/**
 * Пул спрайт-вспышек: billboards, живущие N секунд с кривой масштаба.
 * @param {THREE.Texture} texture
 * @param {{count?: number, dur?: number, grow?: number, color?: number}} cfg
 * @returns {{group: THREE.Group, spawn(position: THREE.Vector3, scale?: number): void, update(dt: number): void, dispose(): void}}
 */
export function spritePool(texture, { count = 12, dur = 0.5, grow = 2.2, color = 0xffffff } = {}) {
  const group = new THREE.Group();
  const items = [];
  for (let i = 0; i < count; i++) {
    const mat = new THREE.SpriteMaterial({
      map: texture, color, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const spr = new THREE.Sprite(mat);
    spr.visible = false;
    group.add(spr);
    items.push({ spr, t: 1e9, base: 1 });
  }
  return {
    group,
    spawn(position, scale = 1) {
      const it = items.find((x) => x.t >= dur) || items[0];
      it.t = 0;
      it.base = scale;
      it.spr.position.copy(position);
      it.spr.visible = true;
    },
    update(dt) {
      for (const it of items) {
        if (it.t >= dur) { it.spr.visible = false; continue; }
        it.t += dt;
        const k = Math.min(it.t / dur, 1);
        const scale = it.base * (1 + (grow - 1) * k);
        it.spr.scale.set(scale, scale, 1);
        it.spr.material.opacity = Math.pow(1 - k, 1.6);
      }
    },
    dispose() {
      for (const it of items) it.spr.material.dispose();
      texture.dispose?.();
    },
  };
}
