// knockdown.js — game flow: place a brick pyramid, then pelt it with balls.
//
// Coordinates: the scene runs in XR8's SLAM world, where the detected real
// floor IS the y = 0 plane (8th Wall ground-plane tracking). Placement is a
// plain raycast against that plane + the virtual objects — stable and exact,
// no per-frame drift. `scale: absolute` on xrweb keeps 1 unit = 1 metre, so
// the tower's dimensions are real-world size.
//
// Taps are handled natively (no A-Frame cursor): a `pointerup` on the canvas
// raycasts from the tracked camera. Before placement that hits the floor;
// afterwards it hits the floor, a brick, or a ball — all valid throw targets.

import {towerLayout, buildTower} from './tower'

const BALL = {
  radius: 0.045, // ~9 cm across: tennis-ball sized at room scale
  mass: 0.25,    // 2.5x a brick: one clean hit reshapes the pyramid
  speed: 7,      // m/s — reads as a firm underhand throw
  max: 24,       // oldest balls are recycled to keep the sim cheap
  color: '#ff5a3c',
}

const KNOCK_DISTANCE_SQ = 0.0064 // 8 cm from its spawn spot, or...
const KNOCK_TILT = 0.72          // ...tipped further than ~44°: both count as fallen

const UP = {x: 0, y: 1, z: 0} // reused scratch vector for tilt checks

export const knockdownComponent = {
  init() {
    this.camera = document.getElementById('camera')
    this.ground = document.getElementById('ground')
    this.prompt = document.getElementById('promptText')
    this.score = document.getElementById('scoreLabel')
    this.resetBtn = document.getElementById('resetBtn')

    this.bricks = []
    this.origins = []
    this.balls = []
    this.placed = false
    this.razed = false
    this.lastCount = -1
    this.nextCountAt = 0
    this.raycaster = new THREE.Raycaster()

    const canvas = this.el.sceneEl.canvas
    if (canvas) {
      canvas.addEventListener('pointerup', (event) => this.onTap(event))
    } else {
      this.el.sceneEl.addEventListener('loaded', () => {
        this.el.sceneEl.canvas.addEventListener('pointerup', (event) => this.onTap(event))
      }, {once: true})
    }
    this.resetBtn.addEventListener('click', (event) => {
      event.stopPropagation()
      this.reset()
    })

    this.setPrompt('Tap the floor to place the tower')
    this.updateScore(0)
  },

  onTap(event) {
    const point = this.raycastVirtual(event)
    if (!point) return // tap hit nothing (sky)
    if (!this.placed) {
      this.placeTower(point)
    } else {
      this.throwBall(point)
    }
  },

  // Where the tap lands in world space: raycast from the tracked camera
  // against the y=0 floor plane and the virtual objects (bricks, balls).
  raycastVirtual(event) {
    const camera = this.el.sceneEl.camera
    if (!camera) return null
    const rect = event.target.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -(((event.clientY - rect.top) / rect.height) * 2 - 1))
    const objects = [this.ground.object3D,
      ...this.bricks.map((el) => el.object3D),
      ...this.balls.map((el) => el.object3D)]
    this.raycaster.setFromCamera(ndc, camera)
    const hit = this.raycaster.intersectObjects(objects, true)[0]
    return hit ? hit.point.clone() : null
  },

  placeTower(point) {
    const camPos = new THREE.Vector3()
    this.camera.object3D.getWorldPosition(camPos)
    const yaw = Math.atan2(camPos.x - point.x, camPos.z - point.z) * 180 / Math.PI

    this.bricks = buildTower(this.el.sceneEl, point, yaw)
    // origins are captured lazily in tick(): object3D positions are not yet
    // applied right after appendChild (A-Frame initializes components async).
    this.placed = true
    this.lastCount = -1
    this.setPrompt('Tap anywhere to throw balls')
  },

  throwBall(point) {
    const camPos = new THREE.Vector3()
    this.camera.object3D.getWorldPosition(camPos)

    const dir = point.clone().sub(camPos)
    // A tap whose aim point is (nearly) the camera would normalize a zero
    // vector into NaN and poison the physics world — drop such taps.
    if (dir.lengthSq() < 0.01) return
    dir.normalize()

    // Spawn in front of the camera, but not inside a brick: a deep
    // penetration at launch blows up the solver.
    let spawn = camPos.clone().addScaledVector(dir, 0.3)
    spawn.y = Math.max(spawn.y - 0.1, BALL.radius + 0.01)
    for (const b of this.bricks) {
      const c = b.object3D.position
      if (Math.hypot(spawn.x - c.x, spawn.y - c.y, spawn.z - c.z) < BALL.radius + 0.08) {
        spawn = camPos.clone().addScaledVector(dir, 0.15)
        spawn.y = Math.max(spawn.y - 0.1, BALL.radius + 0.01)
        break
      }
    }

    const el = document.createElement('a-sphere')
    // a-sphere defaults to a 0.85 m radius; size the mesh to the collider.
    el.setAttribute('geometry', `primitive: sphere; radius: ${BALL.radius}`)
    el.setAttribute('position', `${spawn.x} ${spawn.y} ${spawn.z}`)
    el.setAttribute('material', `color: ${BALL.color}; roughness: 0.35; metalness: 0.05`)
    el.setAttribute('shadow', '')
    el.setAttribute('phys-body', `
      shape: sphere; radius: ${BALL.radius}; mass: ${BALL.mass}; material: ball`)
    this.el.sceneEl.appendChild(el)

    // The body exists once the entity has loaded; then it flies.
    el.addEventListener('loaded', () => {
      const body = el.components['phys-body'].body
      body.velocity.set(dir.x * BALL.speed, dir.y * BALL.speed, dir.z * BALL.speed)
      body.angularVelocity.set(
        (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6)
    })

    this.balls.push(el)
    while (this.balls.length > BALL.max) {
      const oldest = this.balls.shift()
      if (oldest.parentNode) oldest.parentNode.removeChild(oldest)
    }
  },

  reset() {
    for (const el of [...this.bricks, ...this.balls]) {
      if (el.parentNode) el.parentNode.removeChild(el)
    }
    this.bricks = []
    this.origins = []
    this.balls = []
    this.placed = false
    this.razed = false
    this.lastCount = -1

    this.setPrompt('Tap the floor to place the tower')
    this.updateScore(0)
  },

  setPrompt(text) {
    this.prompt.textContent = text
    this.prompt.style.opacity = '1'
  },

  updateScore(down) {
    this.score.textContent = `Down ${down} / ${towerLayout().length}`
  },

  tick(time) {
    if (!this.placed || this.razed || time < this.nextCountAt) return
    this.nextCountAt = time + 300

    let down = 0
    for (let i = 0; i < this.bricks.length; i++) {
      const body = this.bricks[i].components['phys-body'] && this.bricks[i].components['phys-body'].body
      if (!body) continue
      let origin = this.origins[i]
      if (!origin) origin = this.origins[i] = body.position.clone()
      const p = body.position
      const dx = p.x - origin.x
      const dy = p.y - origin.y
      const dz = p.z - origin.z

      let knocked = dx * dx + dy * dy + dz * dz > KNOCK_DISTANCE_SQ
      if (!knocked) {
        const up = body.quaternion.vmult(UP) // brick's local up in world space
        knocked = up.y < KNOCK_TILT
      }
      if (knocked) down++
    }

    if (down !== this.lastCount) {
      this.lastCount = down
      this.updateScore(down)
    }
    if (down === this.bricks.length) {
      this.razed = true
      this.setPrompt('Tower down! Reset to build again')
    }
  },
}
