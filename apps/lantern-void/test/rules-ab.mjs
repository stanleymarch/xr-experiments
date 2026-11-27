// rules-ab.mjs — «что обещано правилами» против «что делает мир» (грамматика v1).
//
// Задание семинара просит сравнить предложенную моделью логику с фактическим поведением
// системы. Здесь каждое сравнение — измерение, а не пересказ кода; каждое качественное
// утверждение docs/lantern-void-rules.md — проверка этого набора:
//   1. контроль инструментов: ablate('EMIT') глушит мир; изоляция подтверждается в прогоне;
//   2. грамматика: у каждого тела EMIT и вход; FILTER, DELAY, MEMORY — только с SENSE;
//      три архетипа; имена по правилу; форма из графа;
//   3. живость (40 миров × 30 с): якорь кричит в каждом мире, молчащих мало, громкость в цели;
//   4. избирательность: один и тот же сигнал разным телам — развёртка слушателя;
//   5. зависимость: заглушить партнёров — слушатель замолкает;
//   6. операторы по одному на изолированном теле: SOURCE, FEEDBACK (знак), GATE, DELAY, MEMORY;
//   7. присутствие: двойник неотличим в наблюдении; рука у тела удваивает крики;
//   8. seed: соседние seed независимы; возможных графов больше, чем актуализирует мир;
//   9. «как это читается» и имена: без несработавших подстановок, на обоих языках.
// Числа документа берутся из этого прогона. Константы — из lanternDebug.rules(), не руками.
// Запуск: node test/rules-ab.mjs  (сервер поднят; LANTERN_BASE — как в e2e.mjs).
import {createRequire} from 'node:module'
import {mkdirSync, writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, join} from 'node:path'

// Playwright берётся из apps/weather-room, чтобы не заводить свой npm-стек (как в e2e.mjs).
const require = createRequire(new URL('../../weather-room/package.json', import.meta.url))
const {chromium} = require('playwright')

const BASE = process.env.LANTERN_BASE || 'http://localhost:8095'
const here = dirname(fileURLToPath(import.meta.url))
mkdirSync(join(here, 'tmp'), {recursive: true}) // tmp/ игнорируется git

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
const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
// Ранговая корреляция Спирмена: устойчива к выбросам, ничего не предполагает о распределении.
const spearman = (x, y) => {
  const rank = (a) => {
    const order = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]), r = new Array(a.length)
    for (let i = 0; i < order.length;) {
      let j = i
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++
      for (let k = i; k <= j; k++) r[order[k][1]] = (i + j) / 2
      i = j + 1
    }
    return r
  }
  const rx = rank(x), ry = rank(y), n = x.length, mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2 }
  return num / Math.sqrt(dx * dy)
}
const share = (rows, f) => rows.filter(f).length / rows.length

// Детерминированные наборы seed: стартовый мир + подряд идущие значения линейного генератора.
const seedList = (n) => { let s = 20261125; const a = [140821]; for (let i = 1; i < n; i++) { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; a.push(s) } return a }
const SEEDS = seedList(40), SECONDS = 30
const PERIODS = [.5, .6, .75, .9, 1, 1.2, 1.5, 2]

const browser = await chromium.launch()
const page = await browser.newPage({viewport: {width: 1024, height: 640}})
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('permission')) errors.push(`console: ${m.text()}`) })
await page.goto(`${BASE}/`, {waitUntil: 'domcontentloaded'})
await page.waitForTimeout(2600)
await page.evaluate(() => window.lanternApp.start())
const RULES = await page.evaluate(() => window.lanternDebug.rules())
const report = {rules: RULES}
console.log(`константы из кода: ${JSON.stringify(RULES)}`)

// isolated(i) внутри страницы: заглушить все тела, кроме i. Нарушение изоляции — чужие крики
// и чужие прилёты К телу i (его собственные импульсы соседям не считаются: соседи без EMIT).
const ISOLATION_NOTE = 'изоляция подтверждается внутри каждого прогона'

// ── 1. Контроль инструментов ─────────────────────────────────────────────────
await section('1. Контроль инструментов', async () => {
  const r = await page.evaluate(() => {
    const d = window.lanternDebug
    d.reset(1)
    const a = d.trace(600).emits.length
    const restore = d.ablate('EMIT')
    const b = d.trace(600).emits.length
    restore()
    const c = d.trace(600).emits.length
    d.reset(1)
    const quiet = d.ablate('EMIT', 1)
    const t = d.trace(600)
    quiet()
    const stray = t.arrivals.filter((x) => x.to === 1).length + t.emits.filter((x) => x.i !== 1).length
    return {a, b, c, stray}
  })
  check('без EMIT мир не излучает ни одного импульса', r.a > 0 && r.b === 0, `было ${r.a} → стало ${r.b}`)
  check('после возврата графов мир снова кричит', r.c > 0, String(r.c))
  check(`${ISOLATION_NOTE}: при заглушении остальных к телу ничего не прилетает, и никто, кроме него, не кричит`, r.stray === 0, String(r.stray))
  check('константы читаются из кода, а не переписаны в тесте', RULES.senseGain > 0 && RULES.presenceRest > 0 && RULES.filterFloor > 0 && RULES.filterFloor < 1)
})

