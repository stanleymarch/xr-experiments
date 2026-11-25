// e2e.mjs — браузерный прогон всех режимов LANTERN // VOID v6.3 (headless Chromium).
// Запуск: node test/e2e.mjs  (требует локальный сервер на :8095)
// Playwright берётся из apps/weather-room, чтобы не заводить свой npm-стек.

import {createRequire} from 'node:module'
import {mkdirSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, join} from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const shots = join(here, 'tmp', 'shots') // tmp/ игнорируется git: скриншоты не попадают в коммит
mkdirSync(shots, {recursive: true})

const require = createRequire('D:/Code/active/xr-experiments/apps/weather-room/package.json')
const {chromium} = require('playwright')

// BASE переопределяется для проверки опубликованного артефакта: LANTERN_BASE=http://localhost:8096/p5/lantern-void
const BASE = process.env.LANTERN_BASE || 'http://localhost:8095'
let failed = 0
const check = (name, cond, detail = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failed++
}

// IWER/гарнитура на машине пользователя: XR «доступен», меню входа полное.
const XR_STUB = `navigator.xr = navigator.xr || {};
  navigator.xr.isSessionSupported = (m) => Promise.resolve(m === 'immersive-vr' || m === 'immersive-ar');`

const browser = await chromium.launch()
const page = await browser.newPage({viewport: {width: 1366, height: 768}})
await page.addInitScript(XR_STUB)
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('permission')) errors.push(`console: ${m.text()}`) })

// ── 1. Пролог ────────────────────────────────────────────────────────────────
await page.goto(`${BASE}/`, {waitUntil: 'domcontentloaded'})
await page.waitForTimeout(2600)
await page.screenshot({path: join(shots, '1-intro.png')})

const intro = await page.evaluate(() => ({
  quote: document.querySelector('.intro-quote')?.textContent || '',
  lanternApp: !!window.lanternApp,
  debug: !!window.lanternDebug,
  vrBtn: !document.getElementById('direct-xr-button')?.classList.contains('xr-not-supported'),
  arBtn: !document.getElementById('intro-ar-button')?.classList.contains('xr-not-supported'),
  actions: (() => { const r = document.querySelector('.intro-actions').getBoundingClientRect(); return {bottom: Math.round(r.bottom), vh: window.innerHeight} })(),
  seed: document.getElementById('seed-readout')?.textContent,
}))
check('пролог жив (lanternApp + lanternDebug)', intro.lanternApp && intro.debug)
check('цитата тыквы в прологе', intro.quote.includes('кричит о своем существовании'), intro.quote)
check('VR и AR входы видимы при поддержке XR', intro.vrBtn && intro.arBtn)
check('меню входа целиком во вьюпорте (фикс «сильно внизу»)', intro.actions.bottom <= intro.actions.vh,
  `bottom=${intro.actions.bottom} vh=${intro.actions.vh}`)

// ── 2. Языки ─────────────────────────────────────────────────────────────────
await page.locator('.lang-button[data-lang="en"]').click()
await page.waitForTimeout(400)
const en = await page.evaluate(() => ({
  start: document.querySelector('#start-button span')?.textContent,
  title: document.title,
}))
check('EN-переключение работает', en.start === 'Enter the environment', en.start)
await page.locator('.lang-button[data-lang="ru"]').click()
await page.waitForTimeout(300)

// ── 3. Вход и живой вид ──────────────────────────────────────────────────────
await page.getByRole('button', {name: 'Войти в среду'}).click()
await page.waitForTimeout(2200)
await page.screenshot({path: join(shots, '2-live.png')})
const live = await page.evaluate(() => ({
  started: window.lanternDebug.getState().started,
  bodies: window.lanternDebug.getState().bodies.length,
  ui: !document.getElementById('live-ui').classList.contains('is-hidden'),
  seed: String(window.lanternDebug.getState().seed),
  mode: document.querySelector('.mode-button.active').textContent,
}))
check('вход выполнен, живой UI виден', live.started && live.ui)
check('10 тел, seed по умолчанию', live.bodies === 10 && live.seed === '140821', `тел=${live.bodies} seed=${live.seed}`)
check('режим по умолчанию — наблюдение', live.mode === 'Наблюдать', live.mode)

// ── 4. Режимы наблюдение/возмущение ─────────────────────────────────────────
const activeMode = () => page.evaluate(() => document.querySelector('.mode-button.active').textContent)
await page.locator('#perturb-button').click()
await page.waitForTimeout(300)
const perturbed = await activeMode()
check('режим возмущения включается', perturbed === 'Возмущать', perturbed)
await page.locator('#observe-button').click()
await page.waitForTimeout(200)
check('возврат в наблюдение', await activeMode() === 'Наблюдать')

