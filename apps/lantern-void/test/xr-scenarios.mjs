// xr-scenarios.mjs — сценарии VR на имитации НАСТОЯЩЕЙ XR-сессии.
//
// Почему это ловит то, что не ловил прежний тест: в настоящей сессии A-Frame
// обнуляет сущность #xr-camera (look-controls.onEnterVR: position.set(0,0,0),
// matrixAutoUpdate=false) и применяет позу гарнитуры к внутренней THREE-камере.
// Здесь вызывается именно этот код A-Frame, а поза гарнитуры задаётся камере —
// как делает three.js в XR. Дальше — сценарии и правила Meta (hz-immersive-designer).
//
// Запуск: node test/xr-scenarios.mjs  (сервер на :8095). Скриншоты → tmp/xr-shots/.
import {createRequire} from 'node:module'
import {mkdirSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, join} from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const shots = join(here, 'tmp', 'xr-shots')
mkdirSync(shots, {recursive: true})
const require = createRequire(new URL('../../weather-room/package.json', import.meta.url))
const {chromium} = require('playwright')

let failed = 0
const check = (name, cond, detail = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failed++
}
const deg = (rad) => rad * 180 / Math.PI

const browser = await chromium.launch()
const page = await browser.newPage({viewport: {width: 1024, height: 768}})
await page.addInitScript(`navigator.xr = navigator.xr || {};
  navigator.xr.isSessionSupported = (m) => Promise.resolve(true);`)
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.goto(process.env.LANTERN_BASE || 'http://localhost:8095/', {waitUntil: 'domcontentloaded'})
await page.waitForTimeout(2600)
await page.evaluate(() => window.lanternApp.start())
await page.waitForTimeout(300)
await page.click('#xr-button', {timeout: 20000})
await page.waitForFunction(() => document.querySelector('#xr-scene')?.hasLoaded === true, null, {timeout: 60000})
await page.waitForTimeout(2000)

// --- Имитация настоящей сессии (код A-Frame 1.8.0, see look-controls.onEnterVR). ---
const sim = await page.evaluate((headY) => {
  const s = document.querySelector('#xr-scene')
  const camEl = s.querySelector('#xr-camera')
  const orig = s.checkHeadsetConnected
  s.checkHeadsetConnected = () => true
  camEl.components['look-controls'].onEnterVR()
  s.checkHeadsetConnected = orig
  const cam3 = s.camera
  cam3.position.set(0, headY, 0)
  cam3.rotation.set(0, 0, 0)
  s.addState('vr-mode')
  s.emit('enter-vr', {target: s})
  // Счётчик тиков — только задержка гид-меню/ребейза; в software-рендере 2–3 к/с,
  // поэтому переводим часы вперёд, чтобы не ждать полминуты.
  s.components['lantern-simulation'].ticks = 200
  return {entityY: camEl.object3D.position.y, autoUpdate: camEl.object3D.matrixAutoUpdate, cam3y: +cam3.position.y.toFixed(2)}
}, 1.7)
check('имитация сессии: сущность камеры обнулена A-Frame (как на Quest)', sim.entityY === 0 && sim.autoUpdate === false, JSON.stringify(sim))