// ── 2. Грамматика ────────────────────────────────────────────────────────────
const structures = await page.evaluate((seeds) => seeds.map((seed) => {
  const d = window.lanternDebug
  d.reset(seed)
  return {seed, namesRu: d.names('ru'), namesEn: d.names('en'), ...d.structure()}
}), seedList(400))
report.structures = {worlds: structures.length}
await section('2. Грамматика', async () => {
  const bodies = structures.flatMap((s) => s.bodies)
  const has = (b, o) => b.ops.includes(o)
  check('тел в мире от 6 до 12', structures.every((s) => s.bodies.length >= 6 && s.bodies.length <= 12))
  check('у каждого тела есть EMIT и вход (SOURCE или SENSE)', bodies.every((b) => has(b, 'EMIT') && (has(b, 'SOURCE') || has(b, 'SENSE'))))
  check('FILTER, DELAY и MEMORY встречаются только с SENSE', bodies.every((b) => ['FILTER', 'DELAY', 'MEMORY'].every((o) => !has(b, o) || has(b, 'SENSE'))))
  check('в каждом мире первые три тела — автономный крик, избирательный слушатель, запаздывающий слушатель',
    structures.every((s) => ['Резонатор', 'Порог', 'Отложенный свет'].every((n, i) => s.namesRu[i] === n)))
  check('«Резонатор» всегда с самораскруткой (петля со знаком плюс)', structures.every((s) => s.bodies[0].p.loop > 0))
  check('источник с порогом жизнеспособен по построению: приток минимум вдвое выше потерь на пороге',
    bodies.filter((b) => has(b, 'SOURCE') && has(b, 'GATE')).every((b) => b.p.amp / 2 >= 2 * RULES.baseLoss * b.p.gate - 1e-9),
    fmt(Math.min(...bodies.filter((b) => has(b, 'SOURCE') && has(b, 'GATE')).map((b) => (b.p.amp / 2) / (RULES.baseLoss * b.p.gate))), 2) + ' — наименьшее отношение')
  check('форма — чтение графа: лепестков 3–9, орбит 1–4', bodies.every((b) => b.lobes >= 3 && b.lobes <= 9 && b.rings >= 1 && b.rings <= 4))
  check('орбиты = 1 + число возвратов (петля, след, задержка)', bodies.every((b) => b.rings === 1 + (has(b, 'FEEDBACK') ? 1 : 0) + (has(b, 'MEMORY') ? 1 : 0) + (has(b, 'DELAY') ? 1 : 0)))
  check('ни одно тело без связи', bodies.every((b) => b.links >= 1))
  check('в каждом мире не меньше трёх разных графов', structures.every((s) => new Set(s.bodies.map((b) => b.ops.join(','))).size >= 3))
  check('имена по правилу: непустые, без несработавших подстановок, на обоих языках', structures.every((s) =>
    [...s.namesRu, ...s.namesEn].every((n) => n.trim().length > 0 && !n.includes('{'))))
  check('английские имена без кириллицы', structures.every((s) => s.namesEn.every((n) => !/[А-Яа-я]/.test(n))))
  const kinds = new Set(structures.flatMap((s) => s.namesRu))
  console.log(`      различных имён на 400 миров: ${kinds.size}; например: ${[...kinds].slice(0, 8).join(' · ')}`)
})

