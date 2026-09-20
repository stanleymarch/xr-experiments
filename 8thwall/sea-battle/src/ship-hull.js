// ship-hull.js — процедурный корпус боевого корабля «той эпохи».
//
// Корабль собирается из примитивов: стальной серо-синий корпус, скошенный
// нос-форштевень, палуба, надстройка киноварного цвета, мостик, труба.
// Ось корабля — X (+X = нос). Состояние 'sunk' — затопление с креном.

const CELL = 0.12

const DECK = {
  height: 0.05,   // высота борта над водой
  width: 0.085,   // ширина корпуса
}

const PAINT = {
  hull: '#5d6b7a',      // корабельная серо-синяя
  deck: '#8a7f6a',      // деревянная палуба
  super: '#c33a26',     // киноварь надстройки
  funnel: '#3a3f46',    // дымовая труба
  number: '#f3e7cf',    // кремовый бортовой номер
}

export const shipHullComponent = {
  schema: {
    decks: {type: 'int', default: 2},
    name: {type: 'string', default: ''},
  },

  init() {
    const decks = this.data.decks
    const length = decks * CELL
    const el = this.el
    const hullMat = `color: ${PAINT.hull}; roughness: 0.6; metalness: 0.25`

    const add = (tag, attrs) => {
      const child = document.createElement(tag)
      for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, v)
      child.setAttribute('shadow', '')
      el.appendChild(child)
      return child
    }

    // Корпус: коробка от кормы до носа (+X — нос).
    const bodyLen = length - 0.05
    add('a-box', {
      position: `${-0.025 - bodyLen / 2} ${DECK.height / 2} 0`,
      width: bodyLen,
      height: DECK.height,
      depth: DECK.width,
      material: hullMat,
    })

    // Нос-форштевень: сужающийся к носу бокс со скосом.
    const bow = add('a-box', {
      position: `${bodyLen / 2 - 0.02} ${DECK.height / 2} 0`,
      width: 0.06,
      height: DECK.height,
      depth: DECK.width,
      rotation: '0 32 0',
      material: hullMat,
    })
    bow.setAttribute('scale', '1 1 0.42')

    // Корма: слегка скошена внутрь.
    add('a-box', {
      position: `${-bodyLen / 2 - 0.048} ${DECK.height / 2} 0`,
      width: 0.04,
      height: DECK.height,
      depth: DECK.width * 0.85,
      material: hullMat,
    })

    // Палуба поверх корпуса.
    add('a-box', {
      position: `${-0.025} ${DECK.height + 0.004} 0`,
      width: bodyLen,
      height: 0.008,
      depth: DECK.width - 0.012,
      material: `color: ${PAINT.deck}; roughness: 0.85; metalness: 0`,
    })

    // Надстройка (киноварь) — ближе к носу у эсминцев, в центр у катеров.
    const superX = decks >= 2 ? bodyLen / 2 - 0.075 : 0
    if (decks >= 2) {
      add('a-box', {
        position: `${superX} ${DECK.height + 0.02} 0`,
        width: 0.055,
        height: 0.024,
        depth: DECK.width - 0.032,
        material: `color: ${PAINT.super}; roughness: 0.7; metalness: 0.1`,
      })
      // Мостик со стеклом.
      add('a-box', {
        position: `${superX + 0.024} ${DECK.height + 0.036} 0`,
        width: 0.018,
        height: 0.012,
        depth: DECK.width - 0.046,
        material: `color: #22303d; roughness: 0.3; metalness: 0.4`,
      })
      // Дымовая труба — к корме от надстройки.
      add('a-cylinder', {
        position: `${superX - 0.05} ${DECK.height + 0.032} 0`,
        radius: 0.011,
        height: 0.048,
        material: `color: ${PAINT.funnel}; roughness: 0.5; metalness: 0.3`,
      })
    }

    // Бортовой номер (кремовая плашка на обоих бортах).
    for (const side of [-1, 1]) {
      add('a-box', {
        position: `${-bodyLen / 2 + 0.03} ${DECK.height - 0.012} ${side * (DECK.width / 2 + 0.001)}`,
        width: 0.03,
        height: 0.012,
        depth: 0.0015,
        material: `color: ${PAINT.number}; roughness: 0.9`,
      })
    }

    // Затопление: осадка + крен. rotation-атрибут в градусах — берём из него.
    el.addEventListener('stateadded', (e) => {
      if (e.detail !== 'sunk') return
      const pos = el.object3D.position
      const rot = el.getAttribute('rotation')
      el.setAttribute('animation__sink', `
        property: position;
        to: ${pos.x} -0.09 ${pos.z};
        dur: 2400; easing: easeInQuad`)
      el.setAttribute('animation__tilt', `
        property: rotation;
        to: ${rot.x} ${rot.y} ${rot.z + (Math.random() > 0.5 ? 38 : -38)};
        dur: 2400; easing: easeInQuad`)
    })
  },
}
