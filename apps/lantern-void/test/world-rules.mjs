// world-rules.mjs — правила LANTERN // VOID: где seed меняет мир, где поле p5 доходит
// до 3D и как тело берут рукой. Отвечает на три вопроса:
//   1. другой seed → другая СТРУКТУРА мира (число тел, программы, связи, формы),
//      а тот же seed → тот же мир;
//   2. одно поле среды (app.field, шум p5) питает и симуляцию, и плоский вид,
//      и шейдер оболочки в A-Frame — и его влияние можно выключить и увидеть разницу;
//   3. тело можно взять: grip в шлеме и курсор в режиме «Возмущать» тянут его,
//      оно возбуждается (agitation), а отпущенное — возвращается домой.
// Запуск: node test/world-rules.mjs  (сервер поднят; LANTERN_BASE — как в e2e.mjs).
//         LANTERN_FAST=1 — без VR-сцены: только быстрые проверки (1–4), ~20 секунд.
import {createRequire} from 'node:module'

// Playwright берётся из apps/weather-room, чтобы не заводить свой npm-стек (как в e2e.mjs).
const require = createRequire('D:/Code/active/xr-experiments/apps/weather-room/package.json')
const {chromium} = require('playwright')

const BASE = process.env.LANTERN_BASE || 'http://localhost:8095'
const WITH_XR = process.env.LANTERN_FAST !== '1'
const SEEDS = [140821, 1, 2, 3, 4, 5, 6, 7] // стартовый + семь подряд: у соседних seed первое
//                                            случайное число почти одинаковое — трудный случай
// Номинальная форма программ из OPERATOR_PROGRAMS: [лепестки, орбиты].
const NOMINAL = {'Резонатор': [5, 3], 'Порог': [7, 2], 'Отложенный свет': [4, 4], 'Рассеиватель': [8, 2], 'Петля': [6, 4]}

let failed = 0, passed = 0
const check = (name, cond, detail = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (cond) passed++; else failed++
}
// section — одна группа проверок; исключение внутри считается провалом группы,
// а не падением всего прогона: после группы видно, чего именно не хватает.
const section = async (title, fn) => {
  console.log(`\n── ${title} ──`)
  try { await fn() } catch (e) { check(`${title}: группа без исключений`, false, String((e && e.message) || e).slice(0, 220)) }
}
const fmt = (v, d = 3) => String(typeof v === 'number' && Number.isFinite(v) ? +v.toFixed(d) : v)

const browser = await chromium.launch()
const page = await browser.newPage({viewport: {width: 1366, height: 768}})
// Как в e2e: «гарнитура» на машине, чтобы кнопка VR-мира была активна.
await page.addInitScript(`navigator.xr = navigator.xr || {};
  navigator.xr.isSessionSupported = (m) => Promise.resolve(m === 'immersive-vr' || m === 'immersive-ar');`)
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('permission')) errors.push(`console: ${m.text()}`) })
await page.goto(`${BASE}/`, {waitUntil: 'domcontentloaded'})
await page.waitForTimeout(2600)

// poll — ждать, пока выражение в странице не вернёт {done:true}; отдаёт последний результат.
const poll = async (fn, arg, timeout = 20000, step = 250) => {
  const t0 = Date.now(); let last
  while (Date.now() - t0 < timeout) { last = await page.evaluate(fn, arg); if (last && last.done) { last.ms = Date.now() - t0; return last } await page.waitForTimeout(step) }
  return last
}

