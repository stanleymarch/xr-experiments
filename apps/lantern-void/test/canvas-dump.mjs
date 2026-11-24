// canvas-dump.mjs — выгрузка всех canvas-текстур LANTERN (VR-меню, панели
// сведений, hover-карточка) в PNG под test/tmp/canvas-dump/: ровность текстур
// проверяется глазами по файлам, а не на словах.
// Запуск: node test/canvas-dump.mjs  (сервер на :8095 должен быть поднят)
import {createRequire} from 'node:module'
import {mkdirSync, writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, join} from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, 'tmp', 'canvas-dump') // tmp/ игнорируется git: PNG не попадают в коммит
mkdirSync(out, {recursive: true})
const require = createRequire('D:/Code/active/xr-experiments/apps/weather-room/package.json')
const {chromium} = require('playwright')

let failed = 0
const check = (name, cond, detail = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
  if (!cond) failed++
}
const save = (name, dataUrl) => {
  if (!dataUrl || !dataUrl.startsWith('data:image/png')) return false
  writeFileSync(join(out, name + '.png'), Buffer.from(dataUrl.split(',')[1], 'base64'))
  return true
}

const b = await chromium.launch()
const page = await b.newPage({viewport: {width: 1366, height: 768}})
// Как в e2e: имитируем гарнитуру, иначе capability-gate прячет VR-кнопку.
await page.addInitScript(`navigator.xr = navigator.xr || {};
  navigator.xr.isSessionSupported = (m) => Promise.resolve(m === 'immersive-vr' || m === 'immersive-ar');`)
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.goto('http://localhost:8095/?seed=140821', {waitUntil: 'domcontentloaded'})
await page.waitForTimeout(2600)
await page.evaluate(() => window.lanternApp.start())
await page.waitForTimeout(400)
await page.click('#xr-button', {timeout: 20000})
await page.waitForFunction(() => document.querySelector('#xr-scene')?.hasLoaded === true, null, {timeout: 60000})
await page.waitForTimeout(2500) // меню построено, шрифты догрузились

// Шапка/инфо меню: два верхних меша-плейна с canvas-текстурой (по убыванию Y).
const chrome = await page.evaluate(() => {
  const s = document.querySelector('#xr-scene')
  const menu = s.querySelector('#xr-context-menu')
  const meshes = []
  menu.object3D.traverse((o) => {
    if (o.isMesh && o.material && o.material.map && o.material.map.image
      && o.material.map.image.tagName === 'CANVAS') meshes.push(o)
  })
  meshes.sort((a, z) => z.position.y - a.position.y)
  return meshes.slice(0, 2).map((o) => o.material.map.image.toDataURL('image/png'))
})
check('шапка меню выгружена', save('menu-header', chrome[0]))
check('инфо-строка меню выгружена', save('menu-info', chrome[1]))

// Кнопки меню: обход мешей меню; действие читается с родительской сущности
// (audit отдаёт только размеры канвасов, не сами канвасы).
const buttons = await page.evaluate(() => {
  const s = document.querySelector('#xr-scene')
  const menu = s.querySelector('#xr-context-menu')
  const found = []
  menu.object3D.traverse((o) => {
    if (o.isMesh && o.material && o.material.map && o.material.map.image
      && o.material.map.image.tagName === 'CANVAS') {
      const el = o.el || (o.parent && o.parent.el)
      found.push({action: (el && el.dataset && el.dataset.xrMenuAction) || `y${+o.position.y.toFixed(3)}`, y: o.position.y, url: o.material.map.image.toDataURL('image/png')})
    }
  })
  found.sort((a, z) => z.y - a.y)
  return found.slice(2) // первые два по Y — шапка и инфо-строка
})
for (let i = 0; i < buttons.length; i++) {
  check(`кнопка меню ${buttons[i].action} выгружена`, save(`menu-btn-${i}-${buttons[i].action}`, buttons[i].url))
}

