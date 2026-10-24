// xr-input.js — ввод в иммерсивном WebXR (Quest 3 / Android WebXR).
//
// Постановка флота: ретикл hit-test по взгляду (viewer space) — «смотри
// на пол, жми курок». Бой: прицел — точка пересечения луча контроллера
// с плоскостью воды; курок — пуск торпеды туда. На телефоне в WebXR
// тап даёт transient-источник: луч из камеры через точку тапа — те же
// правила, что и тапы в 8th Wall-режиме.
//
// Компонент вешается на <a-scene>; игру находит в компоненте sea-battle.

const WATER_Y = 0.03   // плоскость прицеливания чуть выше волн
const FLOOR_Y = 0

function ringMesh(inner, outer, color, opacity) {
  const geometry = new THREE.RingGeometry(inner, outer, 48)
  geometry.rotateX(-Math.PI / 2)
  const material = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, side: THREE.DoubleSide, depthTest: false,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.renderOrder = 20
  mesh.visible = false
  return mesh
}

export const xrInputComponent = {
  init() {
    this.sceneEl = this.el.sceneEl || this.el
    this.session = null
    this.hitTestSource = null
    this.placementPoint = null
    this.placementAt = 0

    // Ретикл постановки — по полу, куда смотрит голова.
    this.reticle = ringMesh(0.05, 0.065, 0x7dff9a, 0.95)
    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(0.012, 16).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({color: 0x7dff9a, transparent: true, opacity: 0.9, depthTest: false}))
    this.reticle.add(dot)
    this.el.setObject3D('xr-reticle', this.reticle)

    // Маркер прицела — где торпеда пойдёт по воде.
    this.aimMarker = ringMesh(0.016, 0.024, 0xffb64c, 0.95)
    this.el.setObject3D('xr-aim', this.aimMarker)

    this.sceneEl.addEventListener('enter-ar', () => this.onSession())
    this.sceneEl.addEventListener('enter-vr', () => this.onSession())
    this.sceneEl.addEventListener('exit-ar', () => this.teardown())
    this.sceneEl.addEventListener('exit-vr', () => this.teardown())
  },

  game() {
    return this.sceneEl.components['sea-battle']
  },

  onSession() {
    const session = this.sceneEl.renderer.xr.getSession()
    if (!session || this.session === session) return
    this.teardown()
    this.session = session
    session.addEventListener('end', () => this.teardown())

    session.requestReferenceSpace('viewer')
      .then((space) => session.requestHitTestSource({space}))
      .then((source) => { this.hitTestSource = source })
      .catch(() => { /* без hit-test постановка уйдёт на луч ∩ пол */ })

    session.addEventListener('select', (e) => this.onSelect(e))
  },

  teardown() {
    this.session = null
    this.hitTestSource = null
    this.placementPoint = null
    this.reticle.visible = false
    this.aimMarker.visible = false
  },

  // Луч источника ввода: контроллер (target-ray) или тап-куржок телефона.
  rayFromInputSource(e) {
    const refSpace = this.sceneEl.renderer.xr.getReferenceSpace()
    let pose = null
    try {
      pose = e.frame && e.inputSource.targetRaySpace
        ? e.frame.getPose(e.inputSource.targetRaySpace, refSpace)
        : null
    } catch {
      pose = null
    }
    if (pose) {
      const t = pose.transform
      const q = new THREE.Quaternion(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w)
      return {
        origin: new THREE.Vector3(t.position.x, t.position.y, t.position.z),
        dir: new THREE.Vector3(0, 0, -1).applyQuaternion(q),
      }
    }
    // Резерв: центр взгляда.
    const cam = this.sceneEl.camera
    return {
      origin: cam.getWorldPosition(new THREE.Vector3()),
      dir: cam.getWorldDirection(new THREE.Vector3()),
    }
  },

  rayPlaneHit(ray, y) {
    if (Math.abs(ray.dir.y) < 1e-4) return null
    const t = (y - ray.origin.y) / ray.dir.y
    if (t <= 0.1) return null
    return ray.origin.clone().addScaledVector(ray.dir, t)
  },

  onSelect(e) {
    const game = this.game()
    if (!game) return
    game.beeper.resume()

    if (game.over) {
      game.reset()
      return
    }

    const ray = this.rayFromInputSource(e)
    if (!game.placed) {
      // Живой hit-test свежее секунды — иначе луч из руки/взгляда в пол.
      const fresh = this.placementPoint &&
        performance.now() - this.placementAt < 1000
      const point = fresh ? this.placementPoint : this.rayPlaneHit(ray, FLOOR_Y)
      if (point) game.deploySea(point)
      return
    }

    if (game.torps > 0) {
      const point = this.rayPlaneHit(ray, WATER_Y)
      if (point) game.launchTorpedo(point)
    }
  },

  // Активный контроллер: берем первый видимый лазер (правая рука приоритетнее).
  activeLaser() {
    const lasers = this.sceneEl.querySelectorAll('[laser-controls]')
    let fallback = null
    for (const el of lasers) {
      if (!el.object3D) continue
      fallback = fallback || el
      if (el.object3D.visible) {
        return el
      }
    }
    return fallback
  },

  tick() {
    if (!this.session) return
    const frame = this.sceneEl.frame

    // Ретикл постановки по взгляду.
    const game = this.game()
    if (frame && this.hitTestSource) {
      const refSpace = this.sceneEl.renderer.xr.getReferenceSpace()
      const hits = frame.getHitTestResults(this.hitTestSource)
      const show = hits.length > 0 && game && !game.placed && !game.over
      if (show) {
        const pose = hits[0].getPose(refSpace)
        if (pose) {
          const t = pose.transform.position
          this.reticle.visible = true
          this.reticle.position.set(t.x, t.y + 0.01, t.z)
          this.placementPoint = new THREE.Vector3(t.x, t.y, t.z)
          this.placementAt = performance.now()
        }
      } else {
        this.reticle.visible = false
      }
    } else {
      this.reticle.visible = false
    }

    // Маркер прицела: луч контроллера по плоскости воды.
    const aiming = game && game.placed && !game.over
    if (aiming) {
      const laser = this.activeLaser()
      if (laser && laser.object3D.visible) {
        const origin = laser.object3D.getWorldPosition(new THREE.Vector3())
        const q = laser.object3D.getWorldQuaternion(new THREE.Quaternion())
        const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(q)
        const point = this.rayPlaneHit({origin, dir}, WATER_Y)
        this.aimMarker.visible = !!point
        if (point) this.aimMarker.position.set(point.x, WATER_Y + 0.005, point.z)
      } else {
        this.aimMarker.visible = false
      }
    } else {
      this.aimMarker.visible = false
    }
  },

  remove() {
    this.el.removeObject3D('xr-reticle')
    this.el.removeObject3D('xr-aim')
    this.reticle.traverse((o) => {
      if (o.geometry) o.geometry.dispose()
      if (o.material) o.material.dispose()
    })
    this.aimMarker.geometry.dispose()
    this.aimMarker.material.dispose()
  },
}