// ── 1. Seed → структура мира ─────────────────────────────────────────────────
await section('1. Seed → структура мира', async () => {
  const worlds = await page.evaluate((seeds) => seeds.map((seed) => {
    const d = window.lanternDebug
    d.reset(seed)
    const structure = d.structure()
    return {seed, structure, emissions: d.simulate(1800).emissions}
  }), SEEDS)

  for (const w of worlds) {
    const s = w.structure, b = s.bodies, n = b.length
    const isolated = b.filter((x) => x.links === 0).length
    // Посетитель: голова в (0, 1.65, 0), тело — в (x, y + 1.7, z).
    const arm = Math.hypot(b[0].x, b[0].y + .05, b[0].z)
    const behind = b.filter((x) => x.layer === 'behind').length
    const layers = new Set(b.map((x) => x.layer))
    check(`seed ${w.seed}: тел ${n} (6–12), изолированных ${isolated}, L-01 в ${fmt(arm, 2)} м, за спиной ${behind}, слои ${[...layers].join('/')}`,
      n >= 6 && n <= 12 && isolated === 0 && arm <= 1.45 && behind >= 1 && behind <= 3 &&
      ['near', 'middle', 'far', 'behind'].every((l) => layers.has(l)))
    check(`seed ${w.seed}: мир жив — ${w.emissions} импульсов за 30 с`, w.emissions > 0)
  }

  const sig = (w) => ({
    n: w.structure.bodies.length,
    programs: w.structure.bodies.map((b) => b.program).sort().join(','),
    links: JSON.stringify(w.structure.links),
  })
  const shapes = (w) => w.structure.bodies.map((b) => `${b.program}:${b.lobes}/${b.rings}`).sort().join(' | ')
  const tuples = new Set(worlds.map((w) => JSON.stringify(sig(w))))
  check(`${SEEDS.length} seed → ${SEEDS.length} разных наборов {число тел, программы, связи}`, tuples.size === SEEDS.length, `разных: ${tuples.size}`)

  const counts = new Set(worlds.map((w) => sig(w).n))
  const programs = new Set(worlds.map((w) => sig(w).programs))
  const links = new Set(worlds.map((w) => sig(w).links))
  const forms = new Set(worlds.map(shapes))
  check('число тел принимает ≥ 3 разных значений', counts.size >= 3, [...counts].sort((a, b) => a - b).join('/'))
  check('наборы программ принимают ≥ 3 разных значений', programs.size >= 3, `разных: ${programs.size}`)
  check('список связей различен у всех seed', links.size === SEEDS.length, `разных: ${links.size}`)
  check('наборы форм (программа + лепестки + орбиты) различны у всех seed', forms.size === SEEDS.length, `разных: ${forms.size}`)

  // Правило формы: тело остаётся узнаваемым по своей программе (лепестки ±2 и ≥ 3, орбиты ±1 и ≥ 1).
  const offenders = []
  for (const w of worlds) for (const b of w.structure.bodies) {
    const [lobes, rings] = NOMINAL[b.program] || [NaN, NaN]
    if (!(Math.abs(b.lobes - lobes) <= 2 && b.lobes >= 3 && Math.abs(b.rings - rings) <= 1 && b.rings >= 1)) offenders.push(`${w.seed}/${b.id}:${b.program} ${b.lobes}/${b.rings}`)
  }
  check('форма тела = его программа ± собственный seed (лепестки ±2, орбиты ±1)', offenders.length === 0, offenders.slice(0, 4).join('; '))
  const kinds = worlds.map((w) => new Set(w.structure.bodies.map((b) => b.program)).size)
  check('сколько видов программ живёт в мире — решает seed', new Set(kinds).size >= 2, `видов в мире: ${kinds.join('/')}`)
  const reach = worlds.map((w) => w.structure.reach)
  check('порог связи («разговорчивость») — от seed', new Set(reach.map((v) => v.toFixed(4))).size >= 3, reach.map((v) => fmt(v, 2)).join('/'))

  // Детерминизм: тот же seed дважды → та же структура и то же состояние после 600 шагов.
  const det = await page.evaluate(() => [140821, 777].map((seed) => {
    const d = window.lanternDebug
    d.reset(seed); const a = JSON.stringify(d.structure()), sa = d.simulate(600)
    d.reset(seed); const b = JSON.stringify(d.structure()), sb = d.simulate(600)
    return {seed, same: a === b, sameRun: JSON.stringify(sa.energies) === JSON.stringify(sb.energies) && sa.emissions === sb.emissions}
  }))
  for (const r of det) check(`seed ${r.seed} дважды → одинаковые тела и связи (${r.sameRun ? 'и одинаковое состояние' : 'НО состояние отличается'})`, r.same && r.sameRun)

  const def = worlds[0]
  check('стартовый seed 140821: 10 тел', def.structure.bodies.length === 10, `тел=${def.structure.bodies.length}`)
  check('стартовый seed 140821: ≥ 40 импульсов за 30 с', def.emissions >= 40, `${def.emissions} импульсов`)

  // Таблица различий.
  console.log('\n  seed    тел  видов  связей  порог(м)  за спиной  имп./30с  программы×тел')
  for (const w of worlds) {
    const b = w.structure.bodies, multi = {}
    for (const x of b) multi[x.program] = (multi[x.program] || 0) + 1
    console.log(`  ${String(w.seed).padEnd(7)} ${String(b.length).padStart(3)} ${String(Object.keys(multi).length).padStart(5)} ${String(w.structure.links.length).padStart(7)} ${fmt(w.structure.reach, 2).padStart(10)} ${String(b.filter((x) => x.layer === 'behind').length).padStart(10)} ${String(w.emissions).padStart(9)}  ${Object.entries(multi).map(([k, v]) => `${k}×${v}`).join(' ')}`)
  }
  console.log('\n  формы (программа:лепестки/орбиты):')
  for (const w of worlds) console.log(`  ${String(w.seed).padEnd(7)} ${shapes(w)}`)
  console.log('\n  чем миры отличаются попарно (Ч — число тел, П — программы, С — связи, Ф — формы):')
  for (let i = 1; i < worlds.length; i++) {
    const row = []
    for (let j = 0; j < i; j++) {
      const a = sig(worlds[i]), b = sig(worlds[j])
      row.push((a.n !== b.n ? 'Ч' : '·') + (a.programs !== b.programs ? 'П' : '·') + (a.links !== b.links ? 'С' : '·') + (shapes(worlds[i]) !== shapes(worlds[j]) ? 'Ф' : '·'))
    }
    console.log(`  ${String(worlds[i].seed).padEnd(7)} ${row.join('   ')}`)
  }
})

