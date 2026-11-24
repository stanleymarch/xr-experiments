// Places (or repositions) the portal wherever the user taps the floor.

export const portalPlaceComponent = {
  init() {
    this.prompt = document.getElementById('promptText')
    this.hint = document.getElementById('hint')
    this.portal = null

    const ground = document.getElementById('ground')
    ground.addEventListener('click', (event) => this.onTap(event))
  },

  onTap(event) {
    // Game over? Tap resets the round instead of moving the portal.
    if (this.portal) {
      const cubes = this.portal.components.cubes
      if (cubes && cubes.isOver()) {
        cubes.reset()
        return
      }
    }

    const point = event.detail.intersection.point

    if (!this.portal) {
      this.portal = document.createElement('a-entity')
      this.portal.setAttribute('portal', '')
      this.portal.setAttribute('cubes', '')
      this.el.sceneEl.appendChild(this.portal)

      // First portal: swap prompt for gameplay hint and open the rift.
      this.prompt.style.opacity = '0'
      this.hint.classList.remove('hidden')
      this.el.sceneEl.emit('portal-opened')
    }

    // Re-anchor at the tap point and face the camera (SLAM keeps it there).
    const camPos = new THREE.Vector3()
    document.getElementById('camera').object3D.getWorldPosition(camPos)
    const yaw = Math.atan2(camPos.x - point.x, camPos.z - point.z) * 180 / Math.PI

    this.portal.setAttribute('position', point)
    this.portal.setAttribute('rotation', `0 ${yaw} 0`)
  },
}
