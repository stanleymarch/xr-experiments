// sea-battle.js — «Морской бой»: советский перископный автомат в AR.
//
// Прототип — электромеханический автомат «Морской бой» (Серпуховский
// радиотехнический завод, 1974): игрок смотрит в перископ, корабли ходят
// по морю на цепи слева-направо, поворотом перископа выбирается одна из
// восьми трасс торпеды, кнопка «Пуск» на рукоятке запускает «торпеду» —
// бегущий огонёк лампочек. Попадание — вспышка, «ТОРПЕДИРОВАНО», счёт.
// Игра: 15 коп. = 10 пусков; 10 из 10 — призовая игра.
//
// AR-переложение: тап по полу опускает «акваторию» в реальный мир — тёмное
// море с волнами, корабли ходят по трём дальностям, как на цепи. Тап по
// морю — пуск торпеды: из точки у игрока по поверхности бежит зелёный
// трассер с хвостом «лампочек». Наводить нужно с упреждением — корабли
// движутся.
//
// Полная игра (обоим режимам): флот выходит волнами — «ВЫХОД ФЛОТА N»,
// каждая волна быстрее и с пополнением боезапаса, к ночи море темнеет.
// Очки по типам корпусов (катер/стрела/лидер), серия точных попаданий
// даёт нарастающий бонус, рекорд стоит на прилавке автомата. 10 из 10
// без промаха — призовая игра: +3 торпеды и очки ×2.
//
// Режимы (роутинг в boot.js):
//   slam  — 8th Wall XR8 SLAM (только iOS: там нет WebXR), тап по экрану,
//           HUD в DOM;
//   webxr — иммерсивный WebXR (Quest 3, Android WebXR): hit-test
//           постановки, курок/тап через xr-input, HUD в 3D (xr-hud);
//   flat  — десктоп A-Frame: вахтенная сетка, мышь, HUD в DOM; кнопка VR
//           оставляет шаг в шлем с той же игрой.

// --- Акватория ---------------------------------------------------------------
// Точка постановки — по тапу, но геометрия всегда считается от игрока:
// вода начинается чуть впереди ног, торпеда выходит из-под ног, а линии
// кораблей раскладываются долями глубины — флот читается на любом
// расстоянии постановки.
const SEA = {
  width: 2.4,             // ширина моря по X
  farZ: -1.0,             // дальний край относительно точки постановки
  waterInset: 0.7,        // вода начинается в 0.7 м перед игроком
  launchInset: 0.3,       // торпеда выходит в 0.3 м перед игроком
  anchorMin: 1.9,         // не ставим ближе: акватория не должна быть под ногами
  anchorMax: 3.4,         // не ставим дальше: корабли станут нечитаемы
  laneFractions: [0.78, 0.55, 0.32], // доля глубины от дальнего края
  lanes: [
    {speed: 0.11, dir: 1, ships: ['small', 'small', 'big']},
    {speed: 0.075, dir: -1, ships: ['mid', 'mid', 'small']},
    {speed: 0.05, dir: 1, ships: ['big', 'mid']},
  ],
}

const SHIP_TYPES = {
  big: {decks: 3, name: 'ЛИДЕР'},
  mid: {decks: 2, name: 'СТРЕЛА'},
  small: {decks: 1, name: 'КАТЕР'},
}

const TORPEDO = {
  speed: 1.1,        // м/с по поверхности: от ног игрока до горизонта
  radius: 0.02,      // допуск попадания (расширение AABB корпуса)
  trailEvery: 90,    // мс между «лампочками» хвоста
  maxRun: 9,         // с: страховка от вечного бегуна
}

// --- Экономика автомата и прогресс игры ---------------------------------------
const ECONOMY = {
  coinTorpedoes: 10,   // пусков за монету — как за 15 копеек
  prizeTorpedoes: 3,   // призовая игра: ещё торпеды
  waveRefill: 4,       // пополнение за пройденную волну: точность продлевает бой
  quotaBase: 3,        // кораблей на первую волну
  quotaPerWave: 1,     // каждая следующая волна требует на корпус больше
  quotaMax: 8,
  speedPerWave: 0.12,  // +12% к ходу флота за волну
  speedMax: 1.9,
  nightPerWave: 0.15,  // море темнеет к ночи
  nightMax: 0.6,
}

