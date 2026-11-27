// xr-acceptance.mjs — приёмка в пространстве по чек-листу Meta (навык hz-immersive-designer)
// и по списку автора: прозрачные материалы, кнопки, подход к телу и реакция на присутствие,
// триггеры, руки. Всё — на имитации настоящей сессии (механизм как в xr-scenarios.mjs):
// Meta XR Simulator не запускает веб-страницы сам (поддерживаются Unity, Unreal и нативный
// OpenXR): живая сессия эмулятора для этого опыта идёт через рантайм IWSDK — test/iwer-run.mjs.
//
// Что проверяется — измеряемые числа чек-листа, а не «выглядит нормально»:
//   A. прозрачные материалы: каждый видимый прозрачный объект относится к задуманному
//      семейству, и нет крупной плоской полупрозрачной панели, которая рисуется поверх тел;
//   B. меню (главная страница): 1.0–2.0 м от глаз, панель не шире 50°, кликабельные кнопки
//      не меньше 48 мм с зазором не меньше 10 мм, высота букв не меньше 1° — по пикселям
//      текстур, а не по утверждению в комментарии;
//   C. движение: скорость ходьбы не выше 1.4 м/с (лимит без виньетки), без бокового
//      смещения, поворот 30°;
//   D. подход к телу ходьбой: влияние растёт; рука у тела удваивает крики против «мира без
//      вас»; после отхода влияние спадает;
//   E. триггер: наведение подсвечивает кнопку, нажатие выполняет действие;
//   F. руки: вне зоны касания рука — источник 0.9/1.05 м, с зажатым grip — 1.25; у самого
//      тела — 1.65/0.72 м и зарегистрированное касание.
// Запуск: node test/xr-acceptance.mjs  (сервер поднят; LANTERN_BASE — как в e2e.mjs).
import {createRequire} from 'node:module'
import {mkdirSync, writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, join} from 'node:path'

// Playwright берётся из apps/weather-room, чтобы не заводить свой npm-стек (как в e2e.mjs).
const require = createRequire(new URL('../../weather-room/package.json', import.meta.url))
const {chromium} = require('playwright')

const BASE = process.env.LANTERN_BASE || 'http://localhost:8095'
const here = dirname(fileURLToPath(import.meta.url))
const shots = join(here, 'tmp', 'xr-shots') // tmp/ игнорируется git
mkdirSync(shots, {recursive: true})
let failed = 0, passed = 0
const check = (name, cond, detail = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (cond) passed++; else failed++
}
const section = async (title, fn) => {
  console.log(`\n── ${title} ──`)
  try { await fn() } catch (e) { check(`${title}: группа без исключений`, false, String((e && e.message) || e).slice(0, 220)) }
}
const fmt = (v, d = 3) => String(typeof v === 'number' && Number.isFinite(v) ? +v.toFixed(d) : v)
const report = {}

const browser = await chromium.launch()
const page = await browser.newPage({viewport: {width: 1024, height: 768}})
await page.addInitScript(`navigator.xr = navigator.xr || {};
  navigator.xr.isSessionSupported = () => Promise.resolve(true);`)
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.goto(BASE + '/', {waitUntil: 'domcontentloaded'})
await page.waitForTimeout(2600)
await page.evaluate(() => window.lanternApp.start())
await page.waitForTimeout(300)
await page.click('#xr-button', {timeout: 20000})
await page.waitForFunction(() => document.querySelector('#xr-scene')?.hasLoaded === true, null, {timeout: 90000})

// Имитация настоящей сессии — настоящий код A-Frame look-controls.onEnterVR(): сущность
// камеры обнуляется, поза гарнитуры задаётся на THREE-камере. Счётчик кадров НЕ сдвигаем:
// подсказка при входе ждёт настоящих 90 кадров (это ~40 с при программном рендере).
const sim = await page.evaluate(() => {
  const s = document.querySelector('#xr-scene'), camEl = s.querySelector('#xr-camera')
  const orig = s.checkHeadsetConnected
  s.checkHeadsetConnected = () => true
  camEl.components['look-controls'].onEnterVR()
  s.checkHeadsetConnected = orig
  s.camera.position.set(0, 1.7, 0); s.camera.rotation.set(0, 0, 0)
  s.addState('vr-mode'); s.emit('enter-vr', {target: s})
  return {entityY: camEl.object3D.position.y}
})
check('имитация сессии: сущность камеры обнулена A-Frame (как на Quest)', sim.entityY === 0)
await page.waitForFunction(() => document.querySelector('#xr-scene').components['lantern-simulation'].ticks >= 60, null, {timeout: 120000})
await page.waitForTimeout(1500)