// Геометрия меню относительно РЕАЛЬНОЙ головы.
const menuGeometry = () => page.evaluate(() => {
  const THREE = window.AFRAME.THREE
  const deg = (r) => r * 180 / Math.PI
  const s = document.querySelector('#xr-scene')
  const menu = s.querySelector('#xr-context-menu').object3D
  const head = s.camera.getWorldPosition(new THREE.Vector3())
  const c = menu.getWorldPosition(new THREE.Vector3())
  const rel = c.clone().sub(head)
  const dist = rel.length()
  const below = deg(Math.atan2(-rel.y, Math.hypot(rel.x, rel.z)))
  const e = new THREE.Euler().setFromQuaternion(menu.getWorldQuaternion(new THREE.Quaternion()), 'YXZ')
  // Верх и низ фона меню в мировых координатах.
  const bgH = (s.querySelector('#xr-context-menu').firstChild.components.geometry?.data.height || 1.04) * menu.scale.y
  const toAngle = (p) => deg(Math.atan2(-(p.y - head.y), Math.hypot(p.x - head.x, p.z - head.z)))
  const top = toAngle(c.clone().add(new THREE.Vector3(0, bgH / 2, 0)))
  const bottom = toAngle(c.clone().add(new THREE.Vector3(0, -bgH / 2, 0)))
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(menu.getWorldQuaternion(new THREE.Quaternion()))
  const toHead = head.clone().sub(c).normalize()
  const rig = s.querySelector('#xr-rig').object3D
  return {
    visible: menu.visible, dist: +dist.toFixed(2), below: +below.toFixed(1),
    top: +top.toFixed(1), bottom: +bottom.toFixed(1), roll: +deg(e.z).toFixed(1),
    perpendicular: +Math.abs(normal.dot(toHead)).toFixed(3),
    menuY: +c.y.toFixed(2), headY: +head.y.toFixed(2), rigY: +rig.position.y.toFixed(2),
  }
})

// --- Сценарий 1: вход. Гид-меню перед глазами, риг на полу. ---
await page.waitForFunction(() => document.querySelector('#xr-context-menu')?.object3D.visible === true, null, {timeout: 30000})
const g1 = await menuGeometry()
console.log('  гид-меню:', JSON.stringify(g1))
check('гид-меню открылось после входа', g1.visible)
check('риг не задран: стоит на полу (local-floor, голова 1.7 м)', Math.abs(g1.rigY) < 0.01, `rigY=${g1.rigY}`)
check('Meta: панель в 1.0–2.0 м от головы', g1.dist >= 1.0 && g1.dist <= 2.0, `${g1.dist} м`)
check('Meta: центр панели на 10–20° ниже уровня глаз', g1.below >= 10 && g1.below <= 20, `${g1.below}°`)
check('Meta: панель целиком в первичной зоне (от +30° до −30°)', g1.top <= 30 && g1.bottom >= -30, `от ${g1.top}° до ${g1.bottom}°`)
check('Meta: панель без крена', Math.abs(g1.roll) < 1, `roll=${g1.roll}°`)
check('Meta: панель перпендикулярна линии взгляда', g1.perpendicular > 0.99, `dot=${g1.perpendicular}`)
check('меню НЕ под ногами: выше колен', g1.menuY > 0.6, `menuY=${g1.menuY}`)
await page.waitForTimeout(1500)
await page.screenshot({path: join(shots, '01-enter-guide.png')})

// Сим-время идёт, ошибок тика нет (настоящий список — через xrState().tickErrors()).
const t1 = await page.evaluate(() => ({time: window.lanternDebug.getState().time, err: window.lanternDebug.xrState().tickErrors()}))
await page.waitForTimeout(3000)
const t2 = await page.evaluate(() => ({time: window.lanternDebug.getState().time, err: window.lanternDebug.xrState().tickErrors()}))
check('мир живёт в сессии: сим-время растёт', t2.time > t1.time + 0.3, `${t1.time.toFixed(2)} → ${t2.time.toFixed(2)} с`)
check('ошибок тика нет (настоящий список)', t2.err.length === 0, JSON.stringify(t2.err).slice(0, 160))

// --- Сценарий 2: ходьба при ОТКРЫТОМ меню (гид) — не заперта. ---
const walk = await page.evaluate(() => new Promise((res) => {
  const s = document.querySelector('#xr-scene')
  const rig = s.querySelector('#xr-rig').object3D
  const left = s.querySelector('#xr-left-controller')
  const before = rig.position.z
  left.dispatchEvent(new CustomEvent('thumbstickmoved', {detail: {x: 0, y: -1}}))
  setTimeout(() => {
    left.dispatchEvent(new CustomEvent('thumbstickmoved', {detail: {x: 0, y: 0}}))
    res({before: +before.toFixed(3), after: +rig.position.z.toFixed(3), menuOpen: s.querySelector('#xr-context-menu').object3D.visible})
  }, 2500)
}))
check('ходьба работает при открытом меню: стик вперёд двигает риг', walk.after < walk.before - 0.05, `z ${walk.before} → ${walk.after}`)