const POINTS = {small: 10, mid: 20, big: 30}  // катер/стрела/лидер
const STREAK_STEP = 10                        // бонус серии: +10 за звено
const STREAK_CAP = 50

export const BEST_KEY = 'seabattle-best-v1'

export function loadBest() {
  try {
    const v = JSON.parse(localStorage.getItem(BEST_KEY) || 'null')
    return v && Number.isFinite(v.score) && v.score > 0 ? v : null
  } catch {
    return null
  }
}

function saveBest(entry) {
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(entry))
  } catch {
    // Приватный режим и т.п. — рекорд просто не переживёт перезагрузку.
  }
}

// --- Звук: WebAudio-«пьезодинамик» автомата ---------------------------------
function makeBeeper() {
  const Ctx = window.AudioContext || window.webkitAudioContext
  const ctx = Ctx ? new Ctx() : null
  return {
    resume() { if (ctx && ctx.state === 'suspended') ctx.resume() },
    tone(freq, dur, type = 'square', gain = 0.12) {
      if (!ctx) return
      const osc = ctx.createOscillator()
      const amp = ctx.createGain()
      osc.type = type
      osc.frequency.value = freq
      amp.gain.setValueAtTime(gain, ctx.currentTime)
      amp.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur)
      osc.connect(amp).connect(ctx.destination)
      osc.start()
      osc.stop(ctx.currentTime + dur)
    },
    launch() { this.tone(520, 0.08); this.tone(660, 0.1, 'square', 0.08) },
    expire() { this.tone(240, 0.14, 'triangle', 0.07) },
    hit() { this.tone(110, 0.35, 'square', 0.16); this.tone(55, 0.5, 'sawtooth', 0.1) },
    sink() { [392, 330, 262, 196].forEach((f, i) =>
      setTimeout(() => this.tone(f, 0.16, 'square', 0.12), i * 110)) },
    wave() { [523, 659].forEach((f, i) =>
      setTimeout(() => this.tone(f, 0.12, 'square', 0.1), i * 110)) },
    prize() { [523, 659, 784, 1047, 1319].forEach((f, i) =>
      setTimeout(() => this.tone(f, 0.16, 'square', 0.12), i * 120)) },
    over() { [330, 262, 220, 175].forEach((f, i) =>
      setTimeout(() => this.tone(f, 0.22, 'sawtooth', 0.1), i * 170)) },
  }
}

