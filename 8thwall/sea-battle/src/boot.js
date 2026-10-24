// boot.js — маршрутизация устройств и сборка сцены.
//
// Правила репозитория: детекция по возможностям, не по user-agent.
//   navigator.xr нет вовсе (iPhone/iPad Safari)      -> режим slam:
//     8th Wall XR8 — вынужденная мера, только там, где WebXR не существует.
//   immersive-ar доступен (Quest 3, Android WebXR, IWER) -> режим webxr:
//     чистый A-Frame WebXR на 8frame, без 8th Wall-движка.
//   WebXR есть, immersive-ar нет (десктоп)           -> режим flat:
//     A-Frame-планшет на столе — вахтенная сетка, мышь, опционально VR.
//   ?mode=webxr|slam|flat — принудительно, для отладки и стенда.
//
// A-Frame обслуживает десктоп, VR и Android; 8th Wall — только iOS.

import {loadBest} from './sea-battle'

const XR_TIMEOUT_MS = 1500

// Пол в flat-режиме: тёмный «стол карты» с вахтенной сеткой.
AFRAME.registerComponent('flat-floor', {
  init() {
    this.grid = new THREE.GridHelper(24, 48, 0x3a5f8a, 0x14243a)
    this.grid.material.transparent = true
    this.grid.material.opacity = 0.55
    this.grid.position.y = 0.002
    this.el.setObject3D('flat-grid', this.grid)

    this.disc = new THREE.Mesh(
      new THREE.CircleGeometry(14, 64).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({color: 0x0a1322}))
    this.disc.position.y = -0.004
    this.el.setObject3D('flat-disc', this.disc)
  },
  remove() {
    this.el.removeObject3D('flat-grid')
    this.el.removeObject3D('flat-disc')
    this.grid.geometry.dispose()
    this.grid.material.dispose()
    this.disc.geometry.dispose()
    this.disc.material.dispose()
  },
})

async function detectMode() {
  const xr = navigator.xr && navigator.xr.isSessionSupported ? navigator.xr : null
  if (!xr) return 'slam'
  try {
    const ar = await Promise.race([
      xr.isSessionSupported('immersive-ar'),
      new Promise((resolve) => setTimeout(() => resolve(false), XR_TIMEOUT_MS)),
    ])
    return ar ? 'webxr' : 'flat'
  } catch {
    return 'flat'
  }
}

function modeOverride() {
  const m = new URLSearchParams(location.search).get('mode')
  return m === 'webxr' || m === 'slam' || m === 'flat' ? m : ''
}

function el(tag, attrs) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === '') node.setAttribute(k, '')
    else node.setAttribute(k, v)
  }
  return node
}