// ── 3. Живость ───────────────────────────────────────────────────────────────
const live = await page.evaluate(({seeds, steps}) => seeds.map((seed) => {
  const d = window.lanternDebug
  d.reset(seed)
  const s = d.structure()
  const t = d.trace(steps)
  const per = s.bodies.map((_, i) => t.emits.filter((e) => e.i === i).length)
  return {seed, n: s.bodies.length, emissions: t.emits.length, silent: per.filter((c) => c === 0).length,
    anchor: t.emits.filter((e) => e.i === 0 && e.step < 600).length,
    held: t.emits.length ? t.emits.filter((e) => e.held).length / t.emits.length : 0,
    loud: t.emits.length ? t.emits.filter((e) => e.gated).length / t.emits.length : 0}
}), {seeds: SEEDS, steps: SECONDS * 60})
const liveStat = {
  anchorMin: Math.min(...live.map((r) => r.anchor)), anchorMedian: median(live.map((r) => r.anchor)),
  silentMedian: median(live.map((r) => r.silent / r.n)), silentMax: Math.max(...live.map((r) => r.silent / r.n)),
  emMedian: median(live.map((r) => r.emissions)), emMin: Math.min(...live.map((r) => r.emissions)), emMax: Math.max(...live.map((r) => r.emissions)),
  heldMedian: median(live.map((r) => r.held)), loudMedian: median(live.map((r) => r.loud)),
}
report.live = liveStat
await section(`3. Живость: ${SEEDS.length} миров × ${SECONDS} с (цели записаны до измерения)`, async () => {
  check('«Резонатор» кричит ≥ 3 раз за первые 10 с в КАЖДОМ мире', liveStat.anchorMin >= 3, `минимум ${liveStat.anchorMin}, медиана ${liveStat.anchorMedian}`)
  check('в медианном мире молчит ≤ 20 % тел', liveStat.silentMedian <= .2, `${(100 * liveStat.silentMedian).toFixed(0)} %`)
  check('ни в одном мире не молчит больше 50 % тел', liveStat.silentMax <= .5, `худший ${(100 * liveStat.silentMax).toFixed(0)} %`)
  check('медиана импульсов за 30 с — от 120 до 260', liveStat.emMedian >= 120 && liveStat.emMedian <= 260, `медиана ${liveStat.emMedian}, минимум ${liveStat.emMin}, максимум ${liveStat.emMax}`)
  check('в мире есть и крики с порогом, и без порога', liveStat.loudMedian > .3 && liveStat.loudMedian < .95, `доля криков с порогом в медиане: ${(100 * liveStat.loudMedian).toFixed(0)} %`)
  console.log(`      справочно: криков «по окончании паузы» в медиане ${(100 * liveStat.heldMedian).toFixed(0)} % — для сытого тела это означает лишь изобилие, а не независимость (см. раздел 5)`)
})

// ── 4. Избирательность ───────────────────────────────────────────────────────
const sweep = await page.evaluate(({PERIODS, seeds}) => {
  const d = window.lanternDebug, R = d.rules(), loud = R.pulseStrength * R.gateBoost, rows = []
  let stray = 0
  const run = (seed, i, tune, ablate, period) => {
    d.reset(seed)
    const quiet = d.ablate('EMIT', i), restore = ablate ? d.ablate(ablate) : null
    if (tune) d.tune(i, tune)
    const every = Math.max(1, Math.round(period * 60)), before = d.getState().bodies[i].emitted
    for (let s = 0; s < 1800; s++) {
      if (s % every === 0) d.stimulate(i, loud, 0)
      const t = d.trace(1)
      stray += t.arrivals.filter((a) => a.to === i).length + t.emits.filter((e) => e.i !== i).length
    }
    const cries = d.getState().bodies[i].emitted - before
    if (restore) restore()
    quiet()
    return cries
  }
  for (const seed of seeds) {
    for (const T of [.6, 1.0]) for (const p of PERIODS) rows.push({kind: 'T=' + T, p, cries: run(seed, 1, {period: T}, null, p)})
    for (const p of PERIODS) rows.push({kind: 'noFILTER', p, cries: run(seed, 1, null, 'FILTER', p)})
    for (const p of PERIODS) rows.push({kind: 'noSENSE', p, cries: run(seed, 1, null, 'SENSE', p)})
  }
  return {rows, stray}
}, {PERIODS, seeds: [1, 2, 3, 4, 5]})
const med = (kind, p) => median(sweep.rows.filter((r) => r.kind === kind && r.p === p).map((r) => r.cries))
const maxOf = (kind, ps) => Math.max(...sweep.rows.filter((r) => r.kind === kind && ps.includes(r.p)).map((r) => r.cries))
report.sweep = {stray: sweep.stray, cells: Object.fromEntries(['T=0.6', 'T=1', 'noFILTER', 'noSENSE'].map((k) => [k, PERIODS.map((p) => med(k, p))]))}
await section('4. Избирательность: один и тот же сигнал (сила «крик с порогом», 30 с) изолированному слушателю', async () => {
  console.log('      криков в ответ, медиана по 5 seed:   ' + PERIODS.map((p) => `p=${p}`.padStart(6)).join(''))
  for (const k of ['T=0.6', 'T=1', 'noFILTER', 'noSENSE']) console.log(`      ${k.padEnd(36)}` + PERIODS.map((p) => String(med(k, p)).padStart(6)).join(''))
  check(`${ISOLATION_NOTE} во всех прогонах развёртки`, sweep.stray === 0, `чужих событий: ${sweep.stray}`)
  check('без SENSE тело не отвечает ни на один сигнал', maxOf('noSENSE', PERIODS) === 0)
  check('настроенный на 0.6 с отвечает на сигналы 0.5–0.6 с', med('T=0.6', .5) >= 15 && med('T=0.6', .6) >= 15, `${med('T=0.6', .5)} / ${med('T=0.6', .6)}`)
  check('настроенный на 0.6 с не отвечает на сигналы 1.2–2.0 с', maxOf('T=0.6', [1.2, 1.5, 2]) === 0)
  check('настроенный на 1.0 с отвечает на сигналы 0.9–1.2 с', med('T=1', .9) >= 10 && med('T=1', 1) >= 10 && med('T=1', 1.2) >= 5, `${med('T=1', .9)} / ${med('T=1', 1)} / ${med('T=1', 1.2)}`)
  check('настроенный на 1.0 с не отвечает на сигналы 2.0 с', maxOf('T=1', [2]) <= 1, String(med('T=1', 2)))
  check('тот же сигнал (период 1.2 с) — три разных последствия: 0 / ≥ 5 / 0 и без фильтра ≥ 5',
    med('T=0.6', 1.2) === 0 && med('T=1', 1.2) >= 5 && med('noFILTER', 1.2) >= 5 && med('noSENSE', 1.2) === 0,
    `${med('T=0.6', 1.2)} / ${med('T=1', 1.2)} / ${med('noSENSE', 1.2)} / ${med('noFILTER', 1.2)}`)
  check('без фильтра тело отвечает на весь диапазон — от частых сигналов к редким', med('noFILTER', .5) >= 15 && med('noFILTER', 2) >= 3 && med('noFILTER', .5) > med('noFILTER', 2), `${med('noFILTER', .5)} → ${med('noFILTER', 2)}`)
})