// ── 2. Поле среды: порождено p5, детерминировано, питает симуляцию ───────────
await section('2. Поле среды (p5.noise) и симуляция', async () => {
  // p5 идёт с CDN и может подниматься дольше двух секунд: ждём поле до 15 с.
  const ready = await poll(() => { const f = window.lanternDebug.field(); return {done: !!f, kind: f && f.kind} }, null, 15000)
  if (!ready || !ready.done) { check('поле среды появилось', false, 'p5 так и не поднялся'); return }
  const f = await page.evaluate(() => {
    const d = window.lanternDebug, f = d.field()
    if (!f) return null
    const grid = (t) => { const out = []; for (const x of [-4, -2, 0, 2, 4]) for (const y of [-1, .5, 2]) for (const z of [-7, -5, -3, -1, 1, 3]) out.push(f.at(x, y, z, t)); return out }
    d.reset(140821); const a1 = grid(0)
    d.reset(140821); const a2 = grid(0)
    d.reset(777); const b = grid(0)
    d.reset(140821); const later = grid(5), mirror = [f.at(-2, 0, -3, 0), f.at(2, 0, -3, 0)]
    // Выключение поля: 600 шагов с полем и без (gain = 0); без поля — дважды (контроль).
    const def = d.fieldGain(), run = () => { d.reset(140821); return d.simulate(600) }
    d.fieldGain(0); const off1 = run(), off2 = run()
    d.fieldGain(def); const on = run()
    return {kind: f.kind, a1, a2, b, later, mirror, def, off1, off2, on}
  })
  check('поле есть и сделано шумом p5 (не запасным hash)', f.kind === 'p5', `kind=${f.kind} (ждали ${((ready.ms || 0) / 1000).toFixed(1)} с)`)
  if (!f) return
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const diff = (a, b) => a.filter((v, i) => Math.abs(v - b[i]) > 1e-3).length
  const stat = (a) => { const mean = a.reduce((s, v) => s + v, 0) / a.length
    return {min: Math.min(...a), max: Math.max(...a), mean, sd: Math.sqrt(a.reduce((s, v) => s + (v - mean) ** 2, 0) / a.length)} }
  check('тот же seed → те же значения поля (90 точек, точно)', same(f.a1, f.a2))
  check('другой seed → другое поле', !same(f.a1, f.b) && diff(f.a1, f.b) >= 45, `отличаются ${diff(f.a1, f.b)} из ${f.a1.length}`)
  const st = stat(f.a1)
  check('поле в пределах −1…1 и не постоянное', st.min >= -1 && st.max <= 1 && st.sd > .05, `min ${fmt(st.min)} max ${fmt(st.max)} sd ${fmt(st.sd)}`)
  check('поле течёт со временем', !same(f.a1, f.later) && diff(f.a1, f.later) >= 45, `через 5 с отличаются ${diff(f.a1, f.later)} из ${f.a1.length}`)
  check('поле не зеркалит слева и справа от посетителя', Math.abs(f.mirror[0] - f.mirror[1]) > 1e-3, `x=−2: ${fmt(f.mirror[0])}  x=+2: ${fmt(f.mirror[1])}`)
  const eDiff = f.on.energies.filter((v, i) => Math.abs(v - f.off1.energies[i]) > 1e-6).length
  check('контроль: без поля (gain 0) мир идёт одинаково', same(f.off1.energies, f.off2.energies) && f.off1.emissions === f.off2.emissions)
  check('симуляция зависит от поля: с полем и без — разные энергии тел', eDiff > 0, `отличаются ${eDiff} из ${f.on.energies.length} тел; импульсов ${f.off1.emissions} → ${f.on.emissions}`)
  console.log(`  поле: min ${fmt(st.min)} max ${fmt(st.max)} среднее ${fmt(st.mean)} sd ${fmt(st.sd)}; gain ${f.def}`)
})

