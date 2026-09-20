// portal.js — a door-shaped rift placed in the real world.
//
// The "other world" behind the door is a room that is only visible through the
// doorway. This is done with the stencil buffer:
//   1. an invisible plane over the doorway writes stencil=1,
//   2. the room walls (and particles) test `Equal(1)`, so they only draw inside
//      the doorway rectangle on screen.
//
// The frame and the translucent "membrane" are cosmetic and draw on top.

export const PORTAL = {
  doorW: 6,        // doorway width (units)
  doorH: 10.5,     // doorway height
  doorY: 0.1,      // doorway bottom above the ground
  frameT: 0.7,     // frame thickness
  roomW: 16,       // interior world size
  roomH: 18,
  roomD: 26,
  stencilRef: 1,
}

// Clamp a material to only render where stencil === ref.
function clipToStencil(material, ref) {
  material.stencilWrite = true
  material.stencilRef = ref
  material.stencilFunc = THREE.EqualStencilFunc
  material.stencilFail = THREE.KeepStencilOp
  material.stencilZFail = THREE.KeepStencilOp
  material.stencilZPass = THREE.KeepStencilOp
  return material
}

// Radial "rift energy" texture for the membrane.
function makeRiftTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const ctx = c.getContext('2d')
  const g = ctx.createRadialGradient(128, 128, 8, 128, 128, 128)
  g.addColorStop(0.0, 'rgba(150, 235, 255, 0.95)')
  g.addColorStop(0.45, 'rgba(80, 150, 255, 0.40)')
  g.addColorStop(1.0, 'rgba(20, 40, 130, 0.0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 256, 256)
  return new THREE.CanvasTexture(c)
}

// "Nebula" gradient for the far wall of the other world.
function makeNebulaTexture() {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 256
  const ctx = c.getContext('2d')
  const g = ctx.createRadialGradient(128, 120, 20, 128, 128, 200)
  g.addColorStop(0.0, '#2b7bff')
  g.addColorStop(0.4, '#5a2bd8')
  g.addColorStop(0.75, '#1a0b3a')
  g.addColorStop(1.0, '#05030f')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 256, 256)

  // Sprinkle a few "stars".
  ctx.fillStyle = 'rgba(255,255,255,0.9)'
  for (let i = 0; i < 120; i++) {
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 1.5, 1.5)
  }
  return new THREE.CanvasTexture(c)
}

// Attach a raw THREE mesh under a new child entity.
function attachMesh(parentEl, name, mesh, renderOrder) {
  mesh.renderOrder = renderOrder
  const el = document.createElement('a-entity')
  el.setObject3D(name, mesh)
  parentEl.appendChild(el)
  return el
}

export const portalComponent = {
  init() {
    const el = this.el
    const {doorW, doorH, doorY, frameT, roomW, roomH, roomD, stencilRef} = PORTAL
    const doorCX = doorY + doorH / 2   // vertical center of the doorway
    const zDoor = 0.05                  // doorway plane, just in front of the room
    const zBack = -roomD                // far wall

    // --- 1. Stencil mask: writes stencil=1 only inside the doorway ---
    const maskMat = new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: false,
      depthTest: false,
      stencilWrite: true,
      stencilRef,
      stencilFunc: THREE.AlwaysStencilFunc,
      stencilFail: THREE.ReplaceStencilOp,
      stencilZFail: THREE.ReplaceStencilOp,
      stencilZPass: THREE.ReplaceStencilOp,
    })
    const mask = new THREE.Mesh(new THREE.PlaneGeometry(doorW, doorH), maskMat)
    mask.position.set(0, doorCX, zDoor)
    attachMesh(el, 'mask', mask, 0)

    // --- 2. Other world: five inward-facing walls, stencil-clipped ---
    const wallColor = 0x0a0d2e
    const nebula = makeNebulaTexture()

    const walls = [
      // floor
      {size: [roomW, roomD], rot: [-Math.PI / 2, 0, 0], pos: [0, doorY, -roomD / 2], mat: new THREE.MeshBasicMaterial({color: 0x11163e, side: THREE.FrontSide})},
      // ceiling
      {size: [roomW, roomD], rot: [Math.PI / 2, 0, 0], pos: [0, doorY + roomH, -roomD / 2], mat: new THREE.MeshBasicMaterial({color: 0x0b0f33, side: THREE.FrontSide})},
      // left
      {size: [roomD, roomH], rot: [0, Math.PI / 2, 0], pos: [-roomW / 2, doorY + roomH / 2, -roomD / 2], mat: new THREE.MeshBasicMaterial({color: wallColor, side: THREE.FrontSide})},
      // right
      {size: [roomD, roomH], rot: [0, -Math.PI / 2, 0], pos: [roomW / 2, doorY + roomH / 2, -roomD / 2], mat: new THREE.MeshBasicMaterial({color: wallColor, side: THREE.FrontSide})},
      // far wall (nebula)
      {size: [roomW, roomH], rot: [0, 0, 0], pos: [0, doorY + roomH / 2, zBack], mat: new THREE.MeshBasicMaterial({map: nebula, side: THREE.FrontSide})},
    ]

    walls.forEach((w) => {
      clipToStencil(w.mat, stencilRef)
      const geo = new THREE.PlaneGeometry(w.size[0], w.size[1])
      const mesh = new THREE.Mesh(geo, w.mat)
      mesh.position.set(w.pos[0], w.pos[1], w.pos[2])
      mesh.rotation.set(w.rot[0], w.rot[1], w.rot[2])
      attachMesh(el, 'wall', mesh, 1)
    })

    // --- 3. Glowing floor grid inside the room ---
    const grid = new THREE.GridHelper(roomW, 16, 0x37e6ff, 0x14285e)
    grid.position.set(0, doorY + 0.03, -roomD / 2)
    clipToStencil(grid.material, stencilRef)
    grid.renderOrder = 1
    const gridEl = document.createElement('a-entity')
    gridEl.setObject3D('grid', grid)
    el.appendChild(gridEl)

    // --- 4. Particles inside the room (own component, stencil-clipped) ---
    const particlesEl = document.createElement('a-entity')
    particlesEl.setAttribute('particles', '')
    el.appendChild(particlesEl)

    // --- 5. Door frame: four glowing boxes ---
    const frameMat = new THREE.MeshBasicMaterial({color: 0x35f2ff})
    const frame = (w, h, d, x, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), frameMat)
      m.position.set(x, y, z)
      attachMesh(el, 'frame', m, 2)
    }
    frame(doorW + frameT * 2, frameT, frameT, 0, doorY + doorH + frameT / 2, 0)        // top
    frame(frameT, doorH + frameT * 2, frameT, -doorW / 2 - frameT / 2, doorCX, 0)     // left
    frame(frameT, doorH + frameT * 2, frameT, doorW / 2 + frameT / 2, doorCX, 0)      // right
    frame(doorW + frameT * 2, frameT, frameT, 0, doorY - frameT / 2, 0)               // bottom

    // --- 6. Translucent "rift" membrane over the doorway ---
    const memMat = new THREE.MeshBasicMaterial({
      map: makeRiftTexture(),
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    })
    this.membrane = new THREE.Mesh(new THREE.PlaneGeometry(doorW, doorH), memMat)
    this.membrane.position.set(0, doorCX, zDoor + 0.02)
    attachMesh(el, 'membrane', this.membrane, 2)
  },

  tick(_time, timeDelta) {
    if (this.membrane) {
      this.membrane.rotation.z += timeDelta * 0.0004
    }
  },
}