// Помощь-страница меню: другой набор надписей.
await page.evaluate(() => document.querySelector('#xr-left-controller').dispatchEvent(new CustomEvent('ybuttondown', {bubbles: true})))
await page.waitForTimeout(300)
await page.evaluate(() => {
  const help = [...document.querySelectorAll('[data-xr-menu-action]')].find((e) => e.dataset.xrMenuAction === 'help')
  if (help) help.dispatchEvent(new CustomEvent('click', {bubbles: true}))
})
await page.waitForTimeout(500)
const helpButtons = await page.evaluate(() => {
  const s = document.querySelector('#xr-scene')
  const menu = s.querySelector('#xr-context-menu')
  const found = []
  menu.object3D.traverse((o) => {
    if (o.isMesh && o.material && o.material.map && o.material.map.image
      && o.material.map.image.tagName === 'CANVAS') {
      const el = o.el || (o.parent && o.parent.el)
      found.push({action: (el && el.dataset && el.dataset.xrMenuAction) || `y${+o.position.y.toFixed(3)}`, y: o.position.y, url: o.material.map.image.toDataURL('image/png')})
    }
  })
  found.sort((a, z) => z.y - a.y)
  return found.slice(2)
})
for (let i = 0; i < helpButtons.length; i++) {
  save(`menu-help-btn-${i}-${helpButtons[i].action}`, helpButtons[i].url)
}
check('help-надписи выгружены', helpButtons.length === buttons.length)
await page.evaluate(() => document.querySelector('#xr-right-controller').dispatchEvent(new CustomEvent('bbuttondown', {bubbles: true})))
await page.waitForTimeout(400)

// Панель сведений: прицеливаемся в тело L-01 позой контроллера и жмём триггер
// (тот же путь, что доказан в IWER-тесте), затем дампим panel+hover канвасы.
const picked = await page.evaluate(() => {
  const THREE = window.AFRAME.THREE
  const s = document.querySelector('#xr-scene')
  const ctrl = s.querySelector('#xr-right-controller')
  const body = window.lanternDebug.spatialLayout().find((x) => x.id === 'L-01')
  const origin = new THREE.Vector3(0.16, 1.42, -0.18)
  const dir = new THREE.Vector3(body.x, body.y, body.z).sub(origin).normalize()
  ctrl.object3D.position.copy(origin)
  ctrl.object3D.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir)
  ctrl.object3D.updateMatrix()
  ctrl.dispatchEvent(new CustomEvent('triggerdown', {bubbles: true}))
  return new Promise((res) => setTimeout(() => {
    ctrl.dispatchEvent(new CustomEvent('triggerup', {bubbles: true}))
    res(window.lanternDebug.xrState().selected)
  }, 600))
})
check('тело выбрано для дампа панели', picked === 0, `selected=${picked}`)
await page.waitForTimeout(800)

const panels = await page.evaluate(() => {
  const s = document.querySelector('#xr-scene')
  const found = []
  s.object3D.traverse((o) => {
    if (o.isMesh && o.material && o.material.map && o.material.map.image
      && o.material.map.image.tagName === 'CANVAS' && (o.renderOrder || 0) >= 20) {
      found.push({ro: o.renderOrder, h: +(o.scale.y || 0).toFixed(2), url: o.material.map.image.toDataURL('image/png')})
    }
  })
  return found
})
check('панель сведений выгружена', panels.length >= 1 && save(`panel-selected-ro${panels[0].ro}`, panels[0].url))
if (panels[1]) save(`panel-hover-ro${panels[1].ro}`, panels[1].url)

// Аспекты: canvas должен быть пропорционален плейну — считаем по шейдерам-плоскостям.
const aspects = await page.evaluate(() => {
  const s = document.querySelector('#xr-scene')
  const out = []
  s.object3D.traverse((o) => {
    if (o.isMesh && o.material && o.material.map && o.material.map.image
      && o.material.map.image.tagName === 'CANVAS' && o.geometry && o.geometry.parameters) {
      const {width, height} = o.geometry.parameters
      out.push({
        canvasAR: +(o.material.map.image.width / o.material.map.image.height).toFixed(3),
        planeAR: +(width / height).toFixed(3),
        ro: o.renderOrder || 0,
      })
    }
  })
  // Кнопки меню имеют отдельные label-плейны: считаем и их.
  const menu = s.querySelector('#xr-context-menu')
  menu.object3D.traverse((o) => {
    if (o.isMesh && o.material && o.material.map && o.material.map.image
      && o.material.map.image.tagName === 'CANVAS' && o.geometry && o.geometry.parameters) {
      const {width, height} = o.geometry.parameters
      out.push({
        canvasAR: +(o.material.map.image.width / o.material.map.image.height).toFixed(3),
        planeAR: +(width / height).toFixed(3),
        ro: o.renderOrder || 0,
      })
    }
  })
  return out
})
for (const a of aspects) {
  const ok = Math.abs(a.canvasAR - a.planeAR) / a.planeAR < 0.02
  if (!ok) failed++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] аспект канвас=плейн (ro=${a.ro}): ${a.canvasAR} vs ${a.planeAR}`)
}

check('нет ошибок страницы', errors.length === 0, errors[0] || '')
await b.close()
console.log(failed ? `${failed} провалено; PNG в test/tmp/canvas-dump/` : 'все канвасы выгружены, аспекты сходятся')
process.exit(failed ? 1 : 0)
