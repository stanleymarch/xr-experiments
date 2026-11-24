// Copyright (c) 2026
//
// app.js is the main entry point for the 8th Wall app. It runs before the
// <a-scene> in index.html is parsed, so custom components are registered here.

import './index.css'

import {portalPlaceComponent} from './portal-place'
import {portalComponent} from './portal'
import {particlesComponent} from './particles'
import {cubesComponent} from './cubes'
import {filterComponent} from './filter'

AFRAME.registerComponent('portal-place', portalPlaceComponent)
AFRAME.registerComponent('portal', portalComponent)
AFRAME.registerComponent('particles', particlesComponent)
AFRAME.registerComponent('cubes', cubesComponent)
AFRAME.registerComponent('reality-filter', filterComponent)
