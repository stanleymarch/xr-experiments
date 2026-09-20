// particles.js — a floating field of glowing dust inside the portal room.
// The points material is stencil-clipped so the dust is only visible through
// the doorway, matching the room walls.

import {PORTAL} from './portal'

export const particlesComponent = {
  schema: {
    count: {default: 500},
  },

  init() {
    const {roomW, roomH, roomD, doorY, stencilRef} = PORTAL
    const count = this.data.count

    const positions = new Float32Array(count * 3)
    const colors = new Float32Array(count * 3)

    const cyan = new THREE.Color(0x4de0ff)
    const magenta = new THREE.Color(0xff4de0)
    const white = new THREE.Color(0xffffff)
    const tint = new THREE.Color()

    for (let i = 0; i < count; i++) {
      positions[i * 3 + 0] = (Math.random() - 0.5) * roomW
      positions[i * 3 + 1] = doorY + Math.random() * roomH
      positions[i * 3 + 2] = -Math.random() * roomD

      tint.copy(cyan).lerp(magenta, Math.random())
      if (Math.random() < 0.15) tint.copy(white)
      colors[i * 3 + 0] = tint.r
      colors[i * 3 + 1] = tint.g
      colors[i * 3 + 2] = tint.b
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))

    const mat = new THREE.PointsMaterial({
      size: 0.16,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })

    // Clip to the doorway, same as the room walls.
    mat.stencilWrite = true
    mat.stencilRef = stencilRef
    mat.stencilFunc = THREE.EqualStencilFunc
    mat.stencilFail = THREE.KeepStencilOp
    mat.stencilZFail = THREE.KeepStencilOp
    mat.stencilZPass = THREE.KeepStencilOp

    this.points = new THREE.Points(geo, mat)
    this.points.renderOrder = 1
    this.el.setObject3D('points', this.points)
  },

  tick(time) {
    if (!this.points) return
    const t = time * 0.001
    // Slow swirl around the room center, plus a gentle vertical bob.
    this.points.rotation.y = Math.sin(t * 0.25) * 0.35
    this.points.position.y = Math.sin(t * 0.6) * 0.15
  },
}