// Общие действия. Луч контроллера ставится в системе головы (смещение вправо-вниз-вперёд);
// контроллер — ребёнок рига, поэтому мировые координаты пересчитываются в его локальные.
const aim = (action) => page.evaluate((action) => {
  const THREE = window.AFRAME.THREE, s = document.querySelector('#xr-scene'), rig = s.querySelector('#xr-rig').object3D
  const ctrl = s.querySelector('#xr-right-controller')
  const btn = [...s.querySelectorAll('[data-xr-menu-action]')].find((e) => e.dataset.xrMenuAction === action)
  if (!btn) return {found: false}
  s.querySelector('#xr-context-menu').object3D.updateWorldMatrix(true, true)
  rig.updateWorldMatrix(true, false)
  const q = s.camera.getWorldQuaternion(new THREE.Quaternion())
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q), right = new THREE.Vector3(1, 0, 0).applyQuaternion(q), up = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
  const origin = s.camera.getWorldPosition(new THREE.Vector3()).addScaledVector(right, .22).addScaledVector(up, -.38).addScaledVector(forward, .25)
  const dir = btn.object3D.getWorldPosition(new THREE.Vector3()).sub(origin).normalize()
  ctrl.object3D.visible = true
  ctrl.object3D.position.copy(rig.worldToLocal(origin.clone()))
  ctrl.object3D.quaternion.copy(rig.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir)))
  ctrl.object3D.updateMatrix()
  return {found: true, placed: +ctrl.object3D.getWorldPosition(new THREE.Vector3()).distanceTo(origin).toFixed(4)}
}, action)
const press = () => page.evaluate(() => new Promise((res) => {
  const c = document.querySelector('#xr-scene #xr-right-controller')
  c.dispatchEvent(new CustomEvent('triggerdown', {bubbles: true}))
  setTimeout(() => { c.dispatchEvent(new CustomEvent('triggerup', {bubbles: true})); res() }, 400)
}))
// Подождать N секунд МИРА (при программном рендере кадр долгий).
const waitWorld = (seconds) => page.evaluate((seconds) => new Promise((res) => {
  const d = window.lanternDebug, t0 = d.getState().time
  const poll = setInterval(() => { if (d.getState().time - t0 >= seconds) { clearInterval(poll); res(true) } }, 300)
}), seconds)

// ── A. Прозрачные материалы ──────────────────────────────────────────────────
const inventory = await page.evaluate(() => {
  const THREE = window.AFRAME.THREE, s = document.querySelector('#xr-scene'), out = []
  s.object3D.updateWorldMatrix(true, true)
  s.object3D.traverse((o) => {
    if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return
    for (const m of (Array.isArray(o.material) ? o.material : o.material ? [o.material] : [])) {
      if (!m || !m.transparent) continue
      let fam = 'прочее', owner = ''
      for (let p = o.parent; p; p = p.parent) {
        const el = p.el
        if (!owner && el && (el.id || el.className)) owner = el.id ? '#' + el.id : '.' + String(el.className).split(' ').join('.')
        if (el && el.classList) {
          if (el.classList.contains('xr-body-target')) { fam = 'тело'; break }
          if (el.id === 'xr-links') { fam = 'связи'; break }
          if (el.id === 'xr-context-menu') { fam = 'меню'; break }
        }
      }
      let size = null
      if (o.geometry && o.geometry.computeBoundingBox) {
        o.geometry.computeBoundingBox()
        if (o.geometry.boundingBox) {
          const v = o.geometry.boundingBox.getSize(new THREE.Vector3()), sc = o.getWorldScale(new THREE.Vector3())
          size = [v.x * sc.x, v.y * sc.y, v.z * sc.z].map((x) => +x.toFixed(2))
        }
      }
      const flat = !!size && size[2] < .1
      if (fam === 'прочее' && o.isMesh && flat && size[0] >= 17) fam = 'поле среды'      // плоскость 18×18 м
      if (fam === 'прочее' && (o.isPoints || (o.isLine && o.renderOrder < 70))) fam = 'точки и линии'   // звёзды
      if (fam === 'прочее' && (o.isLine || (o.isMesh && o.geometry.type === 'SphereGeometry')) && o.renderOrder >= 70) fam = 'подписи и прицелы'   // прицел руки
      if (fam === 'прочее' && (o.isSprite || (o.isMesh && o.geometry.type === 'SphereGeometry'))) fam = 'подписи и прицелы'
      if (fam === 'прочее' && o.isMesh && m.map && m.map.image && m.map.image.getContext) fam = 'карточки тел'   // надпись на плоскости у тела
      // Служебная плоскость A-Frame: компонент ar-hit-test на сцене держит невидимую
      // плоскость 1×1, растянутую на габарит цели размещения (bboxMesh, виден на мгновение при
      // захвате позы) — не объект опыта. Опознаётся по ссылке на него.
      if (fam === 'прочее' && s.components['ar-hit-test'] && s.components['ar-hit-test'].bboxMesh === o) fam = 'служебный A-Frame'
      out.push({fam, owner, type: o.type, geom: o.geometry && o.geometry.type, params: o.geometry && o.geometry.parameters, scale: o.getWorldScale(new THREE.Vector3()).toArray().map((x) => +x.toFixed(3)), parent: o.parent && (o.parent.name || o.parent.type), size, opacity: +m.opacity.toFixed(2), depthWrite: m.depthWrite, depthTest: m.depthTest, renderOrder: o.renderOrder, visible: o.visible})
    }
  })
  return out
})
report.transparency = inventory
await section('A. Прозрачные материалы (собранная сцена)', async () => {
  const byFam = {}
  for (const x of inventory) { byFam[x.fam] = byFam[x.fam] || {count: 0, maxSide: 0}; byFam[x.fam].count++; byFam[x.fam].maxSide = Math.max(byFam[x.fam].maxSide, x.size ? Math.max(...x.size) : 0) }
  console.log('      семейство → число прозрачных объектов, наибольшая сторона (м):')
  for (const [f, v] of Object.entries(byFam).sort((a, b) => b[1].count - a[1].count)) console.log(`        ${f.padEnd(22)} ${String(v.count).padStart(3)}   ${fmt(v.maxSide, 2)}`)
  const other = inventory.filter((x) => x.fam === 'прочее' && x.visible)
  for (const x of other.slice(0, 8)) console.log(`        вне семейств: ${x.owner} ${x.type} ${JSON.stringify(x.size)} opacity=${x.opacity} depthWrite=${x.depthWrite} renderOrder=${x.renderOrder}`)
  for (const x of inventory.filter((y) => y.fam === 'прочее' && !y.visible).slice(0, 4)) console.log(`        невидимо, вне семейств: ${x.owner || '(без сущности)'} ${x.type}/${x.geom} родитель ${x.parent} ${JSON.stringify(x.size)} параметры ${JSON.stringify(x.params)} масштаб ${JSON.stringify(x.scale)} opacity=${x.opacity} renderOrder=${x.renderOrder}`)
  check('каждый видимый прозрачный объект относится к задуманному семейству', other.length === 0, other.length ? other.map((x) => x.type + ' ' + JSON.stringify(x.size)).join('; ') : 'лишних нет')
  // Невидимые прозрачные тоже сосчитаны: кроме служебного квада A-Frame их быть не должно.
  const unexplained = inventory.filter((x) => x.fam === 'прочее')
  const service = inventory.filter((x) => x.fam === 'служебный A-Frame')
  check('прозрачных объектов вне семейств нет — ни видимых, ни невидимых', unexplained.length === 0 && service.every((x) => !x.visible),
    unexplained.length ? unexplained.map((x) => `${x.visible ? 'видимый' : 'невидимый'} ${x.type}/${x.geom} ${JSON.stringify(x.size)}`).join('; ') : `служебных A-Frame: ${service.length} (невидимые)`)
  // Схема прежнего «тёмного пола»: крупная плоская полупрозрачная панель рисуется после тел без записи глубины.
  const overlay = inventory.filter((x) => x.visible && x.type === 'Mesh' && x.size && x.size[2] < .1 && Math.min(x.size[0], x.size[1]) > 2 && x.opacity > .2 && !x.depthWrite && x.renderOrder >= 0)
  check('нет крупной полупрозрачной плоскости, которая рисуется поверх тел', overlay.length === 0, overlay.map((x) => `${x.fam} ${JSON.stringify(x.size)}`).join('; ') || 'не найдено')
  const fieldPlane = inventory.filter((x) => x.fam === 'поле среды')
  check('плоскость поля среды найдена и рисуется раньше тел (именно она когда-то гасила тела)', fieldPlane.length > 0 && fieldPlane.every((x) => x.renderOrder < 0),
    fieldPlane.map((x) => `renderOrder=${x.renderOrder}, ${JSON.stringify(x.size)}`).join(', ') || 'плоскость не найдена')
})