// --- Сценарий 3: B закрывает меню, Y открывает главное. ---
await page.evaluate(() => document.querySelector('#xr-right-controller').dispatchEvent(new CustomEvent('bbuttondown', {bubbles: true})))
await page.waitForTimeout(500)
check('B закрывает меню', !(await page.evaluate(() => document.querySelector('#xr-context-menu').object3D.visible)))
// Вернуть риг на место и открыть главное меню по Y.
await page.evaluate(() => { document.querySelector('#xr-rig').object3D.position.set(0, 0, 0) })
await page.evaluate(() => document.querySelector('#xr-left-controller').dispatchEvent(new CustomEvent('ybuttondown', {bubbles: true})))
await page.waitForFunction(() => document.querySelector('#xr-context-menu')?.object3D.visible === true, null, {timeout: 10000})
const g3 = await menuGeometry()
check('главное меню (Y): та же зона — 1.0–2.0 м, 10–20° вниз', g3.dist >= 1.0 && g3.dist <= 2.0 && g3.below >= 10 && g3.below <= 20, `${g3.dist} м, ${g3.below}°`)
await page.waitForTimeout(1200)
await page.screenshot({path: join(shots, '02-menu-main.png')})

// --- Сценарий 4: состав меню и клики по кнопкам настоящим путём (луч + триггер). ---
const menuActions = await page.evaluate(() =>
  [...document.querySelectorAll('#xr-context-menu [data-xr-menu-action]')].map((e) => e.dataset.xrMenuAction))
check('в меню четыре кнопки: влияние, звук, управление, выход',
  JSON.stringify(menuActions) === JSON.stringify(['mode', 'audio', 'help', 'exit']), menuActions.join(', '))
check('телепорта в меню нет: движение — ходьба и снап-повороты', !menuActions.includes('locomotion'))
const clickMenuButton = (action) => page.evaluate((action) => {
  const THREE = window.AFRAME.THREE
  const s = document.querySelector('#xr-scene')
  const ctrl = s.querySelector('#xr-right-controller')
  const btn = [...s.querySelectorAll('[data-xr-menu-action]')].find((e) => e.dataset.xrMenuAction === action)
  if (!btn) return 'no-button'
  const menu = s.querySelector('#xr-context-menu').object3D
  menu.updateWorldMatrix(true, true)
  const target = btn.object3D.getWorldPosition(new THREE.Vector3())
  const head = s.camera.getWorldPosition(new THREE.Vector3())
  const origin = head.clone().add(new THREE.Vector3(0.22, -0.38, -0.25))
  const dir = target.clone().sub(origin).normalize()
  ctrl.object3D.position.copy(origin)
  ctrl.object3D.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir)
  ctrl.object3D.updateMatrix()
  return new Promise((res) => setTimeout(() => {
    ctrl.dispatchEvent(new CustomEvent('triggerdown', {bubbles: true}))
    setTimeout(() => {
      ctrl.dispatchEvent(new CustomEvent('triggerup', {bubbles: true}))
      res('clicked')
    }, 400)
  }, 1200))
}, action)
await clickMenuButton('help')
await page.waitForTimeout(600)
check('клик по «КАК УПРАВЛЯТЬ» открывает страницу помощи', await page.evaluate(() => document.querySelector('[data-xr-menu-action="back"]') !== null))
await clickMenuButton('back')
await page.waitForTimeout(600)
check('клик «← К НАСТРОЙКАМ» возвращает главное меню', await page.evaluate(() => document.querySelector('[data-xr-menu-action="mode"]') !== null))
await clickMenuButton('mode')
await page.waitForTimeout(600)
check('кнопка «МОЁ ВЛИЯНИЕ» переключает режим', await page.evaluate(() => window.lanternDebug.xrState().visitorMode === 'observe'), 'perturb → observe')
await clickMenuButton('mode')
await page.waitForTimeout(400)