export const seaBattleComponent = {
  schema: {
    mode: {default: 'slam'},  // 'slam' | 'webxr' — ставит boot.js
  },

  init() {
    this.camera = document.getElementById('camera')
    this.ground = document.getElementById('ground')
    this.prompt = document.getElementById('promptText')
    this.hint = document.getElementById('hint')
    this.torpsLabel = document.getElementById('torpsLabel')
    this.hitsLabel = document.getElementById('hitsLabel')
    this.scoreLabel = document.getElementById('scoreLabel')
    this.waveLabel = document.getElementById('waveLabel')
    this.streakBadge = document.getElementById('streakBadge')
    this.bannerEl = document.getElementById('banner')
    this.resetBtn = document.getElementById('resetBtn')
    this.torpedoed = document.getElementById('torpedoed')
    this.gameOver = document.getElementById('gameOver')
    this.overSub = document.getElementById('overSub')
    this.prizeFlash = document.getElementById('prizeFlash')

    this.raycaster = new THREE.Raycaster()
    this.root = null
    this.waterEl = null
    this.lanes = []
    this.shipEls = []     // a-entity с ship-hull
    this.torpedoes = []   // {el, vel(THREE.Vector3), born, lastTrail}
    this.fx = []
    this.placed = false
    this.over = false
    this.beeper = makeBeeper()
    this.initState()

    if (this.data.mode === 'webxr') {
      // Тапов нет — указания до и после постановки идут в 3D-панель.
      this.hint.innerHTML = 'Корабли идут — бей <b>с упреждением</b>. Курок по морю = пуск'
      this.message3d('НАВЕДИ НА ПОЛ — КУРОК РАЗВЕРНЁТ ФЛОТ', 0)
    } else {
      if (this.data.mode === 'flat') {
        this.prompt.textContent = 'КЛИКНИ ПО ВАХТЕННОЙ СЕТКЕ — РАЗВЕРНУТЬ ФЛОТ'
        this.hint.innerHTML = 'Корабли идут — бей <b>с упреждением</b>. Клик по морю = пуск'
      }
      const canvas = this.el.sceneEl.canvas
      if (canvas) {
        canvas.addEventListener('pointerup', (e) => this.onTap(e))
      } else {
        this.el.sceneEl.addEventListener('loaded', () => {
          this.el.sceneEl.canvas.addEventListener('pointerup', (e) => this.onTap(e))
        }, {once: true})
      }
      if (this.data.mode === 'flat') {
        // Из flat можно шагнуть в VR-шлем: там указания идут в 3D-панель.
        this.el.sceneEl.addEventListener('enter-vr', () => {
          if (!this.placed) this.message3d('НАВЕДИ НА СЕТКУ — КУРОК РАЗВЕРНЁТ ФЛОТ', 0)
        })
      }
    }
    this.resetBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.reset()
    })

    this.updateHud()
  },

  initState() {
    this.torps = ECONOMY.coinTorpedoes
    this.launched = 0
    this.hits = 0
    this.score = 0
    this.wave = 1
    this.waveSinks = 0
    this.streak = 0
    this.prizeMode = false
    this.speedMul = 1
    this.night = 0
    this.betweenWaves = false
    this.traffic = {0: false, 1: false, 2: false}
    this.best = loadBest()
  },

  onTap(event) {
    this.beeper.resume()
    if (this.over) {
      this.reset()
      return
    }
    const point = this.raycastSea(event)
    if (!this.placed) {
      if (point) this.deploySea(point)
      return
    }
    if (point && this.torps > 0) this.launchTorpedo(point)
  },

  // Мировая точка тапа: луч из трекаемой камеры в пол или в корабли.
  raycastSea(event) {
    const camera = this.el.sceneEl.camera
    if (!camera) return null
    const rect = event.target.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -(((event.clientY - rect.top) / rect.height) * 2 - 1))
    // Мировые матрицы обновляет рендер-луп: до первого кадра (или в окне,
    // где RAF не крутится) они застарелые — камера висит в y=0, бокс пола
    // без масштаба, — и луч гарантированно промахивается. Локальные позиции
    // к этому моменту уже верны, поэтому перед лучом пересчитываем граф сами.
    this.el.sceneEl.object3D.updateMatrixWorld(true)
    this.raycaster.setFromCamera(ndc, camera)
    const objects = [this.ground.object3D,
      ...this.shipEls.map((el) => el.object3D)]
    const hit = this.raycaster.intersectObjects(objects, true)[0]
    return hit ? hit.point.clone() : null
  },

  // --- Зеркало HUD в 3D (иммерсивные режимы) -----------------------------------
  hud3d() {
    if (this.data.mode === 'slam') return null
    const el = this.el.sceneEl.querySelector('[xr-hud]')
    return el && el.components && el.components['xr-hud'] ? el.components['xr-hud'] : null
  },

  message3d(text, ms) {
    const h = this.hud3d()
    if (h) h.message(text, ms)
  },

  hudBanner(title, sub, ms) {
    this.bannerEl.innerHTML = sub ? `<b>${title}</b>${sub}` : `<b>${title}</b>`
    this.bannerEl.classList.remove('hidden')
    clearTimeout(this._bannerTimer)
    this._bannerTimer = setTimeout(() => this.bannerEl.classList.add('hidden'), ms)
    const h = this.hud3d()
    if (h) h.banner(title, sub, ms)
  },

  // --- Развертывание акватории ------------------------------------------------
  // Игрок всегда оказывается в локальном z = anchorDist: туда указывает +Z.
  // Дистанцию постановки зажимаем, чтобы флот был в кадре и читался.
  deploySea(point) {
    const camPos = new THREE.Vector3()
    this.camera.object3D.getWorldPosition(camPos)
    const dx = camPos.x - point.x
    const dz = camPos.z - point.z
    const dist = Math.hypot(dx, dz)
    if (dist < 0.05) return // тап ровно под ногами — ставить некуда

    const yaw = Math.atan2(dx, dz) * 180 / Math.PI
    const anchorDist = Math.min(Math.max(dist, SEA.anchorMin), SEA.anchorMax)
    const ax = camPos.x - (dx / dist) * anchorDist
    const az = camPos.z - (dz / dist) * anchorDist

    this.root = document.createElement('a-entity')
    this.root.setAttribute('position', `${ax} ${point.y > -0.5 && point.y < 0.5 ? point.y : 0} ${az}`)
    this.root.setAttribute('rotation', `0 ${yaw} 0`)
    this.el.sceneEl.appendChild(this.root)

    // Геометрия от игрока: глубина и линии кораблей.
    this.playerZ = anchorDist
    this.waterNearZ = this.playerZ - SEA.waterInset
    this.depth = this.waterNearZ - SEA.farZ
    this.lanes = SEA.lanes.map((lane, i) => ({
      ...lane,
      z: SEA.farZ + SEA.laneFractions[i] * this.depth,
    }))

    this.buildSea()

    // «Опустили монету» — корабли сразу пошли, как на цепи автомата.
    this.shipEls = []
    for (const lane of this.lanes) this.populateLane(lane)

    this.placed = true
    this.prompt.classList.add('hidden')
    this.hint.classList.remove('hidden')
    this.message3d('БЕЙ С УПРЕЖДЕНИЕНИЕМ — КУРОК ПО МОРЮ', 3500)
  },

  buildSea() {
    const centerZ = (this.waterNearZ + SEA.farZ) / 2

    // Мягкая процедурная поверхность: без прямоугольной кромки и без
    // z-fighting с shadow-plane реального пола.
    const water = document.createElement('a-entity')
    water.setAttribute('position', `0 0.025 ${centerZ}`)
    water.setAttribute('sea-surface', `width: ${SEA.width}; depth: ${this.depth}; night: ${this.night}`)
    this.root.appendChild(water)
    this.waterEl = water
  },

  // Ближайшая по глубине линия — по ней берём скорость и курс для корабля.
  laneAt(z) {
    return this.lanes.reduce((b, l) => Math.abs(l.z - z) < Math.abs(b.z - z) ? l : b)
  },

  // Корабли «на цепи»: по слоту на lanes.ships, равномерно по ширине моря.
  populateLane(lane) {
    const n = lane.ships.length
    lane.ships.forEach((type, i) => {
      const x = -SEA.width / 2 + (i + 0.5) * SEA.width / n
      this.spawnShip(SHIP_TYPES[type], x, lane, type)
    })
  },

  spawnShip(spec, x, lane, typeKey) {
    const el = document.createElement('a-entity')
    el.shipType = typeKey
    el.setAttribute('position', `${x} 0 ${lane.z}`)
    // A-Frame применяет атрибут position асинхронно, а tick уже двигает
    // object3D — выставляем обе точки сразу, чтобы не было скачка.
    el.object3D.position.set(x, 0, lane.z)
    // +X — нос; корабль смотрит по ходу движения.
    el.setAttribute('rotation', `0 ${lane.dir > 0 ? 0 : 180} 0`)
    el.setAttribute('ship-hull', `decks: ${spec.decks}; name: ${spec.name}`)
    el.classList.add('ship')
    this.root.appendChild(el)
    this.shipEls.push(el)
    return el
  },

  // --- Пуск торпеды -------------------------------------------------------------
  // Трасса выходит из-под ног игрока — как из лодки, а не из точки постановки
  // акватории. Курс задаётся тапом/курком, упреждение — за счёт хода кораблей.
  launchTorpedo(targetWorld) {
    if (this.torps <= 0 || this.over) return
    this.torps--
    this.launched++
    this.updateHud()
    this.beeper.launch()

    const local = this.root.object3D.worldToLocal(targetWorld.clone())
    const origin = new THREE.Vector3(0, 0.015, this.playerZ - SEA.launchInset)
    const dir = new THREE.Vector3(local.x, 0, local.z).sub(
      new THREE.Vector3(origin.x, 0, origin.z))
    // Прицел «за спину» не разворачивает торпеду: ведём вперёд по Z.
    if (dir.z > -0.05) dir.z = -0.05
    dir.normalize()

    const el = document.createElement('a-entity')
    el.setAttribute('position', `${origin.x} ${origin.y} ${origin.z}`)
    // Тот же синхронный старт: первый tick идёт из точки пуска, не из нуля.
    el.object3D.position.copy(origin)
    // Цилиндр-трассер лежит по X; доворачиваем на курс.
    const heading = Math.atan2(dir.z, dir.x)
    el.setAttribute('torpedo', '')
    el.setAttribute('rotation', `0 ${-heading * 180 / Math.PI} 0`)
    this.root.appendChild(el)

    this.torpedoes.push({
      el,
      vel: dir.multiplyScalar(TORPEDO.speed),
      born: performance.now(),
      lastTrail: 0,
    })
  },

  // --- Эффекты -------------------------------------------------------------------
  trailDotAt(localPos) {
    const el = document.createElement('a-sphere')
    el.setAttribute('radius', '0.006')
    el.setAttribute('position', `${localPos.x} 0.008 ${localPos.z}`)
    el.setAttribute('material', `
      color: #7dff9a; emissive: #3dff70; emissiveIntensity: 1.6;
      transparent: true; opacity: 0.95`)
    el.setAttribute('animation__fade', `
      property: material.opacity; from: 0.95; to: 0; dur: 1100; easing: easeInQuad`)
    this.root.appendChild(el)
    this.fx.push({el, until: performance.now() + 1150})
  },

  splashAt(localPos) {
    const el = document.createElement('a-entity')
    el.setAttribute('position', `${localPos.x} 0.005 ${localPos.z}`)
    el.setAttribute('splash-fx', '')
    this.root.appendChild(el)
    this.fx.push({el, until: performance.now() + 800})
  },

  explosionAt(localPos) {
    const el = document.createElement('a-entity')
    el.setAttribute('position', `${localPos.x} 0.04 ${localPos.z}`)
    el.setAttribute('explosion-fx', '')
    this.root.appendChild(el)
    this.fx.push({el, until: performance.now() + 1000})
  },

  flashTorpedoed() {
    this.torpedoed.classList.remove('hidden')
    clearTimeout(this._torpTimer)
    this._torpTimer = setTimeout(() => this.torpedoed.classList.add('hidden'), 1400)
    const h = this.hud3d()
    if (h) h.lamp('ТОРПЕДИРОВАНО', 1400)
  },

  // --- Попадания --------------------------------------------------------------------
  hitShipAt(localPos) {
    const world = this.root.object3D.localToWorld(localPos.clone())
    for (const el of this.shipEls) {
      if (el.isSunk || !el.object3D) continue
      const box = new THREE.Box3().setFromObject(el.object3D)
      box.expandByScalar(TORPEDO.radius)
      if (box.containsPoint(world)) return el
    }
    return null
  },

  sinkShip(el) {
    el.isSunk = true
    el.addState('sunk')
    this.beeper.sink()
    this.hits++

    // Очки: тип корпуса, приз ×2 и нарастающий бонус серии.
    this.streak++
    const streakBonus = this.streak >= 2
      ? Math.min(STREAK_STEP * (this.streak - 1), STREAK_CAP)
      : 0
    this.score += POINTS[el.shipType] * (this.prizeMode ? 2 : 1) + streakBonus
    this.waveSinks++

    this.flashTorpedoed()
    this.updateHud()
    this.maybePrize()
    if (!this.betweenWaves && this.waveSinks >= this.quota()) this.advanceWave()

    // Цепь не останавливается: через паузу на место погибшего приходит новый.
    setTimeout(() => {
      if (!this.root) return
      const pos = el.object3D.position
      const typeKeys = Object.keys(SHIP_TYPES)
      const typeKey = typeKeys[Math.floor(Math.random() * typeKeys.length)]
      const spec = SHIP_TYPES[typeKey]
      const lane = this.laneAt(pos.z)
      const entryX = lane.dir > 0 ? -SEA.width / 2 - 0.05 : SEA.width / 2 + 0.05
      const i = this.shipEls.indexOf(el)
      if (i >= 0) this.shipEls.splice(i, 1)
      if (el.parentNode) el.parentNode.removeChild(el)
      if (!this.over) this.spawnShip(spec, entryX, lane, typeKey)
    }, 2500)
  },

  // --- Волны -----------------------------------------------------------------------
  quota() {
    return Math.min(ECONOMY.quotaBase + (this.wave - 1) * ECONOMY.quotaPerWave,
      ECONOMY.quotaMax)
  },

  advanceWave() {
    this.betweenWaves = true
    const next = this.wave + 1
    setTimeout(() => {
      this.betweenWaves = false
      if (this.over || !this.placed) return
      this.wave = next
      this.waveSinks = 0
      this.torps += ECONOMY.waveRefill
      this.speedMul = Math.min(1 + (this.wave - 1) * ECONOMY.speedPerWave,
        ECONOMY.speedMax)
      this.night = Math.min((this.wave - 1) * ECONOMY.nightPerWave,
        ECONOMY.nightMax)
      if (this.waterEl) this.waterEl.setAttribute('sea-surface', 'night', this.night)
      this.addWaveTraffic()
      this.hudBanner(`ВЫХОД ФЛОТА ${this.wave}`,
        `ТОРПЕДЫ +${ECONOMY.waveRefill} · ХОД +${Math.round((this.speedMul - 1) * 100)}%`,
        2400)
      this.beeper.wave()
      this.updateHud()
    }, 1800)
  },

  // Пара волн — и на линию встаёт дополнительный корпус: флот густеет.
  addWaveTraffic() {
    const extra = [
      {wave: 3, lane: 0, type: 'small'},
      {wave: 5, lane: 2, type: 'mid'},
      {wave: 7, lane: 1, type: 'small'},
    ]
    for (const e of extra) {
      if (this.wave >= e.wave && !this.traffic[e.lane] && this.lanes[e.lane]) {
        this.traffic[e.lane] = true
        const lane = this.lanes[e.lane]
        const entryX = lane.dir > 0 ? -SEA.width / 2 - 0.05 : SEA.width / 2 + 0.05
        this.spawnShip(SHIP_TYPES[e.type], entryX, lane, e.type)
      }
    }
  },

  finish() {
    this.over = true
    this.hint.classList.add('hidden')
    const isRecord = this.score > 0 && (!this.best || this.score > this.best.score)
    if (isRecord) {
      this.best = {score: this.score, wave: this.wave}
      saveBest(this.best)
    }
    const stat = `СЧЁТ ${this.score} · ФЛОТ ${this.wave} · ПОРАЖЕНО ${this.hits}`
    const tail = isRecord ? 'НОВЫЙ РЕКОРД!' : `РЕКОРД ${this.best ? this.best.score : 0}`
    this.overSub.textContent = `${stat} · ${tail}`
    this.gameOver.classList.remove('hidden')
    const h = this.hud3d()
    if (h) h.gameOver([stat, tail])
    this.beeper.over()
  },

  // Приз: все пуски монеты легли в цель — чистая работа, как в автомате.
  maybePrize() {
    if (this.prizeMode || this.over) return false
    if (this.hits < ECONOMY.coinTorpedoes || this.launched !== this.hits) return false
    this.prizeMode = true
    this.torps += ECONOMY.prizeTorpedoes
    this.prizeFlash.classList.remove('hidden')
    clearTimeout(this._prizeTimer)
    this._prizeTimer = setTimeout(() => this.prizeFlash.classList.add('hidden'), 2600)
    const h = this.hud3d()
    if (h) h.banner('★ ПРИЗОВАЯ ИГРА', `+${ECONOMY.prizeTorpedoes} ТОРПЕДЫ · ОЧКИ ×2`, 2600)
    this.beeper.prize()
    this.updateHud()
    return true
  },

  reset() {
    for (const t of this.torpedoes) {
      if (t.el.parentNode) t.el.parentNode.removeChild(t.el)
    }
    for (const f of this.fx) {
      if (f.el.parentNode) f.el.parentNode.removeChild(f.el)
    }
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root)
    this.torpedoes = []
    this.fx = []
    this.shipEls = []
    this.lanes = []
    this.root = null
    this.waterEl = null
    this.placed = false
    this.over = false
    this.initState()
    this.gameOver.classList.add('hidden')
    this.prizeFlash.classList.add('hidden')
    this.torpedoed.classList.add('hidden')
    this.hint.classList.add('hidden')
    this.bannerEl.classList.add('hidden')
    this.prompt.classList.remove('hidden')
    if (this.data.mode === 'webxr') this.message3d('НАВЕДИ НА ПОЛ — КУРОК РАЗВЕРНЁТ ФЛОТ', 0)
    this.updateHud()
  },

  updateHud() {
    this.torpsLabel.textContent = 'ТОРПЕДЫ ' + Math.max(this.torps, 0)
    this.hitsLabel.textContent = 'ПОРАЖЕНО ' + this.hits
    this.scoreLabel.textContent = 'СЧЁТ ' + this.score
    this.waveLabel.textContent = 'ВОЛНА ' + this.wave
    if (this.streak >= 2) {
      this.streakBadge.textContent = 'СЕРИЯ ' + this.streak
      this.streakBadge.classList.remove('hidden')
    } else {
      this.streakBadge.classList.add('hidden')
    }
    const h = this.hud3d()
    if (h) {
      h.setState({
        torps: Math.max(this.torps, 0),
        hits: this.hits,
        score: this.score,
        wave: this.wave,
        streak: this.streak,
        best: this.best ? this.best.score : 0,
      })
    }
  },

  tick(time, deltaMs) {
    if (!this.placed) return
    const dt = Math.min(deltaMs, 100) / 1000
    const now = performance.now()

    // Корабли «на цепи»: равномерно по своей линии, выход за край — вход
    // с противоположной стороны; ход флота растёт с волной.
    for (const el of this.shipEls) {
      if (el.isSunk) continue
      const lane = this.laneAt(el.object3D.position.z)
      const p = el.object3D.position
      p.x += lane.speed * this.speedMul * lane.dir * dt
      if (lane.dir > 0 && p.x > SEA.width / 2 + 0.05) p.x = -SEA.width / 2 - 0.05
      if (lane.dir < 0 && p.x < -SEA.width / 2 - 0.05) p.x = SEA.width / 2 + 0.05
    }

    // Торпеды: бег по поверхности, хвост «лампочек», попадание/расход.
    for (let i = this.torpedoes.length - 1; i >= 0; i--) {
      const t = this.torpedoes[i]
      const p = t.el.object3D.position
      p.addScaledVector(t.vel, dt)

      if (now - t.lastTrail > TORPEDO.trailEvery) {
        t.lastTrail = now
        this.trailDotAt(p)
      }

      const ship = this.hitShipAt(p)
      if (ship) {
        this.explosionAt(p)
        this.beeper.hit()
        this.sinkShip(ship)
        if (t.el.parentNode) t.el.parentNode.removeChild(t.el)
        this.torpedoes.splice(i, 1)
        continue
      }

      // Дальний край или бок моря — трасса погасла; серия сбита.
      if (p.z < SEA.farZ || Math.abs(p.x) > SEA.width / 2 + 0.1 ||
          now - t.born > TORPEDO.maxRun * 1000) {
        this.splashAt(p)
        this.beeper.expire()
        if (t.el.parentNode) t.el.parentNode.removeChild(t.el)
        this.torpedoes.splice(i, 1)
        if (this.streak > 0) {
          this.streak = 0
          this.updateHud()
        }
      }
    }

    // Чистка эффектов.
    for (let i = this.fx.length - 1; i >= 0; i--) {
      if (now > this.fx[i].until) {
        const el = this.fx[i].el
        if (el.parentNode) el.parentNode.removeChild(el)
        this.fx.splice(i, 1)
      }
    }

    // Конец игры: торпеды исчерпаны, вода пуста, смена волны не идёт.
    if (!this.over && this.torpedoes.length === 0 && this.torps <= 0 &&
        !this.betweenWaves) {
      this.finish()
    }
  },
}