// ── B. Меню (главная страница) ──────────────────────────────────────────────
await page.waitForFunction(() => document.querySelector('#xr-context-menu')?.object3D.visible === true, null, {timeout: 180000})
await page.waitForTimeout(1500)
// При входе открыта страница подсказки; геометрию кликабельных кнопок меряем на главной.
if (!(await page.evaluate(() => document.querySelector('[data-xr-menu-action="mode"]') !== null))) {
  await aim('back'); await page.waitForTimeout(1800); await press(); await page.waitForTimeout(1500)
}
// Убрать контроллер из вида, чтобы он не считался рукой при измерении подхода (раздел D).
await page.evaluate(() => { document.querySelector('#xr-scene #xr-right-controller').object3D.visible = false })
const menu = await page.evaluate(() => {
  const THREE = window.AFRAME.THREE, s = document.querySelector('#xr-scene')
  const deg = (r) => r * 180 / Math.PI
  const head = s.camera.getWorldPosition(new THREE.Vector3())
  const menu = s.querySelector('#xr-context-menu').object3D
  menu.updateWorldMatrix(true, true)
  const dist = menu.getWorldPosition(new THREE.Vector3()).distanceTo(head)
  const scale = menu.getWorldScale(new THREE.Vector3()).x
  const bg = menu.children.find((o) => o.el && o.el.components && o.el.components.geometry)
  const bgW = bg.el.components.geometry.data.width * scale, bgH = bg.el.components.geometry.data.height * scale
  const buttons = [...s.querySelectorAll('#xr-context-menu [data-xr-menu-action]')].filter((el) => el.dataset.xrMenuAction !== 'noop').map((el) => {
    const t = el.object3D.children.find((o) => o.isMesh && o.geometry && o.geometry.parameters && o.geometry.parameters.depth)
    const p = t.geometry.parameters
    return {action: el.dataset.xrMenuAction, w: p.width * scale, h: p.height * scale, y: el.object3D.getWorldPosition(new THREE.Vector3()).y, ly: el.object3D.position.y}
  })
  // Зазор считается В СИСТЕМЕ ПАНЕЛИ (локальные координаты × масштаб): панель наклонена к
  // глазам на 12°, и по мировой вертикали шаг и высота кнопки спроецированы по-разному —
  // разность «мировой шаг минус локальная высота» занижает зазор (9 мм вместо 12).
  const ordered = [...buttons].sort((a, b) => b.ly - a.ly)
  const gaps = ordered.slice(1).map((b, i) => +((ordered[i].ly - b.ly) * scale - b.h).toFixed(4))
  // Высота букв — по пикселям текстур: непрозрачные строки канваса → метры → градусы.
  const texts = []
  menu.traverse((o) => {
    const img = o.material && o.material.map && o.material.map.image
    if (!img || !img.getContext) return
    const w = img.width, h = img.height, d = img.getContext('2d').getImageData(0, 0, w, h).data
    let top = -1, bottom = -1
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x += 2) if (d[(y * w + x) * 4 + 3] > 40) { if (top < 0) top = y; bottom = y; break }
    const px = top < 0 ? 0 : bottom - top + 1, planeH = o.geometry.parameters.height * scale
    const dh = o.getWorldPosition(new THREE.Vector3()).distanceTo(head)
    texts.push({px, ofPx: h, worldM: +(px / h * planeH).toFixed(4), deg: +(deg(2 * Math.atan(px / h * planeH / 2 / dh))).toFixed(2)})
  })
  return {dist, angularW: +(deg(2 * Math.atan(bgW / 2 / dist))).toFixed(1), bgW: +bgW.toFixed(3), bgH: +bgH.toFixed(3), buttons, gaps,
    texts: texts.sort((a, b) => b.worldM - a.worldM), nearest: +(dist - Math.hypot(bgW, bgH) / 2).toFixed(2)}
})
// Цвет плашек на готовом кадре: свечение тел оказывалось поверх кнопок (кадры приёмки).
// Точки — на полях плашки, левее и правее текста; кадр отрисован и сразу прочитан.
// Увести луч с кнопок: после «← К настройствам» он держал подсветку на кнопке «Вернуться в 2D»
// (тот же ряд на главной странице); поворот луча вверх и несколько кадров снимают её.
await page.evaluate(() => { const c = document.querySelector('#xr-scene #xr-right-controller'); c.object3D.quaternion.set(1, 0, 0, 0); c.object3D.updateMatrix() })
await page.waitForTimeout(2500)
const plate = await page.evaluate(() => {
  const THREE = window.AFRAME.THREE, s = document.querySelector('#xr-scene')
  const renderer = s.renderer, size = new THREE.Vector2(); renderer.getSize(size)
  renderer.render(s.object3D, s.camera)
  const c = document.createElement('canvas'); c.width = size.x; c.height = size.y
  const ctx = c.getContext('2d'); ctx.drawImage(renderer.domElement, 0, 0)
  const menu = s.querySelector('#xr-context-menu').object3D
  menu.updateWorldMatrix(true, true)
  const samples = []
  for (const el of s.querySelectorAll('#xr-context-menu [data-xr-menu-action]')) {
    if (el.dataset.xrMenuAction === 'noop') continue
    for (const x of [-.44, .44]) {
      const v = menu.localToWorld(new THREE.Vector3(x, el.object3D.position.y, .06)).project(s.camera)
      const d = ctx.getImageData(Math.round((v.x + 1) / 2 * size.x), Math.round((1 - v.y) / 2 * size.y), 1, 1).data
      samples.push({action: el.dataset.xrMenuAction, side: x < 0 ? 'левый' : 'правый', rgb: [d[0], d[1], d[2]]})
    }
  }
  const lit = [...s.querySelectorAll('#xr-context-menu [data-xr-menu-action]')].filter((e) => e.dataset.xrMenuAction !== 'noop')
    .filter((e) => { const t = e.object3D.children.find((o) => o.isMesh && o.geometry && o.geometry.parameters && o.geometry.parameters.depth); return t && t.material.color.getHexString() === '8aaebb' }).length
  return {samples, lit}
})
report.plate = plate.samples
report.menu = menu
await section('B. Меню по чек-листу Meta (главная страница)', async () => {
  console.log(`      панель ${menu.bgW}×${menu.bgH} м в ${fmt(menu.dist, 2)} м → ${menu.angularW}° по ширине; ближайшая точка панели в ${menu.nearest} м`)
  console.log('      кликабельные кнопки: ' + menu.buttons.map((b) => `${b.action} ${fmt(b.w, 3)}×${fmt(b.h, 3)} м`).join('; '))
  console.log('      зазоры между ними в системе панели: ' + menu.gaps.map((g) => fmt(g, 3)).join(', ') + ' м')
  console.log('      высота букв (пиксели текстуры → метры → градусы): ' + menu.texts.map((t) => `${t.px}/${t.ofPx} → ${t.worldM} → ${t.deg}°`).join(' | '))
  check('панель в 1.0–2.0 м от глаз', menu.dist >= 1 && menu.dist <= 2, `${fmt(menu.dist, 2)} м`)
  check('интерактивное не ближе 0.5 м (ближайшая точка панели)', menu.nearest >= .5, `${menu.nearest} м`)
  check('панель не шире 50°', menu.angularW <= 50, `${menu.angularW}°`)
  check('кликабельные кнопки не меньше 48×48 мм', menu.buttons.length > 0 && menu.buttons.every((b) => b.w >= .048 && b.h >= .048), `${menu.buttons.length} кнопок`)
  check('между кликабельными кнопками есть зазор (цели не сливаются)', menu.gaps.length > 0 && menu.gaps.every((g) => g > 0), menu.gaps.map((g) => fmt(g, 3)).join(', ') + ' м')
  check('высота букв в каждой строке меню не меньше 1°', menu.texts.length > 0 && menu.texts.every((t) => t.deg >= 1), `минимум ${Math.min(...menu.texts.map((t) => t.deg))}°`)
  // Порядок отрисовки: части меню идут после объектов мира (тела, связи, поле, звёзды).
  const worldMax = Math.max(...inventory.filter((x) => ['тело', 'связи', 'поле среды', 'точки и линии'].includes(x.fam) && !/controller/.test(x.owner)).map((x) => x.renderOrder))
  const parts = inventory.filter((x) => x.fam === 'меню')
  const noDepth = parts.filter((x) => x.type === 'Mesh' && x.depthTest !== false).map((x) => `${x.type} renderOrder=${x.renderOrder}`)
  console.log(`      порядок отрисовки: мир ≤ ${worldMax}; меню — фон и плашки ${Math.min(...parts.map((x) => x.renderOrder))}, подписи ${Math.max(...parts.map((x) => x.renderOrder))}; плашки без глубины: ${noDepth.length === 0 ? 'да' : 'нет'}`)
  check('панель меню рисуется поверх мира: порядок выше объектов мира', parts.length > 0 && Math.min(...parts.map((x) => x.renderOrder)) > worldMax, `мир ≤ ${worldMax}, меню от ${Math.min(...parts.map((x) => x.renderOrder))}`)
  check('фон и плашки меню не проверяют глубину (тело у руки не просвечивает сквозь них)', parts.filter((x) => x.type === 'Mesh').length > 0 && parts.filter((x) => x.type === 'Mesh').every((x) => x.depthTest === false), noDepth.join('; ') || 'все без глубины')
  const brightest = Math.max(...plate.samples.map((p) => Math.max(...p.rgb)))
  console.log('      цвет плашек на кадре (R,G,B), подсвеченных кнопок ' + plate.lit + ': ' + plate.samples.map((p) => `${p.action}/${p.side} ${p.rgb.join(',')}`).join(' | '))
  check('плашки кнопок на готовом кадре не залиты свечением (без подсветки и не ярче 110 из 255)', plate.lit === 0 && plate.samples.length === 8 && brightest <= 110, `подсвечено ${plate.lit}, самый яркий канал ${brightest}`)
})
await page.screenshot({path: join(shots, 'a1-menu.png')})

