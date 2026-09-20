// phys-body.js — attach a cannon-es rigid body to an entity.
//
// The shape and mass live in the schema; the body starts exactly where the
// entity's object3D is (so set position/rotation attributes before adding
// this component). physics-world mirrors the simulation back onto the
// object3D every frame.

import * as CANNON from 'cannon-es'

export const physBodyComponent = {
  schema: {
    shape: {default: 'box', oneOf: ['box', 'sphere']},
    halfExtents: {type: 'vec3', default: {x: 0.15, y: 0.15, z: 0.15}},
    radius: {default: 0.14},
    mass: {default: 1},
    material: {default: 'brick', oneOf: ['brick', 'ball']},
  },

  init() {
    const physics = this.el.sceneEl && this.el.sceneEl.components['physics-world']
    if (!physics) {
      throw new Error('phys-body requires the physics-world component on <a-scene>')
    }

    const options = {
      mass: this.data.mass,
      material: physics.material(this.data.material),
      allowSleep: true,
      sleepSpeedLimit: 0.22,
      sleepTimeLimit: 0.6,
      linearDamping: 0.01,
      angularDamping: 0.1,
    }
    if (this.data.shape === 'sphere') {
      options.shape = new CANNON.Sphere(this.data.radius)
    } else {
      const h = this.data.halfExtents
      options.shape = new CANNON.Box(new CANNON.Vec3(h.x, h.y, h.z))
    }

    this.body = new CANNON.Body(options)
    this.body.position.copy(this.el.object3D.position)
    this.body.quaternion.copy(this.el.object3D.quaternion)
    physics.register(this.el, this.body)
  },

  remove() {
    const physics = this.el.sceneEl && this.el.sceneEl.components['physics-world']
    if (physics) physics.unregister(this.body)
  },
}