// --- Сценарий 5: снап-поворот вокруг головы (не вокруг рига). ---
await page.evaluate(() => document.querySelector('#xr-right-controller').dispatchEvent(new CustomEvent('bbuttondown', {bubbles: true})))
await page.waitForTimeout(400)
const snap = await page.evaluate(() => new Promise((res) => {
  const s = document.querySelector('#xr-scene')
  const rig = s.querySelector('#xr-rig').object3D
  // Голова не в центре рига (человек отошёл): real camera xz = (0.4, -0.3).
  s.camera.position.set(0.4, 1.7, -0.3)
  rig.updateWorldMatrix(true, true)
  s.camera.updateWorldMatrix(true, false)
  const before = s.camera.getWorldPosition(new window.AFRAME.THREE.Vector3())
  const yaw0 = rig.rotation.y
  s.querySelector('#xr-right-controller').dispatchEvent(new CustomEvent('thumbstickmoved', {detail: {x: 1, y: 0}}))
  rig.updateWorldMatrix(true, true)
  s.camera.updateWorldMatrix(true, false)
  const after = s.camera.getWorldPosition(new window.AFRAME.THREE.Vector3())
  setTimeout(() => s.querySelector('#xr-right-controller').dispatchEvent(new CustomEvent('thumbstickmoved', {detail: {x: 0, y: 0}})), 200)
  res({deg: +((rig.rotation.y - yaw0) * 180 / Math.PI).toFixed(1), shift: +before.distanceTo(after).toFixed(4)})
}))
check('снап-поворот: 30° за шаг', Math.abs(Math.abs(snap.deg) - 30) < 0.5, `${snap.deg}°`)
check('снап-поворот не уносит голову с места', snap.shift < 0.02, `сдвиг головы ${snap.shift} м`)
// После поворота ходьба — уже в новом направлении взгляда.
const walk2 = await page.evaluate(() => new Promise((res) => {
  const s = document.querySelector('#xr-scene')
  const rig = s.querySelector('#xr-rig').object3D
  const left = s.querySelector('#xr-left-controller')
  const p0 = rig.position.clone()
  left.dispatchEvent(new CustomEvent('thumbstickmoved', {detail: {x: 0, y: -1}}))
  setTimeout(() => {
    left.dispatchEvent(new CustomEvent('thumbstickmoved', {detail: {x: 0, y: 0}}))
    res(+p0.distanceTo(rig.position).toFixed(2))
  }, 2000)
}))
check('после поворота ходьба идёт по взгляду', walk2 > 0.05, `сдвиг ${walk2} м`)

// --- Сценарий 7: выбор тела лучом; карточка у тела, не у пола. ---
await page.evaluate(() => document.querySelector('#xr-left-controller').dispatchEvent(new CustomEvent('ybuttondown', {bubbles: true})))
await page.waitForTimeout(400) // закрыть меню, если открылось
await page.evaluate(() => { if (document.querySelector('#xr-context-menu').object3D.visible) document.querySelector('#xr-left-controller').dispatchEvent(new CustomEvent('ybuttondown', {bubbles: true})) })
await page.waitForTimeout(400)
const sel = await page.evaluate(() => {
  const THREE = window.AFRAME.THREE
  const s = document.querySelector('#xr-scene')
  const ctrl = s.querySelector('#xr-right-controller')
  const b = window.lanternDebug.spatialLayout().find((x) => x.id === 'L-01')
  const head = s.camera.getWorldPosition(new THREE.Vector3())
  const origin = head.clone().add(new THREE.Vector3(0.22, -0.38, -0.25))
  const dir = new THREE.Vector3(b.x, b.y, b.z).sub(origin).normalize()
  ctrl.object3D.position.copy(origin)
  ctrl.object3D.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir)
  ctrl.object3D.updateMatrix()
  return new Promise((res) => setTimeout(() => {
    ctrl.dispatchEvent(new CustomEvent('triggerdown', {bubbles: true}))
    setTimeout(() => {
      ctrl.dispatchEvent(new CustomEvent('triggerup', {bubbles: true}))
      const label = [...s.object3D.children].find((o) => o.isMesh && o.renderOrder === 22 && o.visible)
      res({selected: window.lanternDebug.xrState().selected, labelY: label ? +label.position.y.toFixed(2) : null})
    }, 500)
  }, 1200))
})
check('триггер по телу выбирает ближайшее тело на луче', sel.selected >= 0, `selected=${sel.selected}`)
check('карточка тела — у тела, не у пола', sel.labelY !== null && sel.labelY > 1.0, `labelY=${sel.labelY}`)
await page.waitForTimeout(900)
await page.screenshot({path: join(shots, '03-body-selected.png')})