await page.evaluate(() => { window.lanternApp.start(); document.activeElement && document.activeElement.blur() })
await page.waitForTimeout(900)
const pressSpace = async () => { await page.evaluate(() => document.activeElement && document.activeElement.blur()); await page.keyboard.press('Space'); await page.waitForTimeout(350) }

// Снимок холста p5 (каждый 3-й пиксель) и сравнение двух снимков — в странице.
const SNAP = () => {
  const c = document.querySelector('#p5-stage canvas'), g = c.getContext('2d')
  const w = c.width, h = c.height, src = g.getImageData(0, 0, w, h).data, out = []
  for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) out.push(src[(y * w + x) * 4], src[(y * w + x) * 4 + 1], src[(y * w + x) * 4 + 2])
  window.__snap = out; return out.length
}
const DIFF = () => {
  const a = window.__snapA, b = window.__snap; let n = 0, sum = 0
  for (let i = 0; i < a.length; i += 3) { const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])); if (d >= 2) n++; sum += d }
  return {pixels: n, sum}
}

// ── 3. Плоский вид показывает то же поле ─────────────────────────────────────
await section('3. Плоский вид читает и показывает поле', async () => {
  await pressSpace() // пауза: симуляция стоит, значит поле читает только рисование
  const paused = await page.evaluate(() => { document.getElementById('toast').classList.remove('visible'); return document.getElementById('system-status').textContent })
  check('мир на паузе', paused === 'ПРОЦЕСС ОСТАНОВЛЕН', paused)
  const spy = await page.evaluate(() => {
    const f = window.lanternDebug.field()
    if (!f) return false
    const orig = f.at; window.__origAt = orig; window.__fcalls = []
    f.at = function (...a) { window.__fcalls.push(a); return orig.apply(f, a) }
    return true
  })
  check('счётчик вызовов поля поставлен', spy)
  if (!spy) return
  await page.waitForTimeout(500)
  const n1 = await page.evaluate(() => window.__fcalls.length)
  await page.waitForTimeout(600)
  const calls = await page.evaluate(() => ({n: window.__fcalls.length, args: window.__fcalls.slice(-4), t: window.lanternDebug.getState().time}))
  check('плоский вид читает поле каждый кадр (симуляция на паузе)', calls.n > n1 + 3, `${n1} → ${calls.n} вызовов за 0.6 с`)
  check('аргументы — метры мира и время мира', calls.args.length === 4 && calls.args.every((a) => a.length === 4 && a.every(Number.isFinite) && Math.abs(a[0]) < 20 && Math.abs(a[1]) < 20 && Math.abs(a[2]) < 20 && Math.abs(a[3] - calls.t) < 1e-6),
    JSON.stringify(calls.args.map((a) => a.map((v) => +v.toFixed(2)))))

  // Картинка с настоящим полем против картинки с полем ≡ 0: мир на паузе, остальное не меняется.
  await page.waitForTimeout(400)
  await page.evaluate(SNAP); await page.evaluate(() => { window.__snapA = window.__snap })
  await page.evaluate(() => { window.lanternDebug.field().at = () => 0 })
  await page.waitForTimeout(600)
  const zero = await page.evaluate(SNAP); const zeroDiff = await page.evaluate(DIFF)
  await page.evaluate(() => { window.__snapA = window.__snap }); await page.waitForTimeout(400)
  await page.evaluate(SNAP); const control = await page.evaluate(DIFF)
  check('контроль: с нулевым полем кадр одинаков (разница только от поля)', control.pixels === 0, `${control.pixels} пикселей`)
  check('свечения и кольца зависят от поля (пиксели различаются)', zeroDiff.pixels > 300, `${zeroDiff.pixels} пикселей из ${zero / 3}, сумма ${zeroDiff.sum}`)
  await page.evaluate(() => { const f = window.lanternDebug.field(); if (f && window.__origAt) f.at = window.__origAt }) // вернуть поле
  await pressSpace() // снять паузу
})