// ── 5. Зависимость от партнёров ──────────────────────────────────────────────
// Не всякий слушатель обязан замолкнуть без партнёров — и это следует из его графа: тело со
// следом (MEMORY) кричит ещё несколько секунд, тело с сильной самораскруткой способно крутить
// себя само, тело без порога может кричать от одной «погоды». Зависимость проверяется на
// «простом» слушателе: слух, порог, без следа и без петли; слушатели со следом — контраст.
const dep = await page.evaluate(({seeds}) => seeds.map((seed) => {
  const d = window.lanternDebug
  const listener = (b) => b.ops.includes('SENSE') && !b.ops.includes('SOURCE')
  const measure = (kind) => {
    d.reset(seed)
    const s = d.structure(), t0 = d.trace(1800)
    const heard = s.bodies.map((_, i) => t0.arrivals.filter((a) => a.to === i && a.heard).length)
    const ok = s.bodies.map((b, i) => i).filter((i) => kind === 'plain'
      ? listener(s.bodies[i]) && s.bodies[i].ops.includes('GATE') && !s.bodies[i].ops.includes('MEMORY') && !(s.bodies[i].ops.includes('FEEDBACK') && s.bodies[i].p.loop > 0)
      : listener(s.bodies[i]) && s.bodies[i].ops.includes('MEMORY'))
    if (!ok.length) return null
    const li = ok.sort((a, b) => heard[b] - heard[a])[0]
    const before = d.getState().bodies[li].emitted
    d.trace(480)
    const rateBefore = (d.getState().bodies[li].emitted - before) / 8
    const quiet = d.ablate('EMIT', li)
    d.trace(360)
    const at6 = d.getState().bodies[li].emitted
    d.trace(480)
    const after = d.getState().bodies[li].emitted - at6
    quiet()
    return {id: s.bodies[li].id, ops: s.bodies[li].ops.join(','), rateBefore, after}
  }
  return {seed, plain: measure('plain'), memory: measure('memory')}
}), {seeds: SEEDS})
const plainActive = dep.map((r) => r.plain).filter((r) => r && r.rateBefore >= .2)
const memoryActive = dep.map((r) => r.memory).filter((r) => r && r.rateBefore >= .2)
report.dependence = {plain: plainActive.length, memory: memoryActive.length, worlds: dep.length,
  silentPlain: share(plainActive, (r) => r.after === 0), afterPlain: median(plainActive.map((r) => r.after)),
  afterMemory: memoryActive.length ? median(memoryActive.map((r) => r.after)) : null}
