// filter.js — "the world changed" effect. When the portal opens, the whole AR
// view (camera feed included) gets a color shift via CSS filter, plus a vignette.
// Green/red flashes react to catches and hits.

export const filterComponent = {
  init() {
    this.scene = this.el.sceneEl
    this.canvas = this.scene.canvas
    this.vignette = document.getElementById('vignette')
    this.opened = false

    this.scene.addEventListener('portal-opened', () => this.open())
    this.scene.addEventListener('cube-caught', () => this.flash('rgba(60, 255, 120, 0.55)'))
    this.scene.addEventListener('cube-hit', () => this.flash('rgba(255, 20, 60, 0.85)'))
  },

  open() {
    if (this.opened) return
    this.opened = true

    // Tint the whole AR view (camera feed + 3D) to sell the "another world" turn.
    if (this.canvas) {
      this.canvas.style.transition = 'filter 1.8s ease'
      this.canvas.style.filter = 'saturate(1.45) contrast(1.08) hue-rotate(14deg)'
    }
    this.vignette.style.opacity = '1'
  },

  flash(color) {
    const v = this.vignette
    if (!v) return
    v.style.transition = 'none'
    v.style.boxShadow = `inset 0 0 160px 70px ${color}`
    requestAnimationFrame(() => {
      v.style.transition = 'box-shadow 0.55s ease'
      v.style.boxShadow = 'inset 0 0 0 0 rgba(0,0,0,0)'
    })
  },
}