// ── 4. Плоский вид: встряска и перетаскивание курсором ───────────────────────
await section('4. Курсор тянет тело (режим «Возмущать»)', async () => {
  const home = await page.evaluate(() => { const d = window.lanternDebug; d.reset(140821); return d.structure().bodies[0] })
  const body = () => { const b = window.lanternDebug.spatialLayout().find((x) => x.id === 'L-01'), a = window.lanternDebug.getState().bodies[0].agitation
    return {x: b.x, y: b.y - 1.7, z: b.z, agitation: a, done: false} }
  const dist = (b) => Math.hypot(b.x - home.x, b.y - home.y, b.z - home.z)
  // Проекция тела на экран — как bodyScreen в скетче (после входа центр в 0.52 ширины).
  const at = await page.evaluate(() => { const w = window.innerWidth, h = window.innerHeight, b = window.lanternDebug.spatialLayout().find((x) => x.id === 'L-01')
    const depth = 1 / (1 + Math.abs(b.z + 4.4) * .10), spread = Math.min(w * .100, h * .185)
    return {x: w * .52 + b.x * spread * depth, y: h * .475 - (b.y - 1.7) * spread * .88 * depth} })

  await page.locator('#perturb-button').click(); await page.waitForTimeout(300)
  await page.mouse.move(at.x, at.y); await page.waitForTimeout(150)
  await page.mouse.down(); await page.waitForTimeout(100)
  await page.mouse.move(at.x - 60, at.y - 30, {steps: 5}); await page.waitForTimeout(60)
  await page.mouse.move(at.x - 150, at.y - 70, {steps: 8}); await page.waitForTimeout(120)
  const pulled = await page.evaluate(body)
  check('нажатие и движение курсора отрывают тело от дома', dist(pulled) > .3, `сдвиг ${fmt(dist(pulled), 2)} м`)
  check('движение курсора встряхивает тело (agitation > 0.5)', pulled.agitation > .5, `agitation ${fmt(pulled.agitation)}`)
  await page.mouse.up()
  const back = await poll((arg) => { const b = window.lanternDebug.spatialLayout().find((x) => x.id === 'L-01'), a = window.lanternDebug.getState().bodies[0].agitation
    const d = Math.hypot(b.x - arg.x, b.y - 1.7 - arg.y, b.z - arg.z); return {d, a, done: d < .1 && a < .2} }, home, 40000)
  check('отпущенное тело возвращается домой (≤ 0.1 м) и успокаивается (agitation < 0.2)', !!(back && back.done), back ? `${fmt(back.d, 3)} м, agitation ${fmt(back.a)}` : 'нет данных')

  // Наблюдение не тянет: тот же жест в режиме «Наблюдать» не двигает тело.
  await page.locator('#observe-button').click(); await page.waitForTimeout(300)
  await page.mouse.move(at.x, at.y); await page.waitForTimeout(150)
  await page.mouse.down(); await page.mouse.move(at.x - 150, at.y - 70, {steps: 8}); await page.waitForTimeout(400)
  const still = await page.evaluate(body)
  await page.mouse.up(); await page.waitForTimeout(200)
  check('в режиме «Наблюдать» тот же жест не двигает тело', dist(still) < .02, `сдвиг ${fmt(dist(still), 3)} м, agitation ${fmt(still.agitation)}`)
  await page.locator('#close-inspector').click().catch(() => {})

  // Встряска видна и в плоском рисунке: мир на паузе, тело дома; меняется только agitation.
  await poll((arg) => { const b = window.lanternDebug.spatialLayout().find((x) => x.id === 'L-01'), a = window.lanternDebug.getState().bodies[0].agitation
    return {done: Math.hypot(b.x - arg.x, b.y - 1.7 - arg.y, b.z - arg.z) < .02 && a < .05} }, home, 15000)
  await page.mouse.move(5, 5); await pressSpace()
  await page.evaluate(() => window.lanternDebug.agitate(0, 1)); await page.waitForTimeout(450)
  await page.evaluate(SNAP); await page.evaluate(() => { window.__snapA = window.__snap })
  await page.evaluate(() => window.lanternDebug.agitate(0, 0)); await page.waitForTimeout(450)
  await page.evaluate(SNAP); const calm = await page.evaluate(DIFF)
  await page.evaluate(() => { window.__snapA = window.__snap }); await page.waitForTimeout(350)
  await page.evaluate(SNAP); const ctl = await page.evaluate(DIFF)
  check('контроль: спокойное тело рисуется одинаково', ctl.pixels === 0, `${ctl.pixels} пикселей`)
  check('встряска меняет рисунок тела (рябь и дрожь)', calm.pixels > 100, `${calm.pixels} пикселей, сумма ${calm.sum}`)
  await pressSpace()
})

