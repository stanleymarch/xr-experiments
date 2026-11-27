// xr-hud.js — приборная доска автомата в иммерсивном WebXR.
//
// DOM-HUD не рендерится в immersive-сессии, поэтому панель дублируется
// в 3D: plane с canvas-текстурой. До постановки флота доска висит у
// головы, как щиток перископа (подсказки «наведи на пол»); после
// deploySea уходит в мир — табло над дальним краем акватории, каждый
// кадр разворачивается к игроку только по yaw. Кириллица рисуется
// системным шрифтом Russo One на canvas — без MSDF-атласов.

const W = 1024
const H = 512

const INK = {
  amber: '#ffb64c',
  cream: '#f3e7cf',
  grid: '#7fb2d9',
  lamp: '#7dff9a',
  red: '#ff6a4d',
  panel: 'rgba(18, 35, 61, 0.88)',
  border: 'rgba(127, 178, 217, 0.6)',
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

export const xrHudComponent = {
  init() {
    this.state = {
      torps: 0, hits: 0, score: 0, wave: 1, streak: 0, best: 0,
      // Центральная зона: lamp (мигает), banner {title, sub}, message, over
      lamp: null, banner: null, message: null, over: null,
    }
    this.lampUntil = 0
    this.bannerUntil = 0
    this.messageUntil = 0
    this.blinkOn = true
    this.lastBlink = 0
    this.dirty = true

    this.canvas = document.createElement('canvas')
    this.canvas.width = W
    this.canvas.height = H
    this.ctx = this.canvas.getContext('2d')

    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
    })
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.30, 0.15), this.material)
    this.mesh.renderOrder = 999
    this.mesh.visible = false
    this.el.setObject3D('xr-hud', this.mesh)

    // Мировой якорь: корень акватории + локальная точка табло над её дальним
    // краем. До постановки флота якоря нет — доска ведёт себя как «щиток
    // перископа» у головы (подсказки постановки).
    this.anchorRoot = null
    this.anchorLocal = null
    this._v = new THREE.Vector3()
    this._q = new THREE.Quaternion()

    // Панель видима только внутри иммерсивной сессии; вне её DOM-HUD достаточно.
    this.el.sceneEl.addEventListener('enter-ar', () => { this.mesh.visible = true; this.dirty = true })
    this.el.sceneEl.addEventListener('exit-ar', () => { this.mesh.visible = false })
    this.el.sceneEl.addEventListener('enter-vr', () => { this.mesh.visible = true; this.dirty = true })
    this.el.sceneEl.addEventListener('exit-vr', () => { this.mesh.visible = false })

    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => { this.dirty = true })
    }
    this.redraw()
  },

  // --- API, зеркалящее DOM-HUD из sea-battle.js --------------------------------
  setState(patch) {
    Object.assign(this.state, patch)
    this.dirty = true
  },

  /**
   * Перевод доски в «мировое табло»: rootEl — корень акватории (ставит
   * deploySea), local — позиция табло в его системе координат. Каждый кадр
   * tick держит доску в этой точке и разворачивает к игроку только по yaw:
   * счёт стабилен в мире и не вращается вместе с головой.
   */
  setWorldAnchor(rootEl, local) {
    this.anchorRoot = rootEl
    this.anchorLocal = local.clone()
  },

  lamp(text, ms) {
    this.state.lamp = text
    this.lampUntil = performance.now() + (ms || 1400)
    this.dirty = true
  },

  banner(title, sub, ms) {
    this.state.banner = {title, sub}
    this.bannerUntil = performance.now() + (ms || 2200)
    this.dirty = true
  },

  message(text, ms) {
    this.state.message = text
    // ms = 0 — висит, пока его не сменят (указания перед постановкой флота).
    this.messageUntil = ms ? performance.now() + ms : Infinity
    this.dirty = true
  },

  gameOver(lines) {
    this.state.over = lines
    this.dirty = true
  },

  // --- Отрисовка -----------------------------------------------------------------
  text(str, x, y, size, color, align = 'center', weight = '') {
    const ctx = this.ctx
    ctx.font = `${weight} ${size}px 'Russo One', 'Arial Black', 'Segoe UI', sans-serif`
    ctx.fillStyle = color
    ctx.textAlign = align
    ctx.textBaseline = 'middle'
    ctx.fillText(str, x, y)
  },

  redraw() {
    const ctx = this.ctx
    const s = this.state
    ctx.clearRect(0, 0, W, H)

    // Щиток.
    ctx.fillStyle = INK.panel
    roundRect(ctx, 6, 6, W - 12, H - 12, 26)
    ctx.fill()
    ctx.lineWidth = 5
    ctx.strokeStyle = INK.border
    ctx.stroke()

    // Верхний ряд: четыре табло.
    const cols = [
      ['ТОРПЕДЫ', String(s.torps), INK.amber],
      ['ПОРАЖЕНО', String(s.hits), INK.cream],
      ['СЧЁТ', String(s.score), INK.amber],
      ['ВОЛНА', String(s.wave), INK.cream],
    ]
    cols.forEach(([label, value, color], i) => {
      const x = 128 + i * 256
      this.text(label, x, 62, 26, INK.grid)
      this.text(value, x, 118, 58, color)
    })

    // Серия точных попаданий.
    if (s.streak >= 2) {
      this.text(`СЕРИЯ ×${s.streak}`, W / 2, 168, 32, INK.lamp)
    }

    // Нижняя строка: рекорд заведения.
    this.text(`РЕКОРД ${s.best || '—'}`, W / 2, 466, 28, INK.grid)

    // Центральная зона: приоритет — конец игры, лампа, баннер, сообщение.
    if (s.over) {
      this.text('ИГРА ОКОНЧЕНА', W / 2, 218, 66, INK.amber)
      s.over.forEach((line, i) => this.text(line, W / 2, 288 + i * 42, 32, INK.cream))
      this.text('15 КОПЕЕК — НОВАЯ ИГРА (КУРОК)', W / 2, 420, 26, INK.red)
    } else if (s.lamp && this.blinkOn) {
      ctx.save()
      ctx.shadowColor = INK.lamp
      ctx.shadowBlur = 26
      this.text(s.lamp, W / 2, 250, 64, INK.lamp)
      ctx.restore()
    } else if (s.banner) {
      this.text(s.banner.title, W / 2, 224, 56, INK.amber)
      if (s.banner.sub) this.text(s.banner.sub, W / 2, 286, 30, INK.cream)
    } else if (s.message) {
      this.text(s.message, W / 2, 250, 34, INK.cream)
    }

    this.texture.needsUpdate = true
    this.dirty = false
  },

  // Позиция/ориентация доски на этот кадр.
  updatePlacement() {
    const cam = this.el.sceneEl.camera
    if (!cam) return
    if (this.anchorRoot && this.anchorRoot.object3D) {
      // Табло в мире: якорь над дальним краем акватории, билборд по yaw
      // (наклон головы больше не наклоняет и не двигает счёт).
      this.anchorRoot.object3D.updateWorldMatrix(true, false)
      this.mesh.position.copy(this.anchorLocal).applyMatrix4(this.anchorRoot.object3D.matrixWorld)
      cam.getWorldPosition(this._v)
      this.mesh.rotation.set(0, Math.atan2(this._v.x - this.mesh.position.x, this._v.z - this.mesh.position.z), 0)
    } else {
      // До постановки флота — прежний «щиток перископа»: камера-поза + офсет.
      cam.getWorldQuaternion(this._q)
      this.mesh.quaternion.copy(this._q)
      this.mesh.position.set(0, -0.15, -0.48).applyQuaternion(this._q).add(cam.getWorldPosition(this._v))
    }
  },

  tick(time) {
    if (!this.mesh.visible) return
    this.updatePlacement()
    const now = performance.now()
    let expire = false
    if (this.state.lamp && now > this.lampUntil) { this.state.lamp = null; expire = true }
    if (this.state.banner && now > this.bannerUntil) { this.state.banner = null; expire = true }
    if (this.state.message && now > this.messageUntil) { this.state.message = null; expire = true }
    // Мигание лампы — шагами, как лампочка автомата.
    if (this.state.lamp && now - this.lastBlink > 140) {
      this.lastBlink = now
      this.blinkOn = !this.blinkOn
      this.dirty = true
    }
    if (expire) this.dirty = true
    if (this.dirty) this.redraw()
  },

  remove() {
    this.el.removeObject3D('xr-hud')
    this.anchorRoot = null
    this.anchorLocal = null
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.texture.dispose()
  },
}