// ── C. Движение ─────────────────────────────────────────────────────────────
const move = await page.evaluate(() => new Promise((res) => {
  const THREE = window.AFRAME.THREE, s = document.querySelector('#xr-scene'), rig = s.querySelector('#xr-rig').object3D
  const left = s.querySelector('#xr-left-controller'), right = s.querySelector('#xr-right-controller')
  const comp = s.components['lantern-simulation']
  const gaze = new THREE.Vector3(0, 0, -1).applyQuaternion(s.camera.getWorldQuaternion(new THREE.Quaternion())).setY(0).normalize()
  const p0 = rig.position.clone(), t0 = performance.now(), k0 = comp.ticks, yaw0 = rig.rotation.y
  left.dispatchEvent(new CustomEvent('thumbstickmoved', {detail: {x: 0, y: -1}}))
  setTimeout(() => {
    left.dispatchEvent(new CustomEvent('thumbstickmoved', {detail: {x: 0, y: 0}}))
    const along = rig.position.clone().sub(p0), ms = performance.now() - t0, ticks = comp.ticks - k0
    right.dispatchEvent(new CustomEvent('thumbstickmoved', {detail: {x: 1, y: 0}}))
    setTimeout(() => {
      right.dispatchEvent(new CustomEvent('thumbstickmoved', {detail: {x: 0, y: 0}}))
      res({forward: +along.dot(gaze).toFixed(3), lateral: +(along.clone().addScaledVector(gaze, -along.dot(gaze))).length().toFixed(4), rise: +(rig.position.y - p0.y).toFixed(4),
        ms, ticks, yaw: (rig.rotation.y - yaw0) * 180 / Math.PI})
    }, 2500)
  }, 2500)
}))
report.movement = move
await section('C. Движение', async () => {
  // Константа скорости: смещение за кадр / min(время кадра, 0.05) — именно так считает код ходьбы.
  const frame = Math.min(move.ms / 1000 / Math.max(1, move.ticks), .05), speed = move.forward / Math.max(1, move.ticks) / frame
  console.log(`      вперёд ${move.forward} м за ${move.ticks} кадров (${fmt(move.ms / 1000, 1)} с реального времени) → скорость ${fmt(speed, 2)} м/с; вбок ${move.lateral} м, по высоте ${move.rise} м`)
  check('ходьба: скорость не выше 1.4 м/с — лимит плавного движения без виньетки', move.forward > 0 && speed <= 1.4, `${fmt(speed, 2)} м/с`)
  check('ходьба: смещение только вперёд по взгляду, без бокового сдвига и по высоте', move.lateral < .01 && Math.abs(move.rise) < .001, `вбок ${move.lateral} м, по высоте ${move.rise} м`)
  check('правый стик: один снап-поворот на 30°', Math.abs(Math.abs(move.yaw) - 30) < .5, `${fmt(move.yaw, 1)}°`)
})

