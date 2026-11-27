// Copyright (c) 2026
//
// app.js is the main entry point for the 8th Wall app. It runs before the
// <a-scene> in index.html is parsed, so custom components are registered here.

import './index.css'

import {physicsWorldComponent} from './physics-world'
import {physBodyComponent} from './phys-body'
import {knockdownComponent} from './knockdown'

AFRAME.registerComponent('physics-world', physicsWorldComponent)
AFRAME.registerComponent('phys-body', physBodyComponent)
AFRAME.registerComponent('knockdown', knockdownComponent)
