// first-entry.mjs — первые секунды в шлеме, как на устройстве.
//
// Почему отдельный набор: остальные тесты ставят позу гарнитуры заранее и двигают
// счётчик кадров вручную — это удобно для геометрии, но скрывает всё, что происходит
// между входом в сессию и приходом первой позы. Здесь то, что делает настоящий шлем:
//   1. Сцена открыта, кадры идут БЕЗ сессии.
//   2. Сессия начинается: сущность камеры обнулена (A-Frame), а поза гарнитуры ещё
//      НЕ применена — three.js применяет её только в рендере, через несколько кадров.
//   3. Поза приходит.
// И три требования к этим секундам:
//   (a) меню не открывается по нулевой позе и не оказывается на полу; риг не взлетает;
//   (b) плоскость поля не гасит тела и не рисует тёмную «стену»;
//   (c) «AR в комнате» входит в AR, «VR-мир» — в VR, и системная кнопка только одна.
// Запуск: LANTERN_BASE=http://localhost:8101 node test/first-entry.mjs
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

const browser = await chromium.launch()
const page = await browser.newPage({viewport: {width: 1024, height: 768}})
await page.addInitScript(`navigator.xr = navigator.xr || {};
  navigator.xr.isSessionSupported = () => Promise.resolve(true);`)
const errors = []
page.on('pageerror', (e) => {
  const stack = String(e.stack || '')
  const frame = stack.split('\n').slice(1, 4).join(' | ')
  errors.push(e.message + ' @ ' + frame.slice(0, 420))
})
await page.goto(process.env.LANTERN_BASE || 'http://localhost:8095/', {waitUntil: 'domcontentloaded'})
await page.waitForTimeout(2600)
await page.evaluate(() => window.lanternApp.start())
await page.waitForTimeout(300)
await page.click('#xr-button', {timeout: 20000})
await page.waitForFunction(() => document.querySelector('#xr-scene')?.hasLoaded === true, null, {timeout: 60000})

// 1. Кадры идут без сессии — как пока гарнитура ещё не вошла.
await page.waitForFunction(() => document.querySelector('#xr-scene').components['lantern-simulation'].ticks >= 150, null, {timeout: 120000})

// 2. Сессия начинается; позы ещё нет (камера в нуле).
const entered = await page.evaluate(() => {
  const s = document.querySelector('#xr-scene')
  const camEl = s.querySelector('#xr-camera')
  const orig = s.checkHeadsetConnected
  s.checkHeadsetConnected = () => true
  camEl.components['look-controls'].onEnterVR()   // настоящий код A-Frame: сущность → (0,0,0)
  s.checkHeadsetConnected = orig
  s.camera.position.set(0, 0, 0)                   // гарнитура ещё не прислала позу
  s.camera.rotation.set(0, 0, 0)
  s.addState('vr-mode')
  s.emit('enter-vr', {target: s})
  return s.components['lantern-simulation'].ticks
})

// 3. Десяток кадров с нулевой позой: ничего не должно открыться и не должно взлететь.
const startTicks = entered
await page.waitForFunction((from) => document.querySelector('#xr-scene').components['lantern-simulation'].ticks >= from + 12, entered, {timeout: 60000})
const early = await page.evaluate(() => {
  const s = document.querySelector('#xr-scene')
  return {
    ticks: s.components['lantern-simulation'].ticks,
    menu: s.querySelector('#xr-context-menu').object3D.visible,
    rigY: +s.querySelector('#xr-rig').object3D.position.y.toFixed(3),
    errs: window.lanternDebug.xrState().tickErrors(),
  }
})
check('(a) во время нулевой позы меню ещё закрыто', early.menu === false, `кадр ${early.ticks}, вход был на ${startTicks}`)
check('(a) во время нулевой позы риг не взлетел', Math.abs(early.rigY) < 0.001, `rigY=${early.rigY}`)

// 4. Поза пришла — как от настоящей гарнитуры.
await page.evaluate(() => { const c = document.querySelector('#xr-scene').camera; c.position.set(0, 1.7, 0) })

// 5. Меню открывается не раньше 90 кадров после входа — и по настоящей голове.
await page.waitForFunction(() => document.querySelector('#xr-context-menu')?.object3D.visible === true, null, {timeout: 150000})
const menu = await page.evaluate(() => {
  const THREE = window.AFRAME.THREE
  const s = document.querySelector('#xr-scene')
  const m = s.querySelector('#xr-context-menu').object3D
  const head = s.camera.getWorldPosition(new THREE.Vector3())
  const rel = m.getWorldPosition(new THREE.Vector3()).sub(head)
  const deg = (r) => r * 180 / Math.PI
  return {
    after: s.components['lantern-simulation'].ticks,
    dist: +rel.length().toFixed(2), below: +deg(Math.atan2(-rel.y, Math.hypot(rel.x, rel.z))).toFixed(1),
    y: +m.position.y.toFixed(2), rigY: +s.querySelector('#xr-rig').object3D.position.y.toFixed(3),
  }
})
check('(a) меню открылось не раньше 90 кадров после входа в сессию', menu.after - startTicks >= 90, `открыто на ${(menu.after - startTicks)}-м кадре после входа`)
check('(a) первое меню — по настоящей голове: 1.0–2.0 м, на 10–20° ниже глаз, не на полу',
  menu.dist >= 1 && menu.dist <= 2 && menu.below >= 10 && menu.below <= 20 && menu.y > 0.6 && menu.y < 2.2,
  `${menu.dist} м, ${menu.below}°, y=${menu.y}`)
check('(a) риг на полу (система с полом)', Math.abs(menu.rigY) < 0.001, `rigY=${menu.rigY}`)
await page.waitForTimeout(1500)
await page.screenshot({path: join(shots, '10-first-entry-menu.png')})