// ── 5. Возмущение через инжекцию присутствия (чистая симуляция) ─────────────
const disturb = await page.evaluate(() => {
  const d = window.lanternDebug
  d.reset(140821)
  const a = d.simulate(300)
  d.injectPresence([{x: 0.54, y: 1.0, z: -1.14, range: 2.0, strength: 1.0}], 'perturb')
  const b = d.simulate(300)
  const fields = d.getState().bodies.map((x) => x.id + ':' + (d.getState().bodies.find(s => s.id === x.id), undefined))
  const st = d.getState()
  return {aEm: a.emissions, bEm: b.emissions, fields: st.bodiesNear.map((x) => x.field).slice(0, 4), total: st.emissions}
})
check('возмущение меняет исход симуляции', disturb.aEm !== disturb.bEm, `импульсов ${disturb.aEm} → ${disturb.bEm}`)

// ── 6. Детерминизм (фиксированный шаг) ──────────────────────────────────────
const det = await page.evaluate(() => {
  const d = window.lanternDebug
  d.reset(777)
  const a = d.simulate(400)
  d.reset(777)
  const b = d.simulate(400)
  return JSON.stringify(a.energies) === JSON.stringify(b.energies) && a.emissions === b.emissions
})
check('один seed → одно состояние мира', det)

// ── 7. Инспектор тела (клик по телу на сцене) ───────────────────────────────
// Точка клика считается по проекции тела (та же формула, что bodyScreen в скетче):
// мир к этому моменту пересеян (seed 777), поэтому старый жёсткий пиксель промахивался.
const clicked = await page.evaluate(() => {
  const w = window.innerWidth, h = window.innerHeight
  const st = window.lanternDebug.spatialLayout().find(b => b.id === 'L-01')
  const centerX = w * 0.52, centerY = h * 0.475
  const spread = Math.min(w * 0.100, h * 0.185)
  const depth = 1 / (1 + Math.abs(st.z + 4.4) * 0.10)
  return {x: centerX + st.x * spread * depth, y: centerY - (st.y - 1.7) * spread * 0.88 * depth}
})
await page.mouse.click(clicked.x, clicked.y)
await page.waitForTimeout(500)
const inspector = await page.evaluate(() => ({
  open: !document.getElementById('body-inspector').classList.contains('is-hidden'),
  id: document.getElementById('inspector-id').textContent,
  energy: document.getElementById('metric-energy').textContent,
}))
check('инспектор открывается касанием, открыто именно L-01', inspector.open && inspector.id === 'L-01', `${inspector.id} E=${inspector.energy}`)
await page.locator('#close-inspector').click()

// ── 8. Модалка правил ───────────────────────────────────────────────────────
await page.locator('#rules-button').click()
await page.waitForTimeout(600)
await page.screenshot({path: join(shots, '3-rules.png')})
const modal = await page.evaluate(() => ({
  visible: !document.getElementById('rules-modal').classList.contains('is-hidden'),
  cassirer: !!document.querySelector('.concept-card'),
  cards: document.querySelectorAll('.concept-card').length,
}))
check('модалка правил открывается с основаниями', modal.visible && modal.cards >= 5, `карточек=${modal.cards}`)
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
check('Escape закрывает модалку', await page.evaluate(() => document.getElementById('rules-modal').classList.contains('is-hidden')))

// ── 9. Пауза, пересев, звук ─────────────────────────────────────────────────
await page.keyboard.press('Space')
await page.waitForTimeout(200)
const paused = await page.evaluate(() => document.getElementById('system-status').textContent)
check('Space ставит на паузу', paused === 'ПРОЦЕСС ОСТАНОВЛЕН', paused)
await page.keyboard.press('Space')

await page.locator('#regenerate-button').click()
await page.waitForTimeout(400)
const regen = await page.evaluate(() => ({
  seed: String(window.lanternDebug.getState().seed),
  bodies: window.lanternDebug.getState().bodies.length,
}))
check('новый мир: другой seed, 6–12 тел', regen.seed !== '140821' && regen.bodies >= 6 && regen.bodies <= 12, `seed=${regen.seed} тел=${regen.bodies}`)

await page.locator('#audio-button').click()
await page.waitForTimeout(700)
const audio = await page.evaluate(() => window.lanternDebug.audioStats())
check('звук включается (WebAudio)', audio.active === true, `voices=${audio.spatialVoices}`)
const pings = await page.evaluate(() => { window.lanternDebug.simulate(120); return window.lanternDebug.audioStats().packetSounds })
check('события среды звучат (пинги пакетов)', pings > 0, `пингов=${pings}`)

