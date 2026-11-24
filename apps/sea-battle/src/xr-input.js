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

    // Маркеры прицела + линии курса — по комплекту на контроллер. Маркер
    // стоит на фактическом курсе торпеды (после клампа launchTorpedo),
    // линия ведёт от точки пуска к маркеру: траектория видна до выстрела.
    this.aimGroup = new THREE.Group()
    this.aimMarkers = [this.makeAimSet(), this.makeAimSet()]
    this.el.setObject3D('xr-aim-group', this.aimGroup)

    this.sceneEl.addEventListener('enter-ar', () => this.onSession())
    this.sceneEl.addEventListener('enter-vr', () => this.onSession())
    this.sceneEl.addEventListener('exit-ar', () => this.teardown())
    this.sceneEl.addEventListener('exit-vr', () => this.teardown())
  },

  makeAimSet() {
    const ring = ringMesh(0.016, 0.024, 0xffb64c, 0.95)
    // Полоса курса лежит на воде: единичный квадрат растягивается по курсу.
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0xffb64c, transparent: true, opacity: 0.28,
        side: THREE.DoubleSide, depthTest: false,
      }))
    line.renderOrder = 19
    line.visible = false
    this.aimGroup.add(line)
    this.aimGroup.add(ring)
    return {ring, line}
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
    for (const set of this.aimMarkers) {
      set.ring.visible = false
      set.line.visible = false
    }
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

    // Маркеры прицела: по одному на каждый tracked-контроллер, из той же
    // позы targetRaySpace, что берёт выстрел из select-события — маркер
    // и выстрел совпадают по построению (а не по выбору «первого лазера»).
    const aiming = game && game.placed && !game.over
    for (const set of this.aimMarkers) {
      set.ring.visible = false
      set.line.visible = false
    }
    if (aiming && frame && game.aimCoursePoint) {
      const refSpace = this.sceneEl.renderer.xr.getReferenceSpace()
      const sources = Array.from(this.session.inputSources || [])
        .filter((s) => s.targetRayMode === 'tracked-pointer' && s.handedness !== 'none')
        .slice(0, this.aimMarkers.length)
      const originWorld = game.launchOriginWorld()
      for (let i = 0; i < sources.length; i++) {
        let pose = null
        try {
          pose = frame.getPose(sources[i].targetRaySpace, refSpace)
        } catch {
          pose = null
        }
        if (!pose) continue
        const t = pose.transform
        const q = new THREE.Quaternion(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w)
        const ray = {
          origin: new THREE.Vector3(t.position.x, t.position.y, t.position.z),
          dir: new THREE.Vector3(0, 0, -1).applyQuaternion(q),
        }
        const raw = this.rayPlaneHit(ray, WATER_Y)
        if (!raw) continue
        const course = game.aimCoursePoint(raw)
        if (!course) continue
        const set = this.aimMarkers[i]
        set.ring.visible = true
        set.ring.position.set(course.x, WATER_Y + 0.005, course.z)
        if (originWorld) {
          const dx = course.x - originWorld.x
          const dz = course.z - originWorld.z
          const len = Math.hypot(dx, dz)
          if (len > 0.05) {
            set.line.visible = true
            set.line.scale.set(len, 1, 0.012)
            set.line.position.set(
              (originWorld.x + course.x) / 2,
              WATER_Y + 0.004,
              (originWorld.z + course.z) / 2)
            // Полоса лежит вдоль X; поворот — как у трассера торпеды.
            set.line.rotation.set(0, -Math.atan2(dz, dx), 0)
          }
        }
      }
    }
  },

  remove() {
    this.el.removeObject3D('xr-reticle')
    this.el.removeObject3D('xr-aim-group')
    this.reticle.traverse((o) => {
      if (o.geometry) o.geometry.dispose()
      if (o.material) o.material.dispose()
    })
    this.aimGroup.traverse((o) => {
      if (o.geometry) o.geometry.dispose()
      if (o.material) o.material.dispose()
    })
  },
}