// --- Сценарий 8: взгляд вниз — под ногами ничего нет. ---
await page.evaluate(() => { const c = document.querySelector('#xr-scene').camera; c.rotation.set(-Math.PI / 5, 0, 0) })
await page.waitForTimeout(1200)
await page.screenshot({path: join(shots, '04-look-down.png')})
await page.evaluate(() => { document.querySelector('#xr-scene').camera.rotation.set(0, 0, 0) })

// --- Сценарий 9: референс без пола (голова ≈ 0) — риг поднимается на 1.65. ---
// Требуется 60 кадров подряд с низкой головой; на софтверном рендере это десятки
// секунд — поэтому ждём флаг rebased, а не фиксированное время.
const noFloor = await page.evaluate(() => {
  const s = document.querySelector('#xr-scene')
  const rig = s.querySelector('#xr-rig').object3D
  const comp = s.components['lantern-simulation']
  s.camera.position.set(0, 0.05, 0)
  comp.rebased = false
  return new Promise((res) => {
    const done = () => res({rigY: +rig.position.y.toFixed(2), headY: +s.camera.getWorldPosition(new window.AFRAME.THREE.Vector3()).y.toFixed(2)})
    const poll = setInterval(() => { if (comp.rebased) { clearInterval(poll); setTimeout(done, 200) } }, 500)
    setTimeout(() => { clearInterval(poll); done() }, 120000)
  })
})
check('референс-спейс без пола: риг поднят, голова на 1.65–1.7 м', noFloor.rigY > 1.5 && noFloor.headY > 1.6 && noFloor.headY < 1.75, JSON.stringify(noFloor))

// Наличие правильного, а не только отсутствие ошибок: NaN в радиусе, угле или матрице не
// даёт исключения — тело просто исчезает. Проверяются конечные числа во всех объектах тел.
const finiteXr = await page.evaluate(() => {
  const s = document.querySelector('#xr-scene'), out = {bodies: 0, objects: 0, bad: []}
  s.querySelectorAll('.xr-body-target').forEach((el) => {
    out.bodies++
    el.object3D.traverse((o) => {
      out.objects++
      const flags = []
      if (!o.position.toArray().every(Number.isFinite)) flags.push('position')
      if (!o.quaternion.toArray().every(Number.isFinite)) flags.push('quaternion')
      if (!o.scale.toArray().every(Number.isFinite)) flags.push('scale')
      if (!o.matrixWorld.elements.every(Number.isFinite)) flags.push('matrixWorld')
      const pos = o.geometry && o.geometry.attributes && o.geometry.attributes.position
      if (pos && !pos.array.every(Number.isFinite)) flags.push('geometry')
      if (flags.length && out.bad.length < 8) out.bad.push(`${el.id || el.className}/${o.type}: ${flags.join('+')}`)
    })
  })
  return out
})
check('в телах нет нечисловых значений (положения, вращения, масштабы, матрицы, геометрия)', finiteXr.bodies > 0 && finiteXr.bad.length === 0,
  `${finiteXr.objects} объектов в ${finiteXr.bodies} телах${finiteXr.bad.length ? ': ' + finiteXr.bad.join(' | ') : ''}`)

check('нет необработанных ошибок страницы', errors.length === 0, errors[0] || '')
await browser.close()
console.log(failed ? `\n${failed} провалено; скриншоты: ${shots}` : `\nвсе сценарии пройдены; скриншоты: ${shots}`)
process.exit(failed ? 1 : 0)