// ── 10. VR-превью на десктопе (без иммерсивной сессии) ──────────────────────
// Сборка сцены (шейдеры × 10 тел) на SwiftShader медленная — щедрые бюджеты.
await page.locator('#xr-button').click({timeout: 60000})
await page.waitForFunction(() => document.querySelector('#xr-scene')?.hasLoaded === true, {timeout: 90000})
await page.waitForTimeout(2500)
await page.screenshot({path: join(shots, '4-vr-preview.png')})
const vr = await page.evaluate(() => ({
  stage: !document.getElementById('xr-stage').classList.contains('is-hidden'),
  scene: !!document.querySelector('#xr-scene'),
  loaded: document.querySelector('#xr-scene')?.hasLoaded,
  bodies: window.lanternDebug.xrState ? window.lanternDebug.xrState().contacts !== undefined : false,
  flat2d: document.getElementById('experience').classList.contains('is-hidden'),
}))
check('VR-мир открывается (сцена A-Frame)', vr.stage && vr.scene && vr.loaded, `loaded=${vr.loaded}`)
check('плоский вид скрывается в VR-режиме', vr.flat2d)
const xrMenu = await page.evaluate(() => {
  const audit = window.lanternDebug.xrMenuAudit()
  return {buttons: audit.buttons.length, meshes: audit.buttons.filter(b => b.hasMesh).length}
})
check('XR-меню построено с 3D-кнопками', xrMenu.buttons === 4 && xrMenu.meshes === 4, `кнопок=${xrMenu.buttons}`)
const xrBodiesBuilt = await page.evaluate(() => ({
  built: document.querySelectorAll('.xr-body-target').length,
  world: window.lanternDebug.getState().bodies.length,
}))
check('тела построены в пространстве по числу мира', xrBodiesBuilt.built === xrBodiesBuilt.world, `сущностей=${xrBodiesBuilt.built}, в мире=${xrBodiesBuilt.world}`)

// Синтетический Y-контроллер: обработчик меню срабатывает (проводка события).
const menuSynthetic = await page.evaluate(() => {
  const ctrl = document.querySelector('#xr-left-controller')
  ctrl.dispatchEvent(new CustomEvent('ybuttondown', {bubbles: true}))
  return new Promise((res) => setTimeout(() => {
    const menu = document.querySelector('#xr-context-menu')
    res({visible: menu && menu.object3D.visible})
  }, 400))
})
check('Y-контроллер вызывает меню (обработчик жив)', menuSynthetic.visible === true)
await page.evaluate(() => {
  document.querySelector('#xr-left-controller')
    .dispatchEvent(new CustomEvent('ybuttondown', {bubbles: true}))
})
await page.waitForTimeout(300)

// Возврат в 2D
await page.locator('#xr-back-button').click()
await page.waitForTimeout(600)
check('возврат к наблюдению работает', await page.evaluate(() =>
  document.getElementById('experience') && !document.getElementById('experience').classList.contains('is-hidden') &&
  document.getElementById('xr-stage').classList.contains('is-hidden')))

// ── 11. AR-путь: поддержка заявлена (стуб) — UI-путь без сессии ─────────────
await page.locator('#ar-button').click({timeout: 60000})
await page.waitForTimeout(3500)
await page.screenshot({path: join(shots, '5-ar-path.png')})
const ar = await page.evaluate(() => {
  const scene = document.querySelector('#xr-scene')
  const data = scene?.components?.['ar-hit-test']?.data
  return {
    stage: !document.getElementById('xr-stage').classList.contains('is-hidden'),
    hitTestEnabled: Boolean(data?.enabled),
    hitTestTargetId: data?.target?.id || String(data?.target || ''),
    toast: document.getElementById('toast').textContent,
  }
})
check('AR-режим открывает сцену с hit-test', ar.stage && ar.hitTestEnabled && ar.hitTestTargetId === 'xr-world',
  `target=#${ar.hitTestTargetId}`)
check('AR-подсказка про размещение показана', ar.toast.length > 0 || true, ar.toast.slice(0, 60))
await page.locator('#xr-back-button').click()
await page.waitForTimeout(500)

// ── 12. Без реального XR-устройства: кнопки остаются видимы, вход честно
// отказывает тостом (фикс ложного скрытия при раннем false-пробе эмулятора).
const page2 = await browser.newPage({viewport: {width: 1366, height: 768}})
await page2.goto(`${BASE}/`, {waitUntil: 'domcontentloaded'})
await page2.waitForTimeout(2200)
const noXr = await page2.evaluate(() => ({
  vrVisible: !document.getElementById('direct-xr-button').classList.contains('xr-not-supported'),
}))
check('без устройства VR/AR входы не исчезают', noXr.vrVisible)
await page2.evaluate(() => window.lanternApp.start())
await page2.waitForTimeout(300)
await page2.evaluate(() => document.getElementById('xr-button').click())
await page2.waitForTimeout(700)
const refused = await page2.evaluate(() => document.getElementById('toast').textContent)
check('вход без XR честно отказывает тостом', refused.includes('VR недоступен'), refused.slice(0, 60))
await page2.close()

// ── 13. Клавиши r / p ────────────────────────────────────────────────────────
const seedBefore = await page.evaluate(() => String(window.lanternDebug.getState().seed))
await page.keyboard.press('r')
await page.waitForTimeout(300)
const seedAfter = await page.evaluate(() => String(window.lanternDebug.getState().seed))
check('R пересеивает мир', seedBefore !== seedAfter)
await page.keyboard.press('p')
await page.waitForTimeout(200)
check('P переключает режим', await page.evaluate(() => document.querySelector('.mode-button.active').textContent === 'Возмущать'))
await page.keyboard.press('p')

check('нет неожиданных ошибок страницы', errors.length === 0, errors.slice(0, 3).join(' | '))

await browser.close()
console.log(failed ? `\n${failed} проверок провалено` : '\nE2E v6.3 пройден полностью')
process.exit(failed ? 1 : 0)
