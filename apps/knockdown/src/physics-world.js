// physics-world.js — a thin bridge between A-Frame and cannon-es.
//
// The scene-level `physics-world` component owns a CANNON.World, steps it on
// the scene tick, and mirrors every registered body's transform onto its
// entity's object3D. Bodies belong to entities placed directly under
// <a-scene>, so object3D transforms are world transforms and no
// local-to-world bookkeeping is needed.

import * as CANNON from 'cannon-es'

// Tuned so the brick tower sleeps quietly until a ball hits it, and bricks
// rest on each other instead of sinking into each other: stiff contact
// equations + plenty of solver iterations.
export function makeWorld() {
  const world = new CANNON.World({gravity: new CANNON.Vec3(0, -9.82, 0)})
  world.broadphase = new CANNON.SAPBroadphase(world)
  world.allowSleep = true
  world.solver.iterations = 20

  const materials = {
    ground: new CANNON.Material('ground'),
    brick: new CANNON.Material('brick'),
    ball: new CANNON.Material('ball'),
  }

  const contact = (a, b, friction, restitution, stiffness = 1e7, relaxation = 3) =>
    world.addContactMaterial(new CANNON.ContactMaterial(a, b, {
      friction,
      restitution,
      contactEquationStiffness: stiffness,
      contactEquationRelaxation: relaxation,
    }))

  // Crisp stacks: near-inelastic, very stiff brick contacts (1e9 keeps
  // gravity-driven penetration to well under a millimetre).
  contact(materials.brick, materials.brick, 0.7, 0.001, 1e9, 3)
  contact(materials.brick, materials.ground, 0.65, 0.001, 1e9, 3)
  contact(materials.ball, materials.ground, 0.35, 0.55) // balls bounce and roll
  contact(materials.ball, materials.brick, 0.3, 0.3)    // satisfying impacts

  world.defaultContactMaterial.friction = 0.4
  world.defaultContactMaterial.restitution = 0.15
  world.userData = {materials}
  return world
}
export const physicsWorldComponent = {
  init() {
    this.world = makeWorld()

    // Static floor at y = 0: XR8's world tracking puts the detected real
    // ground plane exactly there, so physics and pixels agree.
    this.floorBody = new CANNON.Body({
      shape: new CANNON.Plane(),
      material: this.world.userData.materials.ground,
    })
    this.floorBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0)
    this.world.addBody(this.floorBody)

    this.bodies = []
  },

  register(el, body) {
    this.world.addBody(body)
    this.bodies.push({el, body})
  },

  unregister(body) {
    this.world.removeBody(body)
    this.bodies = this.bodies.filter((entry) => entry.body !== body)
  },

  material(name) {
    return this.world.userData.materials[name]
  },

  tick(_time, timeDelta) {
    const dt = Math.min(timeDelta / 1000, 0.05)
    try {
      this.world.step(1 / 120, dt, 10)
    } catch (err) {
      this.purgeNonFinite()
      return
    }
    const bad = []
    for (const {el, body} of this.bodies) {
      if (body.sleepState === CANNON.Body.SLEEPING) continue
      const p = body.position
      if (!Number.isFinite(p.x + p.y + p.z)) {
        // A non-finite body will poison every contact it touches and blank
        // the whole scene; drop it before it spreads.
        bad.push({el, body})
        continue
      }
      el.object3D.position.copy(p)
      el.object3D.quaternion.copy(body.quaternion)
    }
    for (const {el, body} of bad) {
      this.unregister(body)
      if (el.parentNode) el.parentNode.removeChild(el)
    }
  },

  // Remove any body whose state went NaN (degenerate contact, spawn overlap,
  // etc.) so the rest of the world keeps simulating instead of vanishing.
  purgeNonFinite() {
    const bad = this.bodies.filter(({body}) =>
      !Number.isFinite(body.position.x + body.position.y + body.position.z))
    for (const {el, body} of bad) {
      this.unregister(body)
      if (el.parentNode) el.parentNode.removeChild(el)
    }
  },
}