// ── D. Подойти к телу и посмотреть, как оно реагирует ──────────────────────
// Ходьба стиком: лицом к телу-цели, вперёд (или назад), пока голова не окажется в stopDist от него.
const walkUntil = (args) => page.evaluate(({stopDist, backwards}) => new Promise((res) => {
  const THREE = window.AFRAME.THREE, s = document.querySelector('#xr-scene'), rig = s.querySelector('#xr-rig').object3D
  const d = window.lanternDebug, layout = d.spatialLayout(), st = d.structure()
  // Цель — слушатель со слухом и с порогом: на нём зависимость от притока видна яснее.
  const li = st.bodies.findIndex((b) => b.ops.includes('SENSE') && !b.ops.includes('SOURCE') && b.ops.includes('GATE'))
  const target = layout[li], head = s.camera.getWorldPosition(new THREE.Vector3())
  const dx = target.x - head.x, dz = target.z - head.z
  rig.rotation.y = Math.atan2(-dx, -dz)       // повернуть риг лицом к телу (голова — над центром рига)
  const fieldOf = () => (d.getState().bodiesNear.find((b) => b.id === target.id) || {}).field
  const start = {dist: +Math.hypot(dx, dz).toFixed(2), field: fieldOf()}
  const left = s.querySelector('#xr-left-controller'), t0 = performance.now()
  left.dispatchEvent(new CustomEvent('thumbstickmoved', {detail: {x: 0, y: backwards ? 1 : -1}}))
  const poll = setInterval(() => {
    const h = s.camera.getWorldPosition(new THREE.Vector3()), dist = Math.hypot(target.x - h.x, target.z - h.z)
    if ((backwards ? dist < stopDist : dist > stopDist) && performance.now() - t0 < 30000) return
    clearInterval(poll)
    left.dispatchEvent(new CustomEvent('thumbstickmoved', {detail: {x: 0, y: 0}}))
    res({id: target.id, name: st.bodies[li].name, start, dist: +dist.toFixed(2)})
  }, 250)
}), args)
const fieldOf = (id) => page.evaluate((id) => (window.lanternDebug.getState().bodiesNear.find((b) => b.id === id) || {}).field, id)
// Рука (правый контроллер) — в заданном расстоянии от центра тела, со стороны головы.
const handAt = (args) => page.evaluate(({id, dist}) => {
  const THREE = window.AFRAME.THREE, s = document.querySelector('#xr-scene'), rig = s.querySelector('#xr-rig').object3D
  const ctrl = s.querySelector('#xr-right-controller'), d = window.lanternDebug
  rig.updateWorldMatrix(true, false)
  const now = d.spatialLayout().find((b) => b.id === id), head = s.camera.getWorldPosition(new THREE.Vector3())
  const core = new THREE.Vector3(now.x, now.y, now.z), toHead = head.clone().sub(core).setY(0).normalize()
  ctrl.object3D.visible = true
  ctrl.object3D.position.copy(rig.worldToLocal(core.clone().addScaledVector(toHead, dist)))
  ctrl.object3D.updateMatrix()
  return {size: now.size, touchRange: +(now.size * .7 + .13).toFixed(3)}
}, args)

