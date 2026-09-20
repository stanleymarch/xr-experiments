// tower.js — the pyramid of bricks the player demolishes.
//
// Scale notes: bricks are 9 cm cubes, so the 5-level pyramid spans ~46 cm —
// an object that reads as "standing on my floor", not a monument. Bodies
// spawn with small clearances (no pre-stressed contacts) and high-contact
// stiffness in physics-world keeps bricks from sinking into each other.
//
// towerLayout() is pure (no A-Frame) so the geometry can be reasoned about
// in isolation; buildTower() turns the layout into shadowed, physical
// a-box entities that are direct children of the scene.

export const TOWER = {
  levels: 5,                       // rows of 5+4+3+2+1 bricks = 15 bricks
  brick: {w: 0.09, h: 0.09, d: 0.09}, // metres — room scale, not room size
  gap: 0.0006,                    // sub-mm clearance: settling is invisible, contacts aren't pre-stressed
  palette: ['#35f2ff', '#3dff88', '#ffd23d', '#ff9f1c', '#ff5a3c'],
  mass: 0.1,
}

export function towerLayout() {
  const {levels, brick, gap} = TOWER
  const bricks = []
  for (let level = 0; level < levels; level++) {
    const count = levels - level
    const y = brick.h / 2 + 0.0008 + level * (brick.h + gap)
    for (let i = 0; i < count; i++) {
      bricks.push({
        x: (i - (count - 1) / 2) * (brick.w + gap),
        y,
        z: 0,
        color: TOWER.palette[level % TOWER.palette.length],
      })
    }
  }
  return bricks
}

// Bricks are appended straight to the scene at world coordinates: the
// layout is rotated around the tap point so the wall faces the player.
export function buildTower(sceneEl, origin, yaw) {
  const {brick, mass} = TOWER
  const rad = (yaw * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)

  return towerLayout().map((b) => {
    const el = document.createElement('a-box')
    // a-box defaults to a 1x1x1 m cube; size the mesh to the collider.
    el.setAttribute('geometry', `primitive: box; width: ${brick.w}; height: ${brick.h}; depth: ${brick.d}`)
    el.setAttribute('position', `
      ${origin.x + b.x * cos} ${origin.y + b.y} ${origin.z - b.x * sin}`)
    el.setAttribute('rotation', `0 ${yaw} 0`)
    el.setAttribute('material', `color: ${b.color}; roughness: 0.55`)
    el.setAttribute('shadow', '')
    el.setAttribute('phys-body', `
      shape: box;
      halfExtents: ${brick.w / 2} ${brick.h / 2} ${brick.d / 2};
      mass: ${mass};
      material: brick`)
    sceneEl.appendChild(el)
    return el
  })
}
