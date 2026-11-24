// Copyright (c) 2026
//
// app.js is the main entry point for the 8th Wall app. It runs before the
// <a-scene> is created by boot.js, so custom components are registered here
// first, then boot() detects the device capability and assembles the scene
// (8th Wall SLAM for phones, immersive WebXR for Quest 3 / Android WebXR).

import './index.css'

import {seaBattleComponent} from './sea-battle'
import {shipHullComponent} from './ship-hull'
import {seaSurfaceComponent, torpedoComponent, splashFxComponent, explosionFxComponent} from './fx'
import {xrInputComponent} from './xr-input'
import {xrHudComponent} from './xr-hud'
import {boot} from './boot'

AFRAME.registerComponent('sea-battle', seaBattleComponent)
AFRAME.registerComponent('ship-hull', shipHullComponent)
AFRAME.registerComponent('sea-surface', seaSurfaceComponent)
AFRAME.registerComponent('torpedo', torpedoComponent)
AFRAME.registerComponent('splash-fx', splashFxComponent)
AFRAME.registerComponent('explosion-fx', explosionFxComponent)
AFRAME.registerComponent('xr-input', xrInputComponent)
AFRAME.registerComponent('xr-hud', xrHudComponent)

// bundle.js стоит в начале <body>: DOM-панели ниже ещё не распарсены,
// поэтому сборку сцены запускаем по DOMContentLoaded.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => boot())
} else {
  boot()
}