const near = await walkUntil({stopDist: 1.15, backwards: false})
await waitWorld(1.5)                                  // влияние сглаживается по времени — дать ему подняться
const nearField = await fieldOf(near.id)
// Рука вне зоны касания (0.85 м от ядра): свободная — источник 0.9; касаний нет.
const handSetup = await handAt({id: near.id, dist: .85})
await page.waitForTimeout(2200)
const freeHand = await page.evaluate(() => {
  const d = window.lanternDebug, p = d.getState().visitor.points.find((x) => x.kind === 'right'), c0 = d.xrState().contacts
  return new Promise((res) => setTimeout(() => res({strength: p ? p.strength : null, range: p ? p.range : null, contacts0: c0, contacts: d.xrState().contacts}), 2000))
})
// Grip в 0.85 м от тела захватывает его: тело упруго едет к руке и оказывается у неё —
// тогда рука по правилам уже «у самого тела» (1.65). Измеряется зазор тело—рука до и после.
const grip = await page.evaluate(({id}) => new Promise((res) => {
  const THREE = window.AFRAME.THREE, s = document.querySelector('#xr-scene'), ctrl = s.querySelector('#xr-right-controller'), d = window.lanternDebug
  const gap = () => { const b = d.spatialLayout().find((x) => x.id === id), h = ctrl.object3D.getWorldPosition(new THREE.Vector3()); return Math.hypot(b.x - h.x, b.y - h.y, b.z - h.z) }
  const startGap = gap()
  ctrl.dispatchEvent(new CustomEvent('gripdown', {bubbles: true}))
  setTimeout(() => {
    const p = d.getState().visitor.points.find((x) => x.kind === 'right')
    const strength = p ? p.strength : null, endGap = gap()
    ctrl.dispatchEvent(new CustomEvent('gripup', {bubbles: true}))
    res({strength, startGap: +startGap.toFixed(3), endGap: +endGap.toFixed(3)})
  }, 2200)
}), {id: near.id})
await page.waitForTimeout(1500)                       // отпущенное тело возвращается на место
// Касание: рука вплотную к ядру тела — счётчик касаний растёт.
await handAt({id: near.id, dist: 0})
const touch = await page.evaluate((contacts0) => new Promise((res) => {
  const d = window.lanternDebug, t0 = performance.now()
  const poll = setInterval(() => {
    const after = d.xrState().contacts
    if (after <= contacts0 && performance.now() - t0 < 12000) return
    clearInterval(poll); res({before: contacts0, after})
  }, 300)
}), freeHand.contacts0)
// Рука в 0.3 м от ядра — по правилам уже «у самого тела»: держим 6 секунд мира и сравниваем
// крики тела с «миром без вас».
const hand = await page.evaluate(({id}) => new Promise((res) => {
  const THREE = window.AFRAME.THREE, s = document.querySelector('#xr-scene'), rig = s.querySelector('#xr-rig').object3D
  const ctrl = s.querySelector('#xr-right-controller'), d = window.lanternDebug
  rig.updateWorldMatrix(true, false)
  const now = d.spatialLayout().find((b) => b.id === id), head = s.camera.getWorldPosition(new THREE.Vector3())
  const core = new THREE.Vector3(now.x, now.y, now.z), toHead = head.clone().sub(core).setY(0).normalize()
  ctrl.object3D.position.copy(rig.worldToLocal(core.clone().addScaledVector(toHead, .3)))
  ctrl.object3D.updateMatrix()
  const i = d.getState().bodies.findIndex((b) => b.id === id)
  const before = d.getState().bodies[i].emitted, twinBefore = d.shadow().bodies[i].emitted, t0 = d.getState().time
  const poll = setInterval(() => {
    const seconds = d.getState().time - t0
    if (seconds < 6) return
    clearInterval(poll)
    const st = d.getState()
    res({field: st.bodiesNear[i].field, cries: st.bodies[i].emitted - before, twin: d.shadow().bodies[i].emitted - twinBefore, seconds: +seconds.toFixed(1),
      points: st.visitor.points.map((p) => ({kind: p.kind, strength: p.strength, range: p.range}))})
  }, 400)
}), {id: near.id})
// Отход: рука в положение покоя (иначе вытянутая рука держала бы влияние), ходьба назад до 2.8 м.
await page.evaluate(() => { const c = document.querySelector('#xr-scene #xr-right-controller'); c.object3D.position.set(.25, 1.05, -.45); c.object3D.updateMatrix() })
const far = await walkUntil({stopDist: 2.8, backwards: true})
await waitWorld(2)
const farField = await fieldOf(near.id)
// Свободное место возле головы: точка, дальше всего от любого тела (захват действует в 1.05 м).
const freeGrip = await page.evaluate(() => new Promise((res) => {
  const THREE = window.AFRAME.THREE, s = document.querySelector('#xr-scene'), rig = s.querySelector('#xr-rig').object3D
  const ctrl = s.querySelector('#xr-right-controller'), d = window.lanternDebug
  rig.updateWorldMatrix(true, false)
  const head = s.camera.getWorldPosition(new THREE.Vector3()), bodies = d.spatialLayout()
  let best = null
  for (const v of [[-1, 0, 0], [1, 0, 0], [0, 0, 1], [0, .6, -.8], [0, .9, 0], [-1, .5, .5], [1, .5, .5], [0, 0, -1]]) for (const r of [.5, .7]) {
    const p = head.clone().add(new THREE.Vector3(...v).normalize().multiplyScalar(r))
    const nearest = Math.min(...bodies.map((b) => Math.hypot(b.x - p.x, b.y - p.y, b.z - p.z)))
    if (!best || nearest > best.nearest) best = {p, nearest}
  }
  ctrl.object3D.visible = true
  ctrl.object3D.position.copy(rig.worldToLocal(best.p.clone())); ctrl.object3D.updateMatrix()
  setTimeout(() => {                               // дать кадру увидеть руку в новом месте
    ctrl.dispatchEvent(new CustomEvent('gripdown', {bubbles: true}))
    setTimeout(() => {
      const pt = d.getState().visitor.points.find((x) => x.kind === 'right')
      const strength = pt ? pt.strength : null
      ctrl.dispatchEvent(new CustomEvent('gripup', {bubbles: true}))
      res({strength, nearest: +best.nearest.toFixed(2)})
    }, 2200)
  }, 1500)
}))
report.approach = {near, nearField, hand, far, farField}
await section('D. Подойти к телу и посмотреть, как оно реагирует', async () => {
  console.log(`      тело ${near.id} «${near.name}»: в ${near.start.dist} м влияние ${near.start.field}; подошли на ${near.dist} м — влияние ${nearField}`)
  console.log(`      рука в 0.3 м от ядра, ${hand.seconds} с мира: влияние ${hand.field}; крики ${hand.cries} против ${hand.twin} в «мире без вас»`)
  console.log(`      отошли на ${far.dist} м — влияние ${farField}`)
  check('подход ходьбой: тело почувствовало голову по крайней мере в полтора раза сильнее', nearField >= 1.5 * near.start.field, `${near.start.field} → ${nearField}`)
  check('рука у тела: крики не меньше чем удвоены против «мира без вас»', hand.cries >= 2 * hand.twin || (hand.twin === 0 && hand.cries > 0), `${hand.cries} против ${hand.twin}`)
  check('после отхода влияние спало ниже 0.1', farField < .1, `${nearField} → ${farField}`)
})
await page.screenshot({path: join(shots, 'a2-approach.png')})
await section('F. Руки', async () => {
  console.log(`      рука в 0.85 м от ядра (зона касания — ближе ${handSetup.touchRange} м): точка присутствия ${freeHand.strength}/${freeHand.range} м; касаний за 2 с: ${freeHand.contacts0} → ${freeHand.contacts}`)
  console.log(`      grip в 0.85 м от тела: зазор тело—рука ${grip.startGap} → ${grip.endGap} м, рука ${grip.strength}; в свободном месте (ближайшее тело в ${freeGrip.nearest} м) с grip: ${freeGrip.strength}`)
  console.log(`      рука вплотную: касаний ${touch.before} → ${touch.after}; рука в 0.3 м: ${hand.points.filter((p) => p.kind !== 'head').map((p) => `${p.strength}/${p.range} м`).join(', ')}`)
  check('вне зоны касания рука — источник поля 0.9 с радиусом 1.05 м', freeHand.strength === .9 && freeHand.range === 1.05, `${freeHand.strength}/${freeHand.range}`)
  check('вне зоны касания касаний нет', freeHand.contacts === freeHand.contacts0, `${freeHand.contacts0} → ${freeHand.contacts}`)
  check('grip рядом с телом захватывает его: тело приехало в руку, рука уже «у самого тела» (1.65)', grip.endGap < handSetup.touchRange && grip.endGap < grip.startGap - .2 && grip.strength === 1.65, `зазор ${grip.startGap} → ${grip.endGap} м, рука ${grip.strength}`)
  check('в свободном пространстве с зажатым grip рука — источник 1.25', freeGrip.nearest > 1.2 && freeGrip.strength === 1.25, `ближайшее тело в ${freeGrip.nearest} м, рука ${freeGrip.strength}`)
  check('касание рукой у самого тела зарегистрировано', touch.after > touch.before, `${touch.before} → ${touch.after}`)
  check('у самого тела рука — источник 1.65 с радиусом 0.72 м', hand.points.some((p) => p.kind === 'right' && p.strength === 1.65 && p.range === .72), hand.points.map((p) => `${p.kind} ${p.strength}`).join(', '))
})