await section('5. Зависимость: заглушить всех партнёров слушателя (криков за 6–14 с после заглушения)', async () => {
  console.log(`      миров с активным «простым» слушателем: ${plainActive.length}; со слушателем со следом: ${memoryActive.length} (из ${dep.length})`)
  check('есть что измерять: «простых» слушателей не меньше 20', plainActive.length >= 20, String(plainActive.length))
  check('«простой» слушатель (слух, порог, без следа и петли) замолкает — в ≥ 95 % миров', report.dependence.silentPlain >= .95,
    `${(100 * report.dependence.silentPlain).toFixed(0)} %; медиана криков после заглушения ${report.dependence.afterPlain}`)
  check('контраст: слушатель со следом кричит после заглушения дольше — медиана не меньше чем на 1 крик',
    report.dependence.afterMemory !== null && report.dependence.afterMemory >= report.dependence.afterPlain + 1,
    `со следом ${report.dependence.afterMemory}, простой ${report.dependence.afterPlain}`)
})

// ── 6. Операторы по одному ───────────────────────────────────────────────────
const single = await page.evaluate(() => {
  const d = window.lanternDebug, R = d.rules(), loud = R.pulseStrength * R.gateBoost, out = {stray: 0}
  const note = (t, i) => { out.stray += t.arrivals.filter((a) => a.to === i).length + t.emits.filter((e) => e.i !== i).length }
  const calm = (i) => { let s = 0; while (s < 3000 && !(d.getState().bodies[i].energy < .30 && d.getState().bodies[i].cooldown === 0)) { note(d.trace(1), i); s++ } return s }
  // SOURCE — тело 0 (глухой источник): кричит само; без SOURCE не кричит вовсе.
  { const run = (ablate) => { d.reset(1); const quiet = d.ablate('EMIT', 0), undo = ablate ? d.ablate(ablate) : null
      const t = d.trace(600); note(t, 0); const cries = t.emits.filter((e) => e.i === 0).length
      if (undo) undo(); quiet(); return cries }
    out.source = {with: run(null), without: run('SOURCE')} }
  // FEEDBACK — знак петли решает: раскачивает или сдерживает.
  { const run = (loop) => { d.reset(1); const quiet = d.ablate('EMIT', 0); d.tune(0, {loop})
      const t = d.trace(600); note(t, 0); const cries = t.emits.filter((e) => e.i === 0).length; quiet(); return cries }
    out.feedback = {plus: run(.3), zero: run(0), minus: run(-.3)} }
  // GATE — с порогом тело кричит реже; крик с порогом громче (константы), без порога — тише.
  { const run = (ablate) => { d.reset(1); const quiet = d.ablate('EMIT', 1), undo = ablate ? d.ablate(ablate) : null
      d.tune(1, {period: 1})
      const before = d.getState().bodies[1].emitted; let gated = 0
      for (let s = 0; s < 1200; s++) { if (s % 60 === 0) d.stimulate(1, loud, 0); const t = d.trace(1); note(t, 1); gated += t.emits.filter((e) => e.i === 1 && e.gated).length }
      const cries = d.getState().bodies[1].emitted - before
      if (undo) undo(); quiet(); return {cries, gated} }
    out.gate = {with: run(null), without: run('GATE')} }
  // DELAY — крик приходит не раньше задержки; без DELAY — сразу.
  { const run = (ablate) => { d.reset(1); const quiet = d.ablate('EMIT', 2), undo = ablate ? d.ablate(ablate) : null
      const delay = d.structure().bodies[2].p.delay
      calm(2)
      d.stimulate(2, loud * 2, 0)
      let lag = -1
      for (let k = 0; k < 180 && lag < 0; k++) { const t = d.trace(1); note(t, 2); if (t.emits.some((e) => e.i === 2)) lag = k + 1 }
      if (undo) undo(); quiet(); return {lag, delay} }
    out.delay = {with: run(null), without: run('DELAY')} }
  // MEMORY — след питает тело после того, как сигналы прекратились.
  { const run = (ablate) => { d.reset(1); const quiet = d.ablate('EMIT', 2), undo = ablate ? d.ablate(ablate) : null
      calm(2)
      const before = d.getState().bodies[2].emitted
      for (let s = 0; s < 480; s++) { if (s % 60 === 0) d.stimulate(2, loud, 0); note(d.trace(1), 2) }
      d.trace(90)                                                    // последние задержанные входят
      const at = d.getState().bodies[2].emitted
      d.trace(600)                                                   // 10 с тишины
      const after = d.getState().bodies[2].emitted - at
      const trace = d.getState().bodies[2].trace
      if (undo) undo(); quiet(); return {cries: at - before, after, trace} }
    out.memory = {with: run(null), without: run('MEMORY')} }
  return out
}, )
report.single = single
await section('6. Операторы по одному (изолированное тело, контролируемый сигнал)', async () => {
  check(`${ISOLATION_NOTE} во всех опытах раздела`, single.stray === 0, `чужих событий: ${single.stray}`)
  check('SOURCE: источник кричит сам ≥ 5 раз за 10 с', single.source.with >= 5, String(single.source.with))
  check('SOURCE: без него тело не кричит вовсе', single.source.without === 0, String(single.source.without))
  check('FEEDBACK: петля раскачивает, тормоз сдерживает (плюс > ноль > минус)', single.feedback.plus > single.feedback.zero && single.feedback.zero > single.feedback.minus,
    `+0.3 → ${single.feedback.plus}; 0 → ${single.feedback.zero}; −0.3 → ${single.feedback.minus} криков за 10 с`)
  check('GATE: без порога тело кричит чаще (≥ 1.5 раза) при том же сигнале', single.gate.without.cries >= 1.5 * single.gate.with.cries,
    `с порогом ${single.gate.with.cries}, без порога ${single.gate.without.cries} за 20 с`)
  check('GATE: крик с порогом громче, без порога — тише (константы)', RULES.gateBoost > 1 && RULES.leakDamp < 1 && single.gate.with.gated === single.gate.with.cries && single.gate.without.gated === 0,
    `×${RULES.gateBoost} / ×${RULES.leakDamp}`)
  check('DELAY: крик приходит не раньше задержки', single.delay.with.lag >= .8 * single.delay.with.delay * 60,
    `задержка ${fmt(single.delay.with.delay, 2)} с → крик через ${fmt(single.delay.with.lag / 60, 2)} с`)
  check('DELAY: без него крик приходит сразу (≤ 3 кадров)', single.delay.without.lag >= 0 && single.delay.without.lag <= 3,
    `${single.delay.without.lag} кадр(ов) = ${fmt(single.delay.without.lag / 60, 2)} с`)
  check('MEMORY: после прекращения сигналов тело ещё кричит', single.memory.with.after >= 2, `${single.memory.with.after} криков за 10 с тишины; след ${fmt(single.memory.with.trace, 2)}`)
  check('MEMORY: без следа тело замолкает сразу', single.memory.with.after >= single.memory.without.after + 2, `без MEMORY: ${single.memory.without.after}`)
})