function buildScene(mode) {
  const scene = document.createElement('a-scene')

  if (mode === 'slam') {
    scene.setAttribute('renderer', 'colorManagement: true; antialias: true')
    scene.setAttribute('sea-battle', '')
    scene.setAttribute('landing-page', '')
    scene.setAttribute('xrextras-loading', '')
    scene.setAttribute('xrextras-runtime-error', '')
    scene.setAttribute('xrweb', 'scale: absolute; allowedDevices: any;')
  } else {
    // webxr и flat — один чистый A-Frame-мир: local-floor, hit-test по желанию,
    // VR-кнопка остаётся (из flat можно шагнуть в VR-шлем).
    scene.setAttribute('renderer', 'colorManagement: true; antialias: true; alpha: true')
    if (mode === 'webxr') scene.setAttribute('vr-mode-ui', 'enabled: false')
    scene.setAttribute('webxr', 'optionalFeatures: hit-test, local-floor')
    scene.setAttribute('sea-battle', `mode: ${mode}`)
    scene.setAttribute('xr-input', '')
  }

  const camera = el('a-camera', {id: 'camera'})
  if (mode === 'slam') camera.setAttribute('position', '0 1.6 3')
  if (mode === 'flat') camera.setAttribute('position', '0 1.6 0')
  if (mode !== 'slam') {
    // 3D-приборная доска: в webxr она единственный HUD, в flat включается в VR.
    camera.appendChild(el('a-entity', {'xr-hud': '', position: '0 -0.15 -0.48'}))
  }
  scene.appendChild(camera)

  scene.appendChild(el('a-light', {type: 'ambient', intensity: 0.75}))

  const sun = el('a-entity', {
    light: 'type: directional; intensity: 1.0; castShadow: true; shadowMapHeight: 1024; shadowMapWidth: 1024',
    shadow: '',
  })
  if (mode === 'slam') {
    // Свет ходит за камерой SLAM-мира, как в исходной сцене.
    sun.setAttribute('light', 'type: directional; intensity: 1.0; castShadow: true; shadowMapHeight: 1024; shadowMapWidth: 1024; target: #camera')
    sun.setAttribute('xrextras-attach', 'target: camera; offset: 5 9 2')
  } else {
    // В local-floor мире пол — это y = 0: солнце статично над акваторией.
    sun.setAttribute('position', '1.5 6 2')
  }
  scene.appendChild(sun)

  scene.appendChild(el('a-box', {
    id: 'ground',
    scale: '1000 2 1000',
    position: '0 -1 0',
    material: 'shader: shadow; transparent: true; opacity: 0.25',
    shadow: '',
  }))

  if (mode === 'flat') {
    scene.appendChild(el('a-entity', {'flat-floor': ''}))
  }
  if (mode !== 'slam') {
    scene.appendChild(el('a-entity', {'laser-controls': 'hand: right'}))
    scene.appendChild(el('a-entity', {'laser-controls': 'hand: left'}))
  }

  document.body.appendChild(scene)
  return scene
}

function setupGate(scene) {
  const gate = document.getElementById('arGate')
  if (!gate) {
    console.error('arGate: панель-касса не найдена — вход в AR недоступен')
    return
  }
  const btn = document.getElementById('arEnterBtn')
  const err = document.getElementById('arGateError')
  const best = loadBest()
  if (best) {
    const bestEl = document.getElementById('arGateBest')
    bestEl.textContent = `РЕКОРД: ${best.score} · ФЛОТ ${best.wave}`
    bestEl.classList.remove('hidden')
  }

  gate.classList.remove('hidden')

  btn.addEventListener('click', async () => {
    btn.disabled = true
    const game = scene.components['sea-battle']
    if (game) game.beeper.resume()
    try {
      await scene.enterAR()
    } catch (e) {
      console.error('enterAR failed:', e)
      err.textContent = 'Иммерсивный AR не запустился. Открываю камерный режим…'
      err.classList.remove('hidden')
      setTimeout(() => {
        const url = new URL(location.href)
        url.searchParams.set('mode', 'slam')
        location.replace(url.href)
      }, 1400)
      return
    }
    btn.disabled = false
  })

  let inSession = false
  const onEnterImmersive = () => {
    inSession = true
    gate.classList.add('hidden')
    document.body.classList.add('in-ar')
  }
  const onExitImmersive = () => {
    if (!inSession) return
    inSession = false
    gate.classList.remove('hidden')
    document.body.classList.remove('in-ar')
    btn.disabled = false
  }
  // 8frame в AR-сессии ставит состояние ar-mode, но эмитит только
  // 'enter-vr' (без 'enter-ar') — слушаем оба, чтобы касса гарантированно
  // ушла с экрана в любом иммерсивном входе.
  scene.addEventListener('enter-ar', onEnterImmersive)
  scene.addEventListener('enter-vr', onEnterImmersive)
  scene.addEventListener('exit-ar', onExitImmersive)
  scene.addEventListener('exit-vr', onExitImmersive)
}

export async function boot() {
  const override = modeOverride()
  const mode = override || await detectMode()
  document.body.dataset.mode = mode

  const scene = buildScene(mode)
  if (mode === 'webxr') setupGate(scene)
}