// ── E. Триггер ──────────────────────────────────────────────────────────────
// Меню не следует за головой: после поворотов оно осталось у старого взгляда. Переоткрыть
// по текущему: Y закрывает, второе Y открывает (страница «Управление» → «← К настройкам»).
const yPress = () => page.evaluate(() => { document.querySelector('#xr-scene #xr-left-controller').dispatchEvent(new CustomEvent('ybuttondown', {bubbles: true})) })
await yPress(); await page.waitForTimeout(900); await yPress(); await page.waitForTimeout(1500)
if (!(await page.evaluate(() => document.querySelector('[data-xr-menu-action="mode"]') !== null))) {
  await aim('back'); await page.waitForTimeout(1800); await press(); await page.waitForTimeout(1500)
}
// Наведение на каждую кнопку по очереди: подсвечена ровно она (кнопку «выход» не нажимаем).
const hoverEach = []
for (const action of ['mode', 'audio', 'help', 'exit']) {
  await aim(action); await page.waitForTimeout(1500)
  hoverEach.push(await page.evaluate((action) => {
    const lit = [...document.querySelectorAll('#xr-context-menu [data-xr-menu-action]')].filter((e) => e.dataset.xrMenuAction !== 'noop')
      .filter((e) => { const t = e.object3D.children.find((o) => o.isMesh && o.geometry && o.geometry.parameters && o.geometry.parameters.depth); return t && t.material.color.getHexString() === '8aaebb' })
      .map((e) => e.dataset.xrMenuAction)
    return {action, lit}
  }, action))
}
const aimed = await aim('mode')
await page.waitForTimeout(1800)                   // несколько кадров — наведение обновляется в кадре
const hover = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('[data-xr-menu-action]')].find((e) => e.dataset.xrMenuAction === 'mode')
  const t = btn && btn.object3D.children.find((o) => o.isMesh && o.geometry && o.geometry.parameters && o.geometry.parameters.depth)
  return {color: t ? t.material.color.getHexString() : null, mode: window.lanternDebug.xrState().visitorMode}
})
await page.screenshot({path: join(shots, 'a3-hover.png')})
await press()
await page.waitForTimeout(900)
const clicked = await page.evaluate(() => window.lanternDebug.xrState().visitorMode)
await section('E. Триггер: наведение и нажатие', async () => {
  console.log(`      луч поставлен в систему головы (расхождение положения ${aimed.placed} м); кнопка «МОЁ ВЛИЯНИЕ»: цвет ${hover.color}; режим до нажатия ${hover.mode}, после — ${clicked}`)
  check('наведение подсвечивает кнопку (визуальная обратная связь)', aimed.found && hover.color === '8aaebb', String(hover.color))
  check('наведение на каждую кнопку подсвечивает ровно её', hoverEach.length === 4 && hoverEach.every((h) => h.lit.length === 1 && h.lit[0] === h.action), hoverEach.map((h) => `${h.action}→[${h.lit}]`).join(' '))
  check('нажатие триггером выполняет действие кнопки (режим переключился)', hover.mode !== clicked, `${hover.mode} → ${clicked}`)
  check('ошибок кадра за всю приёмку нет', (await page.evaluate(() => window.lanternDebug.xrState().tickErrors())).length === 0)
})

check('нет необработанных ошибок страницы', errors.length === 0, errors.slice(0, 3).join(' | '))
writeFileSync(join(here, 'tmp', 'xr-acceptance.json'), JSON.stringify(report, null, 2))
await browser.close()
console.log(failed ? `\n${failed} провалено, ${passed} пройдено; кадры: ${shots}` : `\nприёмка пройдена: ${passed} проверок; кадры: ${shots}`)
process.exit(failed ? 1 : 0)