// ── 7. Присутствие ───────────────────────────────────────────────────────────
const presence = await page.evaluate(({seeds}) => seeds.map((seed) => {
  const d = window.lanternDebug, R = d.rules()
  d.reset(seed)
  const s = d.structure()
  const t = d.trace(1800)
  const heard = s.bodies.map((_, i) => t.arrivals.filter((a) => a.to === i && a.heard).length)
  const listeners = s.bodies.map((b, i) => i).filter((i) => s.bodies[i].ops.includes('SENSE') && !s.bodies[i].ops.includes('SOURCE'))
  const li = listeners.sort((a, b) => heard[b] - heard[a])[0]
  // В наблюдении двойник неотличим: сравнить энергию каждого тела.
  const twinGap = Math.max(...d.getState().bodies.map((b, i) => Math.abs(b.energy - d.shadow().bodies[i].energy)))
  const twinEm = [d.getState().emissions, d.shadow().emissions]
  const lay = d.spatialLayout()[li]
  const before = d.getState().bodies[li].emitted, shadowBefore = d.shadow().bodies[li].emitted
  d.injectPresence([{x: lay.x, y: lay.y - 1.7, z: lay.z, range: 1.05, strength: .9}], 'perturb')
  d.trace(300)
  return {seed, id: s.bodies[li].id, twinGap, twinEm, after: d.getState().bodies[li].emitted - before, shadowAfter: d.shadow().bodies[li].emitted - shadowBefore}
}), {seeds: SEEDS})
const reacts = presence.filter((r) => (r.shadowAfter === 0 && r.after > 0) || r.after >= 2 * r.shadowAfter)
report.presence = {react: reacts.length / presence.length, ratio: median(presence.map((r) => (r.after + 1) / (r.shadowAfter + 1))),
  twinGap: Math.max(...presence.map((r) => r.twinGap))}
await section('7. Присутствие: «мир без вас» и рука у тела', async () => {
  check('в режиме наблюдения двойник неотличим: энергия каждого тела совпадает точно', report.presence.twinGap === 0, `наибольшая разница ${report.presence.twinGap}`)
  check('в режиме наблюдения двойник неотличим: число импульсов равно', presence.every((r) => r.twinEm[0] === r.twinEm[1]))
  check('рука у тела-слушателя за 5 с удваивает число криков или выводит из молчания — в ≥ 80 % миров', report.presence.react >= .8,
    `${(100 * report.presence.react).toFixed(0)} % миров; медиана отношения ${fmt(report.presence.ratio, 2)}`)
})

