// Copyright (c) 2026
//
// app.js is the main entry point for the 8th Wall app. It runs before the
// <a-scene> in index.html is parsed, so custom components are registered here.

import './index.css'

import {seaBattleComponent} from './sea-battle'
import {shipHullComponent} from './ship-hull'
import {seaSurfaceComponent, torpedoComponent, splashFxComponent, explosionFxComponent} from './fx'

AFRAME.registerComponent('sea-battle', seaBattleComponent)
AFRAME.registerComponent('ship-hull', shipHullComponent)
AFRAME.registerComponent('sea-surface', seaSurfaceComponent)
AFRAME.registerComponent('torpedo', torpedoComponent)
AFRAME.registerComponent('splash-fx', splashFxComponent)
AFRAME.registerComponent('explosion-fx', explosionFxComponent)