// ── 5. A-Frame: поле в шейдере оболочки и захват телом grip ──────────────────
if (WITH_XR) await section('5. A-Frame: поле в шейдере и захват grip', async () => {
  await page.click('#xr-button', {timeout: 20000})
  await page.waitForFunction(() => document.querySelector('#xr-scene')?.hasLoaded === true, null, {timeout: 90000})
  await page.waitForTimeout(2500)
  const shell = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('.xr-body-target')) {
      let tex = null, agit = null, count = 0
      el.getObject3D('mesh').traverse((o) => { const u = o.material && o.material.uniforms; if (u && u.uField) { count++; tex = tex || u.uField.value; agit = u.uAgitation ? u.uAgitation.value : null } })
      if (!tex) { out.push({index: el.dataset.bodyIndex, texture: false}); return }
      const d = tex.image && tex.image.data
      out.push({index: el.dataset.bodyIndex, texture: !!tex.isTexture, dataTexture: !!tex.isDataTexture, layers: count, w: tex.image && tex.image.width,
        min: d ? Math.min(...d.filter((_, i) => i % 4 === 0)) : null, max: d ? Math.max(...d.filter((_, i) => i % 4 === 0)) : null, agitation: typeof agit === 'number'})
    }
    return out
  })
  const bad = shell.filter((s) => !(s.texture && s.dataTexture && s.layers === 3 && s.min !== null && s.min !== s.max && s.agitation))
  check('у каждого тела все 3 оболочки несут текстуру поля (THREE.DataTexture) и uniform встряски', bad.length === 0 && shell.length >= 6, `${shell.length} тел; проблемы: ${JSON.stringify(bad).slice(0, 200)}`)
  check('данные текстуры поля непостоянны (min ≠ max)', shell.every((s) => s.min !== null && s.min !== s.max), shell.map((s) => `${s.min}–${s.max}`).slice(0, 6).join(' '))

  const tex = await page.evaluate(() => {
    const d = window.lanternDebug
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
    const a = d.fieldTexture(0), a2 = d.fieldTexture(0)
    d.field().reseed(777); const b = d.fieldTexture(0)
    d.field().reseed(140821); const c = d.fieldTexture(0)
    return {same: same(a.data, a2.data), other: !same(a.data, b.data), back: same(a.data, c.data), n: a.data.length / 4, time: a.time}
  })
  check('текстура поля детерминирована: тот же seed → те же тексели', tex.same && tex.back, `${tex.n} текселей`)
  check('текстура поля зависит от seed', tex.other)

  // Имитация настоящей сессии (как в xr-scenarios.mjs: код A-Frame look-controls.onEnterVR).
  const sim = await page.evaluate(() => {
    const s = document.querySelector('#xr-scene'), camEl = s.querySelector('#xr-camera'), cam3 = s.camera
    const orig = s.checkHeadsetConnected; s.checkHeadsetConnected = () => true
    camEl.components['look-controls'].onEnterVR(); s.checkHeadsetConnected = orig
    cam3.position.set(0, 1.7, 0); cam3.rotation.set(0, 0, 0)
    s.addState('vr-mode'); s.emit('enter-vr', {target: s})
    s.components['lantern-simulation'].ticks = 200
    return cam3.position.y
  })
  check('имитация сессии: голова на 1.7 м', sim === 1.7)

  // Захват: grip рядом с L-01, ведём руку в сторону, отпускаем. Рука «живая» только
  // ближе 1.2 м к голове, поэтому ставим её на отрезке голова→тело в 1.15 м от головы:
  // до тела L-01 остаётся ≈1.13 м — в пределах захвата (~1.3 м) и рядом с телом.
  const grip = await page.evaluate(() => new Promise((resolve) => {
    const THREE = window.AFRAME.THREE, s = document.querySelector('#xr-scene'), d = window.lanternDebug
    const comp = s.components['lantern-simulation'], right = s.querySelector('#xr-right-controller')
    // waitTicks(n, move) — ждать n тиков lantern-simulation; движение руки — РАЗ на тик
    // симуляции (а не раз на опрос: у софт-рендера тик ≈8 опросов, рука улетела бы).
    const waitTicks = (n, move) => new Promise((res) => { const t0 = comp.ticks; let seen = 0
      const iv = setInterval(() => { const now = comp.ticks - t0
        if (move && now > seen) { move(); seen = now }
        if (now >= n) { clearInterval(iv); res() } }, 40) })
    const state = () => { const b = d.spatialLayout().find((x) => x.id === 'L-01'), a = d.getState().bodies[0].agitation
      const group = document.querySelector('.xr-body-target[data-body-index="0"]').getObject3D('mesh')
      let u = null; group.traverse((o) => { if (!u && o.material && o.material.uniforms && o.material.uniforms.uAgitation) u = o.material.uniforms.uAgitation.value })
      return {x: b.x, y: b.y, z: b.z, agitation: a, group: {x: group.position.x, y: group.position.y, z: group.position.z}, uniform: u} }
    const home = state()
    const dist = (b) => Math.hypot(b.x - home.x, b.y - home.y, b.z - home.z)
    const bodyW = new THREE.Vector3(home.x, home.y, home.z)
    const headW = s.camera.getWorldPosition(new THREE.Vector3())
    const toBody = bodyW.clone().sub(headW).normalize()
    right.object3D.position.copy(headW).addScaledVector(toBody, 1.15)   // 1.15 м от головы
    right.object3D.updateMatrix()
    const timer = setTimeout(() => resolve({error: 'timeout', home, last: state()}), 90000)
    ;(async () => {
      await waitTicks(2)
      const idle = {...state(), handDist: right.object3D.position.distanceTo(bodyW)}
      right.dispatchEvent(new CustomEvent('gripdown', {bubbles: true}))
      await waitTicks(1)
      // 14 тиков по 0.085 м: шаг меньше радиуса захвата — рука не «убегает» из тела,
      // а путь ≈1.2 м хватает на встряску и заметный отрыв от дома (тик зажат на 0.065 с).
      const step = (() => { const t = new THREE.Vector3(0, 1, 0).cross(toBody).normalize().multiplyScalar(.085); t.y = 0; return t })()   // вбок: голова—рука держит 1.15 м
      await waitTicks(14, () => { right.object3D.position.add(step); right.object3D.updateMatrix() })
      const pulled = state()
      right.dispatchEvent(new CustomEvent('gripup', {bubbles: true}))
      let back = null
      for (let i = 0; i < 300 && !back; i++) { await waitTicks(1); const b = state(); if (dist(b) < .1 && b.agitation < .2) back = {...b, ticks: i + 1} }
      clearTimeout(timer)
      resolve({home: {x: home.x, y: home.y, z: home.z, agitation: home.agitation}, idle: {x: idle.x, y: idle.y, z: idle.z, agitation: idle.agitation, handDist: idle.handDist}, pulled, back, tickErrors: d.xrState().tickErrors(), mode: d.xrState().visitorMode})
    })()
  }))
  if (grip.error) { check('сценарий grip завершился', false, `${grip.error}: ${JSON.stringify(grip.last).slice(0, 200)}`); }
  else {
    const g = grip
    check('до захвата тело дома и спокойно', dist3(g.idle, g.home) < .02 && g.idle.agitation < .05, `${fmt(dist3(g.idle, g.home), 3)} м, agitation ${fmt(g.idle.agitation)}`)
    check('grip рядом с телом + движение руки отрывают тело (> 0.2 м от дома)', dist3(g.pulled, g.home) > .2, `сдвиг ${fmt(dist3(g.pulled, g.home), 2)} м`)
    check('тело возбуждено (agitation > 0.5)', g.pulled.agitation > .5, `agitation ${fmt(g.pulled.agitation)}; uniform ${fmt(g.pulled.uniform)}`)
    check('оболочка в шлеме следует за телом', dist3(g.pulled.group, g.pulled) < 1e-5, `расхождение ${fmt(dist3(g.pulled.group, g.pulled), 6)} м`)
    check('uniform встряки равен состоянию тела', Math.abs(g.pulled.uniform - g.pulled.agitation) < .0011, `${fmt(g.pulled.uniform)} vs ${fmt(g.pulled.agitation)}`)
    check('после gripup тело дома (≤ 0.1 м) и спокойно (agitation < 0.2)', !!g.back, g.back ? `через ${g.back.ticks} тиков: ${fmt(dist3(g.back, g.home), 3)} м, agitation ${fmt(g.back.agitation)}` : 'не вернулось')
    check('режим в шлеме — возмущение', g.mode === 'perturb', g.mode)
  }
  check('ошибок тика нет (настоящий список)', grip.tickErrors.length === 0, JSON.stringify(grip.tickErrors).slice(0, 160))
})
function dist3(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) }

check('нет ошибок страницы', errors.length === 0, errors.slice(0, 3).join(' | '))
await browser.close()
console.log(`\n${failed ? `${failed} провалено, ` : ''}пройдено ${passed}, провалено ${failed}${WITH_XR ? '' : ' (БЕЗ VR-сцены: LANTERN_FAST=1)'}; LanternRules`)
process.exit(failed ? 1 : 0)
