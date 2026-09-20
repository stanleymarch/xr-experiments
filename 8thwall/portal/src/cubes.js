// cubes.js — the portal emits cubes that fly at the player.
//   green  → tap to catch (+1 score)
//   red    → dodge; if it reaches you (or you tap it) you lose a life.
//
// Cubes are scene children so their world positions are tracked directly.
// Targets are fixed at spawn time, so physically moving the phone dodges red
// cubes (SLAM tracks your motion).

import {PORTAL} from './portal'

const GREEN = '#3dff88'
const RED = '#ff3b4d'

export const cubesComponent = {
  schema: {
    interval: {default: 1300},   // ms between spawns
    speedMin: {default: 5},      // units/sec
    speedMax: {default: 8},
    hitDist: {default: 2.2},     // red cube reaches this → hit
    missDist: {default: 1.2},    // green cube reaches this untapped → missed
    maxAge: {default: 6000},     // ms before a cube despawns
  },

  init() {
    this.items = []
    this.timer = 0
    this.score = 0
    this.lives = 3
    this.active = false

    this.scoreEl = document.getElementById('scoreLabel')
    this.livesEl = document.getElementById('livesLabel')
    this.gameOverEl = document.getElementById('gameOver')
    this.dbgEl = document.getElementById('dbgLine')

    // The portal entity is only ever created by a floor tap, so that moment is
    // exactly when the round begins. (A-Frame defers component init until after
    // the tap's event dispatch, so relying on a `portal-opened` event here would
    // miss it.)
    this.start()
  },

  start() {
    this.items.forEach((c) => c.el.parentNode && c.el.parentNode.removeChild(c.el))
    this.items = []
    this.score = 0
    this.lives = 3
    this.timer = 0
    this.active = true
    this.gameOverEl.classList.add('hidden')
    this.updateHud()
  },

  reset() {
    this.start()
  },

  isOver() {
    return this.lives <= 0
  },

  camWorld(out) {
    const cam = document.getElementById('camera')
    cam.object3D.updateMatrixWorld(true)
    return cam.object3D.getWorldPosition(out)
  },

  doorwayWorld(out) {
    this.el.object3D.updateMatrixWorld(true)
    out.set(0, PORTAL.doorY + PORTAL.doorH / 2, 0.6)
    return out.applyMatrix4(this.el.object3D.matrixWorld)
  },

  spawnCube() {
    const el = document.createElement('a-entity')
    el.classList.add('cantap', 'cube')

    const type = Math.random() < 0.55 ? 'green' : 'red'
    el.setAttribute('geometry', {primitive: 'box'})
    el.setAttribute('material', {shader: 'flat', color: type === 'green' ? GREEN : RED})
    el.setAttribute('scale', '1.4 1.4 1.4')

    const pos = this.doorwayWorld(new THREE.Vector3())
    el.object3D.position.copy(pos)

    // Target near the camera, with a random spread so some pass wide (dodgeable).
    const cam = this.camWorld(new THREE.Vector3())
    const offset = new THREE.Vector3(
      Math.random() - 0.5,
      Math.random() - 0.5,
      Math.random() - 0.5,
    ).normalize().multiplyScalar(1 + Math.random() * 2.5)
    const target = cam.clone().add(offset)

    el.addEventListener('click', (event) => this.onCatch(event, type))
    this.el.sceneEl.appendChild(el)

    this.items.push({
      el,
      type,
      pos,
      target,
      speed: this.data.speedMin + Math.random() * (this.data.speedMax - this.data.speedMin),
      born: performance.now(),
    })
  },

  onCatch(event, type) {
    if (!this.active) return
    const item = this.items.find((c) => c.el === event.target)
    if (!item) return

    if (type === 'green') {
      this.score += 1
      this.el.sceneEl.emit('cube-caught')
    } else {
      this.loseLife()
    }
    this.removeItem(item)
    this.updateHud()
  },

  removeItem(item) {
    item.el.parentNode && item.el.parentNode.removeChild(item.el)
    const idx = this.items.indexOf(item)
    if (idx !== -1) this.items.splice(idx, 1)
  },

  loseLife() {
    this.lives = Math.max(0, this.lives - 1)
    this.el.sceneEl.emit('cube-hit')
    if (this.lives === 0) {
      this.active = false
      this.gameOverEl.classList.remove('hidden')
    }
  },

  updateHud() {
    this.scoreEl.textContent = `Score: ${this.score}`
    this.livesEl.textContent = '\u2665 '.repeat(this.lives).trim() || '—'
    if (this.lives <= 0) {
      this.gameOverEl.textContent = `Game Over \u2014 Score ${this.score}`
    }
  },

  tick(_time, timeDelta) {
    if (!this.active) return

    if (this.dbgEl) {
      this.dbgEl.textContent = `cubes=${this.items.length} t=${Math.round(this.timer)}ms lives=${this.lives} score=${this.score}`
    }

    const dt = timeDelta / 1000
    this.timer += timeDelta
    if (this.timer >= this.data.interval) {
      this.timer -= this.data.interval
      this.spawnCube()
    }

    const now = performance.now()
    const cam = this.camWorld(new THREE.Vector3())

    const tmp = new THREE.Vector3()
    for (let i = this.items.length - 1; i >= 0; i--) {
      const c = this.items[i]

      // Move toward its fixed target.
      tmp.subVectors(c.target, c.pos)
      const distToTarget = tmp.length()
      if (distToTarget > 0.05) {
        tmp.normalize()
        c.pos.addScaledVector(tmp, c.speed * dt)
        c.el.object3D.position.copy(c.pos)
      }

      // Spin for visual interest.
      c.el.object3D.rotation.y += dt * 3
      c.el.object3D.rotation.x += dt * 2

      const dCam = c.pos.distanceTo(cam)

      // Red reaching you = hit. Green reaching you untapped = missed (passes).
      if (c.type === 'red' && dCam < this.data.hitDist) {
        this.loseLife()
        this.removeItem(c)
        this.updateHud()
        continue
      }
      if (c.type === 'green' && dCam < this.data.missDist) {
        this.removeItem(c)
        continue
      }

      // Expired.
      if (now - c.born > this.data.maxAge) {
        this.removeItem(c)
      }
    }
  },
}