// 6. Плоскость поля: рисуется первой, без сплошной заливки.
const floor = await page.evaluate(() => {
  const s = document.querySelector('#xr-scene')
  const planes = s.object3D.children.filter((o) => o.isMesh && o.geometry && o.geometry.parameters
    && o.geometry.parameters.width === 18 && o.geometry.parameters.height === 18)
  const bodyOrders = []
  s.querySelectorAll('.xr-body-target').forEach((el) => el.object3D.traverse((o) => { if (o.isMesh || o.isPoints || o.isLine) bodyOrders.push(o.renderOrder) }))
  const f = planes[0]
  if (!f) return {found: false}
  const c = f.material.map && f.material.map.image
  let cornerAlpha = null
  if (c && c.getContext) cornerAlpha = c.getContext('2d').getImageData(2, 2, 1, 1).data[3]
  return {found: true, renderOrder: f.renderOrder, minBodyOrder: bodyOrders.length ? Math.min(...bodyOrders) : 0,
    opacity: f.material.opacity, cornerAlpha, solid: f.material.transparent}
})
check('(b) плоскость поля есть и рисуется раньше тел', floor.found && floor.renderOrder < 0 && floor.renderOrder < floor.minBodyOrder,
  floor.found ? `renderOrder=${floor.renderOrder}, тела от ${floor.minBodyOrder}` : 'не найдена')
check('(b) у плоскости поля нет сплошной заливки (угол канваса прозрачен)', floor.found && floor.cornerAlpha === 0,
  floor.found ? `alpha угла=${floor.cornerAlpha}` : '')
check('(b) плоскость поля прозрачна', floor.found && floor.solid === true)
// Взгляд чуть вниз на тела: тела яркие, тёмной стены нет.
await page.evaluate(() => { const c = document.querySelector('#xr-scene').camera; c.rotation.set(-0.32, 0, 0) })
await page.waitForTimeout(1500)
await page.screenshot({path: join(shots, '11-floor-field.png')})
await page.evaluate(() => { const c = document.querySelector('#xr-scene').camera; c.rotation.set(0, 0, 0) })

check('ошибок кадров за первый вход нет', early.errs.length === 0 && (await page.evaluate(() => window.lanternDebug.xrState().tickErrors().length)) === 0,
  JSON.stringify(early.errs).slice(0, 140))

// 7. Выход; счётчики вызовов входа в сессию.
await page.click('#xr-back-button')
await page.waitForTimeout(600)
await page.evaluate(() => {
  window.__enter = {ar: 0, vr: 0}
  const s = document.querySelector('#xr-scene')
  for (const name of ['enterAR', 'enterVR']) {
    const orig = s[name].bind(s)
    s[name] = (...args) => { window.__enter[name === 'enterAR' ? 'ar' : 'vr']++; try { const p = orig(...args); if (p && p.catch) p.catch(() => {}); return p } catch (e) { return Promise.reject(e) } }
  }
})
const visibleEntryButtons = () => page.evaluate(() => {
  const vis = (b) => !!b.offsetParent || getComputedStyle(b).display !== 'none'
  return {
    vr: [...document.querySelectorAll('.a-enter-vr-button')].filter(vis).length,
    ar: [...document.querySelectorAll('.a-enter-ar-button')].filter(vis).length,
  }
})

// 8. «AR в комнате» → только AR.
await page.evaluate(() => document.getElementById('ar-button').click())
await page.waitForTimeout(2500)
const ar = await page.evaluate(() => {
  const s = document.querySelector('#xr-scene')
  const vis = (b) => !!b.offsetParent || getComputedStyle(b).display !== 'none'
  return {calls: {...window.__enter},
    vrVisible: [...document.querySelectorAll('.a-enter-vr-button')].filter(vis).length,
    arVisible: [...document.querySelectorAll('.a-enter-ar-button')].filter(vis).length}
})
check('(c) «AR в комнате»: сессия запрошена как AR (enterAR вызван; внутри он делегирует enterVR(true))', ar.calls.ar >= 1, JSON.stringify(ar.calls))
check('(c) «AR в комнате»: обе системные кнопки не видны одновременно', !(ar.vrVisible > 0 && ar.arVisible > 0), `видимых: VR ${ar.vrVisible}, AR ${ar.arVisible}`)

// 9. «VR-мир» → только VR (повторный вход: сцена уже загружена).
await page.click('#xr-back-button')
await page.waitForTimeout(600)
const before = await page.evaluate(() => ({...window.__enter}))
await page.evaluate(() => document.getElementById('xr-button').click())
await page.waitForTimeout(2500)
const vr = await page.evaluate(() => {
  const s = document.querySelector('#xr-scene')
  const vis = (b) => !!b.offsetParent || getComputedStyle(b).display !== 'none'
  return {calls: {...window.__enter},
    vrVisible: [...document.querySelectorAll('.a-enter-vr-button')].filter(vis).length,
    arVisible: [...document.querySelectorAll('.a-enter-ar-button')].filter(vis).length}
})
check('(c) «VR-мир»: сессия запрошена как VR', vr.calls.vr > before.vr, `${JSON.stringify(before)} → ${JSON.stringify(vr.calls)}`)
check('(c) «VR-мир»: обе системные кнопки не видны одновременно', !(vr.vrVisible > 0 && vr.arVisible > 0), `видимых: VR ${vr.vrVisible}, AR ${vr.arVisible}`)

check('нет необработанных ошибок страницы', errors.length === 0, errors[0] || '')
await browser.close()
console.log(failed ? `\n${failed} провалено; скриншоты: ${shots}` : `\nпервый вход пройден; скриншоты: ${shots}`)
process.exit(failed ? 1 : 0)
