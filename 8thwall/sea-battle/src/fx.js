// fx.js — морская поверхность, торпеда-трассер, всплеск, взрыв.

// Море — один процедурный THREE.Mesh без текстуры и DOM-слоёв. Эллиптическое
// затухание убирает «AR-прямоугольник», а depthWrite:false и подъём над
// shadow-plane исключают мерцание от двух почти совпадающих поверхностей.
export const seaSurfaceComponent = {
  schema: {
    width: {type: 'number', default: 1.8},
    depth: {type: 'number', default: 2.4},
  },

  init() {
    const geometry = new THREE.PlaneGeometry(this.data.width, this.data.depth, 36, 48)
    geometry.rotateX(-Math.PI / 2)

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {time: {value: 0}},
      vertexShader: `
        uniform float time;
        varying vec2 vUv;
        varying float vWave;

        void main() {
          vUv = uv;
          vec3 p = position;
          float shore = smoothstep(0.0, 0.18, uv.y) * (1.0 - smoothstep(0.82, 1.0, uv.y));
          float waveA = sin(p.x * 18.0 + p.z * 4.0 + time * 1.3);
          float waveB = sin(p.x * 7.0 - p.z * 11.0 - time * 0.9);
          vWave = waveA * 0.55 + waveB * 0.45;
          p.y += vWave * 0.007 * shore;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: `
        uniform float time;
        varying vec2 vUv;
        varying float vWave;

        void main() {
          vec2 q = (vUv - 0.5) * 2.0;
          float edge = 1.0 - smoothstep(0.70, 1.02, length(q));

          float longWave = sin(vUv.y * 48.0 + sin(vUv.x * 15.0) * 1.7 + time * 1.1);
          float shortWave = sin(vUv.y * 83.0 - vUv.x * 24.0 - time * 0.7);
          float foam = smoothstep(0.72, 1.0, longWave * 0.72 + shortWave * 0.28);

          vec3 deep = vec3(0.025, 0.12, 0.19);
          vec3 teal = vec3(0.10, 0.34, 0.42);
          vec3 color = mix(deep, teal, 0.30 + vUv.y * 0.20 + foam * 0.28 + vWave * 0.05);
          float alpha = edge * (0.40 + foam * 0.14);
          if (alpha < 0.015) discard;
          gl_FragColor = vec4(color, alpha);
        }
      `,
    })

    this.mesh = new THREE.Mesh(geometry, this.material)
    this.mesh.renderOrder = 1
    this.el.setObject3D('sea-surface', this.mesh)
  },

  tick(time) {
    this.material.uniforms.time.value = time / 1000
  },

  remove() {
    this.el.removeObject3D('sea-surface')
    this.mesh.geometry.dispose()
    this.material.dispose()
  },
}

// Торпеда — оммаж восьми трассам автомата: зелёный бегущий огонёк с
// хвостом гаснущих «лампочек» (следом управляет sea-battle.js).
export const torpedoComponent = {
  init() {
    const body = document.createElement('a-cylinder')
    body.setAttribute('radius', '0.008')
    body.setAttribute('height', '0.07')
    body.setAttribute('rotation', '0 0 -90')
    body.setAttribute('material', `
      color: #7dff9a; emissive: #3dff70; emissiveIntensity: 1.8;
      transparent: true; opacity: 0.95`)
    this.el.appendChild(body)

    const glow = document.createElement('a-sphere')
    glow.setAttribute('radius', '0.016')
    glow.setAttribute('material', `
      color: #3dff70; emissive: #3dff70; emissiveIntensity: 0.9;
      transparent: true; opacity: 0.35`)
    this.el.appendChild(glow)
  },
}

// Всплеск на излёте трассы: расходящееся кольцо.
export const splashFxComponent = {
  init() {
    const ring = document.createElement('a-ring')
    ring.setAttribute('rotation', '-90 0 0')
    ring.setAttribute('radius-inner', '0.01')
    ring.setAttribute('radius-outer', '0.02')
    ring.setAttribute('material', 'color: #bfe3f5; transparent: true; opacity: 0.9; side: double')
    this.el.appendChild(ring)

    ring.setAttribute('animation__grow', `
      property: scale; from: 0.4 0.4 1; to: 5 5 1; dur: 700; easing: easeOutQuad`)
    ring.setAttribute('animation__fade', `
      property: material.opacity; from: 0.9; to: 0; dur: 700; easing: easeInQuad`)
  },
}

// Взрыв попадания: оранжевая вспышка + чёрный дым.
export const explosionFxComponent = {
  init() {
    const flash = document.createElement('a-sphere')
    flash.setAttribute('radius', '0.03')
    flash.setAttribute('material', 'color: #ff7a1a; transparent: true; opacity: 1; emissive: #ff5500; emissiveIntensity: 2')
    this.el.appendChild(flash)

    const smoke = document.createElement('a-sphere')
    smoke.setAttribute('radius', '0.02')
    smoke.setAttribute('material', 'color: #23262b; transparent: true; opacity: 0.85')
    this.el.appendChild(smoke)

    flash.setAttribute('animation__pop', `
      property: scale; from: 0.5 0.5 0.5; to: 3 3 3; dur: 450; easing: easeOutQuad`)
    flash.setAttribute('animation__fade', `
      property: material.opacity; from: 1; to: 0; dur: 450`)
    smoke.setAttribute('animation__drift', `
      property: position; from: 0 0 0; to: 0 0.12 0; dur: 900; easing: easeOutQuad`)
    smoke.setAttribute('animation__fade', `
      property: material.opacity; from: 0.85; to: 0; dur: 900`)
  },
}