// ── 8. Seed ──────────────────────────────────────────────────────────────────
await section('8. Seed: независимость соседей и возможные графы', async () => {
  // Возможные графы по правилам роста (growGraph): вход — SOURCE, SENSE или оба; FILTER, DELAY,
  // MEMORY — только с SENSE; FEEDBACK — нет / плюс / минус; GATE — нет / есть. EMIT у всех.
  const possible = new Set()
  for (const source of [0, 1]) for (const sense of [0, 1]) {
    if (!source && !sense) continue
    for (let m = 0; m < 8; m++) for (const fb of ['', '+', '-']) for (const gate of [0, 1]) {
      const ops = [source && 'SOURCE', sense && 'SENSE', sense && (m & 1) && 'FILTER', sense && (m & 2) && 'DELAY', sense && (m & 4) && 'MEMORY'].filter(Boolean)
      possible.add(ops.join(',') + '|F' + fb + '|G' + gate)
    }
  }
  const keyOf = (b) => b.ops.filter((o) => o !== 'FEEDBACK' && o !== 'GATE' && o !== 'EMIT').join(',') + '|F' + (b.ops.includes('FEEDBACK') ? (b.p.loop > 0 ? '+' : '-') : '') + '|G' + (b.ops.includes('GATE') ? 1 : 0)
  const realized = new Set(structures.flatMap((s) => s.bodies.map(keyOf)))
  const sameCount = [], sameBoth = []
  const adjacent = await page.evaluate(() => {
    const d = window.lanternDebug, a = [], b = []
    let prev = null
    for (let s = 1; s <= 20000; s++) { d.reset(s); const st = d.structure(); if (prev && prev.n === st.bodies.length) a.push(1); if (prev && prev.n === st.bodies.length && prev.reach === st.reach) b.push(1); prev = {n: st.bodies.length, reach: st.reach} }
    return {a: a.length, b: b.length}
  })
  const perWorld = structures.map((s) => new Set(s.bodies.map(keyOf)).size)
  report.seeds = {possible: possible.size, realized: realized.size, bodies: structures.reduce((n, s) => n + s.bodies.length, 0),
    perWorldMedian: median(perWorld), sameCount: adjacent.a / 20000, sameBoth: adjacent.b / 20000}
  console.log(`      возможных графов ${possible.size}; актуализировано ${realized.size} на ${report.seeds.bodies} тел в ${structures.length} мирах; в одном мире — медиана ${median(perWorld)}`)
  check('правила роста допускают сто два графа (перечисление)', possible.size === 102, String(possible.size))
  check('каждый выращенный граф допустим по правилам роста', [...realized].every((k) => possible.has(k)))
  check('виртуальное больше актуального: один мир актуализирует лишь часть возможных графов', median(perWorld) < possible.size / 4,
    `в медианном мире ${median(perWorld)} из ${possible.size}`)
  check('в грамматике нет недостижимых графов: на 400 мирах встретились почти все', realized.size >= possible.size - 2,
    `${realized.size} из ${possible.size} на ${report.seeds.bodies} тел`)
  check('соседние seed независимы: число тел совпадает примерно в 1/7 случаев', report.seeds.sameCount > .1 && report.seeds.sameCount < .2, `${(100 * report.seeds.sameCount).toFixed(1)} %`)
  check('соседние seed не дают одинаковой структуры (число тел и порог связи)', report.seeds.sameBoth === 0, `${(100 * report.seeds.sameBoth).toFixed(1)} %`)
  // А без перемешивания (seedMix) первый бросок генератора — линейная функция seed: у соседних
  // seed одно число тел почти всегда, то есть «тот же мир» под другим номером. Считается прямо.
  const rawCount = (s) => 6 + Math.floor(7 * ((Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
  let rawSame = 0, run = 1, longest = 1
  for (let s = 1; s <= 20000; s++) if (rawCount(s) === rawCount(s + 1)) rawSame++
  for (let s = 1; s <= 1 << 22; s++) { run = rawCount(s) === rawCount(s + 1) ? run + 1 : 1; longest = Math.max(longest, run) }
  report.seeds.rawSame = rawSame / 20000; report.seeds.longest = longest
  check('без перемешивания seed соседние seed дают одно число тел почти всегда — вот зачем премикс', report.seeds.rawSame >= .99 && longest >= 300,
    `${(100 * report.seeds.rawSame).toFixed(1)} %, рекорд ${longest} seed подряд`)
  // Громкость мира — его население: те же 400 seed, 30 с мира, ранговая корреляция числа
  // импульсов с числом тел и со связями. Порог 0.8 выбран ПОСЛЕ зонда на seed 1…400 (0.88 и
  // 0.86) — это не заранее записанная цель. Число разных графов в мире растёт вместе с
  // населением, поэтому контраста «с населением, а не с графами» нет — и он не утверждается.
  const loud = await page.evaluate(({seeds, steps}) => seeds.map((seed) => {
    const d = window.lanternDebug
    d.reset(seed); d.simulate(steps)
    const st = d.structure()
    return {em: d.getState().emissions, bodies: st.bodies.length, links: st.links.length,
      graphs: new Set(st.bodies.map((b) => b.ops.join(',') + '|' + b.p.loop + '|' + b.ops.includes('GATE'))).size}
  }), {seeds: structures.map((s) => s.seed), steps: SECONDS * 60})
  const col = (k) => loud.map((r) => r[k]), rho = (k) => spearman(col('em'), col(k))
  const byBodies = {}
  for (const r of loud) (byBodies[r.bodies] = byBodies[r.bodies] || []).push(r.em)
  report.seeds.rhoBodies = rho('bodies'); report.seeds.rhoLinks = rho('links'); report.seeds.rhoGraphs = rho('graphs')
  report.seeds.emByBodies = Object.fromEntries(Object.keys(byBodies).map(Number).sort((a, b) => a - b).map((n) => [n, median(byBodies[n])]))
  console.log(`      импульсов за ${SECONDS} с (400 миров): корреляция ${fmt(report.seeds.rhoBodies, 2)} с числом тел, ${fmt(report.seeds.rhoLinks, 2)} — со связями, ${fmt(report.seeds.rhoGraphs, 2)} — с числом разных графов; медианы по числу тел: ` +
    Object.entries(report.seeds.emByBodies).map(([n, v]) => `${n}: ${v}`).join(' | '))
  check('громкость мира — его население: импульсов за 30 с тем больше, чем больше тел и связей', report.seeds.rhoBodies >= .8 && report.seeds.rhoLinks >= .8,
    `корреляция ${fmt(report.seeds.rhoBodies, 2)} с числом тел, ${fmt(report.seeds.rhoLinks, 2)} со связями`)
})

// ── 9. «Как это читается» и имена ────────────────────────────────────────────
await section('9. «Как это читается» и имена', async () => {
  const readings = await page.evaluate(() => {
    const d = window.lanternDebug
    d.reset(1)
    d.trace(900)
    const out = new Set()
    for (let k = 0; k < 12; k++) { out.add(d.reading()); d.trace(150) }
    return {first: window.lanternDebug.reading(), set: [...out], ru: d.names('ru'), en: d.names('en')}
  })
  // Почему у общего поля аргументы сдвинуты в плюс: p.noise зеркалит отрицательные координаты.
  // Отдельный экземпляр p5 в режиме instance — чтобы не трогать холст опыта.
  const mirror = await page.evaluate(() => new Promise((resolve) => {
    const P5 = /** @type {any} */ (window).p5   // глобаль опыта с CDN — есть только в странице
    new P5((sk) => { sk.setup = () => {   // eslint-disable-line no-new
      const n = (x) => sk.noise(x, .63, 2.2)
      const a = n(-2.31), b = n(2.31), c = n(1.37)
      sk.remove()
      resolve({mirror: Math.abs(a - b), other: Math.abs(a - c)})
    } })
  }))
  report.field = mirror
  check('поле среды не зеркально: p.noise(-x, y, z) = p.noise(x, y, z), поэтому аргументы сдвинуты в плюс', mirror.mirror === 0 && mirror.other > .01,
    `разница с отражением ${mirror.mirror}, с соседней точкой ${fmt(mirror.other)}`)
  check('чтение события — непустая строка без несработавших подстановок', readings.set.length > 0 && readings.set.every((s) => s.trim().length > 0 && !s.includes('{')), readings.set.slice(0, 4).join(' | '))
  check('чтение меняется от события к событию', readings.set.length >= 2, `различных прочтений за 12 событий: ${readings.set.length}`)
  check('имена тел на обоих языках — непустые, английские без кириллицы', readings.ru.every((n) => n.trim().length > 0) && readings.en.every((n) => n.trim().length > 0 && !/[А-Яа-я]/.test(n)),
    readings.ru.slice(0, 3).join(' · ') + ' / ' + readings.en.slice(0, 3).join(' · '))
})

check('нет ошибок страницы', errors.length === 0, errors.slice(0, 3).join(' | '))
writeFileSync(join(here, 'tmp', 'rules-ab.json'), JSON.stringify(report, null, 2))
await browser.close()
console.log(failed ? `\n${failed} провалено, ${passed} пройдено; числа: test/tmp/rules-ab.json` : `\nправила пройдены: ${passed} проверок; числа: test/tmp/rules-ab.json`)
process.exit(failed ? 1 : 0)
