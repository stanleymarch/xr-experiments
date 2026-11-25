// rules-ab.mjs — «что обещано правилами» против «что делает мир».
//
// Задание семинара просит сравнить предложенную моделью логику с фактическим
// поведением системы. Здесь каждое сравнение — измерение, а не пересказ кода:
//   1. контроль: абляция действительно выключает оператор (без EMIT импульсов нет)
//      и возвращается как было;
//   2. абляция: убираем по ОДНОМУ оператору у всех тел (lanternDebug.ablate) и смотрим,
//      что изменилось у затронутых тел — частота импульсов, ровность ритма, доля
//      импульсов «по окончании паузы» и ответ на прилёт (lanternDebug.trace);
//   3. каждое тело по своей программе — в каком режиме оно живёт;
//   4. диапазон миров: 400 seed → сколько импульсов мир выдаёт за первые 30 с;
//   5. соседние seed (что было бы без перемешивания — арифметика) и устройство мира:
//      тела за спиной, набор программ, отражение, порог связи;
//   6. почему полю сделан сдвиг в положительные координаты: p.noise зеркалит минус.
// Числа из этого прогона приведены в docs/lantern-void-rules.md (часть 2); проверок-
// утверждений ровно столько, сколько качественных утверждений в документе.
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
const pct = (v, d = 1) => `${fmt(100 * v, d)} %`
const pair = (b, a, d) => `${fmt(b, d)} → ${fmt(a, d)}`
const rel = (a, b) => (100 * (a / b - 1) >= 0 ? '+' : '') + fmt(100 * (a / b - 1), 1) + ' %'

// ── Условия эксперимента ──────────────────────────────────────────────────────
const SECONDS = 60, STEPS = SECONDS * 60
const FROM = 600                    // считать с 10-й секунды: стартовые состояния уже забыты
const WINDOW = SECONDS - FROM / 60  // 50 секунд наблюдения
const HORIZONS = [6, 30, 90]        // «ответил на прилёт»: импульс в течение 0.1 / 0.5 / 1.5 с
const BEFORE = [36, 30]            // контроль: импульс за 0.5–0.6 с ДО прилёта (импульс ещё в пути)
const OPS = ['NOISE', 'SENSE', 'FILTER', 'DELAY', 'MEMORY', 'FEEDBACK', 'GATE', 'EMIT']
const SEEDS = [140821, 1, 7, 42, 777, 2026, 31337, 99991, 5, 11, 101, 1009, 2027, 31338, 65537, 99992]

// ── Анализ трассы (считается в Node, чтобы формулы были видны) ────────────────
// after(steps, s) — номер первого импульса из steps строго после шага s (двоичный поиск).
const after = (steps, s) => {
  let lo = 0, hi = steps.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (steps[m] <= s) lo = m + 1; else hi = m }
  return lo
}
// baseProb(steps, h) — вероятность того, что за произвольным моментом окна в течение h
// шагов последует импульс: база, с которой сравнивается поведение после прилёта.
function baseProb(steps, h) {
  let hit = 0, lo = 0, hi = 0
  const total = STEPS - h - FROM
  for (let s = FROM; s < STEPS - h; s++) {
    while (hi < steps.length && steps[hi] <= s + h) hi++
    while (lo < steps.length && steps[lo] <= s) lo++
    if (hi > lo) hit++
  }
  return hit / total
}
// measure(trace, opsOf, need, names, name) — поведение тел ОДНОГО мира: тех, в исходной
// программе которых есть все операторы из need ([] — любые) и которые несут программу
// name ([] — любая).
function measure(trace, opsOf, need, names, name) {
  const bodies = opsOf.map((_, i) => i).filter((i) => need.every((o) => opsOf[i].includes(o)) && (!name || names[i] === name))
  const emits = opsOf.map(() => [])
  for (const e of trace.emits) if (e.step >= FROM) emits[e.i].push(e)
  const H = HORIZONS[HORIZONS.length - 1]
  const cvs = []
  const resp = HORIZONS.map(() => 0), base = HORIZONS.map(() => 0)
  let held = 0, total = 0, arrivals = 0, energySum = 0, beforeHit = 0
  for (const i of bodies) {
    const ev = emits[i], steps = ev.map((e) => e.step)
    total += ev.length; held += ev.filter((e) => e.held).length; energySum += trace.energy[i]
    if (ev.length >= 4) { // ритм: вариация межимпульсных интервалов (0 — метроном)
      const gaps = steps.slice(1).map((s, k) => s - steps[k])
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
      cvs.push(Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length) / mean)
    }
    const baseP = HORIZONS.map((h) => baseProb(steps, h))
    for (const a of trace.arrivals) {
      if (a.to !== i || a.step < FROM + BEFORE[0] || a.step >= STEPS - H) continue
      const k = after(steps, a.step)
      arrivals++
      if (after(steps, a.step - BEFORE[1]) > after(steps, a.step - BEFORE[0])) beforeHit++
      HORIZONS.forEach((h, j) => {
        base[j] += baseP[j]
        if (k < steps.length && steps[k] - a.step <= h) resp[j]++
      })
    }
  }
  const n = bodies.length
  return {
    bodies: n, emits: total, arrivals,
    rate: n ? total / (n * WINDOW) : NaN,   // импульсов в секунду на тело
    cv: cvs.length ? cvs.reduce((a, b) => a + b, 0) / cvs.length : NaN,
    held: total ? held / total : NaN,       // доля импульсов, начавшихся сразу по окончании паузы
    energy: n ? energySum / n : NaN,        // средняя энергия (0…1)
    response: resp.map((v) => (arrivals ? v / arrivals : NaN)), // после прилёта
    base: base.map((v) => (arrivals ? v / arrivals : NaN)),     // в произвольный момент
    before: arrivals ? beforeHit / arrivals : NaN,               // за 0.5–0.6 с до прилёта
  }
}
const KEYS = ['rate', 'cv', 'held', 'energy']
// avg — среднее по мирам (миры без подходящих тел не учитываются); response и base —
// по каждому горизонту из HORIZONS.
const avg = (rows) => {
  const use = rows.filter((r) => r.bodies > 0)
  const mean = (f) => { const v = use.map(f).filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN }
  return {worlds: use.length, ...Object.fromEntries(KEYS.map((k) => [k, mean((r) => r[k])])),
    response: HORIZONS.map((_, j) => mean((r) => r.response[j])), base: HORIZONS.map((_, j) => mean((r) => r.base[j])),
    before: mean((r) => r.before)}
}
const pearson = (x, y) => {
  const mx = x.reduce((a, b) => a + b, 0) / x.length, my = y.reduce((a, b) => a + b, 0) / y.length
  return x.reduce((a, v, i) => a + (v - mx) * (y[i] - my), 0) / Math.sqrt(x.reduce((a, v) => a + (v - mx) ** 2, 0) * y.reduce((a, v) => a + (v - my) ** 2, 0))
}
const rank = (a) => a.map((x) => a.filter((y) => y < x).length + 1 + (a.filter((y) => y === x).length - 1) / 2)

const browser = await chromium.launch()
const page = await browser.newPage({viewport: {width: 1366, height: 768}})
await page.goto(`${BASE}/`, {waitUntil: 'domcontentloaded'})
await page.waitForTimeout(2600)
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
const report = {}

// ── 1–3. Абляция операторов и режимы тел ──────────────────────────────────────
const data = await page.evaluate(({seeds, ops, steps}) => {
  const d = window.lanternDebug, out = []
  for (const seed of seeds) {
    d.reset(seed)
    const st = d.structure(), opsOf = st.bodies.map((b) => [...b.ops]), names = st.bodies.map((b) => b.program), memory = st.bodies.map((b) => b.memory)
    const runs = {baseline: d.trace(steps)}, effect = {}
    for (const op of ops) {
      const restore = d.ablate(op)
      effect[op] = {removed: d.structure().bodies.every((b) => !b.ops.includes(op))}
      runs[op] = d.trace(steps)
      restore()
      effect[op].restored = d.structure().bodies.every((b, i) => b.ops.length === opsOf[i].length && b.ops.every((o, k) => o === opsOf[i][k]))
    }
    out.push({seed, opsOf, names, memory, runs, effect})
  }
  return out
}, {seeds: SEEDS, ops: OPS, steps: STEPS})

await section('1. Контроль: абляция выключает оператор и возвращается как было', async () => {
  const whole = data.map((w) => ({with: measure(w.runs.baseline, w.opsOf, []).emits, without: measure(w.runs.EMIT, w.opsOf, []).emits}))
  check('после ablate(op) оператора нет ни в одной программе; после возврата — у тех же тел', data.every((w) => OPS.every((op) => w.effect[op].removed && w.effect[op].restored)))
  check('без EMIT мир не излучает ни одного импульса', whole.every((r) => r.with > 0 && r.without === 0), whole.map((r) => `${r.with}→${r.without}`).join(' '))
})

const rows = []
await section(`2. Абляция по одному оператору: ${SEEDS.length} миров × ${SECONDS} с (с 10-й секунды, у затронутых тел)`, async () => {
  const world = (op) => data.reduce((s, w) => s + measure(w.runs[op], w.opsOf, []).emits, 0)
  for (const op of OPS.filter((o) => o !== 'EMIT')) {
    const before = data.map((w) => measure(w.runs.baseline, w.opsOf, [op]))
    const after = data.map((w) => measure(w.runs[op], w.opsOf, [op]))
    const used = before.map((b, i) => ({b, a: after[i]})).filter((p) => p.b.bodies > 0)
    rows.push({op, worlds: used.length, b: avg(before), a: avg(after),
      fewer: used.filter((p) => p.a.rate < p.b.rate).length, worldBefore: world('baseline'), worldAfter: world(op)})
  }
  report.ablation = rows
  const line = (r, b, a) => `  ${r.op.padEnd(9)} ${pair(b.rate, a.rate).padStart(13)}   ${pair(b.cv, a.cv, 2).padStart(11)}   ${pair(b.held, a.held, 2).padStart(11)}   ${pair(b.energy, a.energy, 2).padStart(9)}   ` +
    HORIZONS.map((_, j) => `${pair(b.response[j], a.response[j], 2)} (${pair(b.base[j], a.base[j], 2)})`).join('  ') + `  до прилёта ${pair(b.before, a.before, 2)}`
  console.log('  оператор   имп/с на тело: было → без  ритм (CV)  ждали паузу  энергия  ответил за ' + HORIZONS.map((h) => `${fmt(h / 60, 1)} с`).join(' / ') + ': было → без (в произвольный момент: было → без; за 0.5–0.6 с до прилёта: было → без)')
  for (const r of rows) console.log(line(r, r.b, r.a))
  console.log('\n  миры, где импульсов у затронутых тел стало меньше / всего; мир целиком: было → без оператора')
  for (const r of rows) console.log(`  ${r.op.padEnd(9)} ${r.fewer} / ${r.worlds} · ${r.worldBefore} → ${r.worldAfter} (${rel(r.worldAfter, r.worldBefore)})`)
})

await section('3. Тело по программе — режим, в котором оно живёт (те же миры, без абляции)', async () => {
  const programs = [...new Set(data.flatMap((w) => w.names))].map((name) => {
    const ms = data.map((w) => measure(w.runs.baseline, w.opsOf, [], w.names, name))
    const mem = data.flatMap((w) => w.memory.filter((_, i) => w.names[i] === name))
    return {name, ...avg(ms), memory: mem[0], pause: .66 + (1 - mem[0]) * .75}
  })
  report.programs = programs
  report.all = avg(data.map((w) => measure(w.runs.baseline, w.opsOf, [])))
  console.log(`  ${'программа'.padEnd(16)} память  пауза, с  миров  имп/с  лимит 1/пауза  ритм (CV)  ждали паузу  энергия  ответил за ${HORIZONS.map((h) => `${fmt(h / 60, 1)} с`).join(' / ')} (в произвольный момент)`)
  for (const p of programs) {
    console.log(`  ${p.name.padEnd(16)} ${fmt(p.memory, 2).padStart(6)}   ${fmt(p.pause, 2).padStart(7)}    ${String(p.worlds).padStart(5)}   ${fmt(p.rate, 2).padStart(5)}    ${fmt(1 / p.pause, 2).padStart(9)}       ${fmt(p.cv, 2)}       ${pct(p.held)}       ${fmt(p.energy, 2)}    ` +
      HORIZONS.map((_, j) => `${fmt(p.response[j], 2)} (${fmt(p.base[j], 2)})`).join('  '))
  }
  console.log(`  все тела: импульсов «сразу по окончании паузы» — ${pct(report.all.held)}; импульс в первые 0.1 с после прилёта — ${pct(report.all.response[0])}, в произвольный момент — ${pct(report.all.base[0])}, за 0.5–0.6 с до прилёта — ${pct(report.all.before)}`)

  const r = rows.find((x) => x.op === 'SENSE'), f = rows.find((x) => x.op === 'FEEDBACK'), g = rows.find((x) => x.op === 'GATE'), m = rows.find((x) => x.op === 'MEMORY')
  check('SENSE: без него затронутые тела излучают реже (сильно) — в каждом мире', r.fewer === r.worlds && r.a.rate < r.b.rate * .8, `${pct(1 - r.a.rate / r.b.rate)} реже; мир целиком ${rel(r.worldAfter, r.worldBefore)}`)
  check('FEEDBACK: без него реже и ритм неровнее — почти в каждом мире', f.fewer >= f.worlds - 2 && f.a.rate < f.b.rate * .9 && f.a.cv > f.b.cv, `${pct(1 - f.a.rate / f.b.rate)} реже; мир целиком ${rel(f.worldAfter, f.worldBefore)}`)
  check('MEMORY: без него чуть реже — в большинстве миров', m.fewer >= Math.ceil(m.worlds * .75) && m.a.rate < m.b.rate * .95, `${pct(1 - m.a.rate / m.b.rate)} реже; ${m.fewer} из ${m.worlds}`)
  check('GATE: без него порог на 8% ниже, и тела излучают чаще — почти в каждом мире', g.worlds - g.fewer >= g.worlds - 2 && g.a.rate > g.b.rate * 1.05, `${pct(g.a.rate / g.b.rate - 1)} чаще; мир целиком ${rel(g.worldAfter, g.worldBefore)}`)
  const quiet = rows.filter((x) => ['NOISE', 'FILTER', 'DELAY'].includes(x.op))
  check('NOISE, FILTER, DELAY: без каждого мир излучает почти столько же (±1.5%)', quiet.every((x) => Math.abs(x.worldAfter / x.worldBefore - 1) < .015), quiet.map((x) => `${x.op} ${rel(x.worldAfter, x.worldBefore)}`).join(', '))
  const o = report.all
  check('прилёт удваивает шанс немедленного импульса, но чаще всего тело не отвечает сразу', o.response[0] > 2 * o.base[0] && o.response[0] < .5, `в первые 0.1 с: ${pct(o.response[0])} против ${pct(o.base[0])} в произвольный момент`)
  check('контроль: ДО прилёта превышения нет — отклик вызван прилётом, а не общим оживлением', Math.abs(o.before - o.base[0]) < .03, `за 0.5–0.6 с до прилёта ${pct(o.before)} при базе ${pct(o.base[0])}`)
  const noSense = r.a
  check('отклик остаётся и без SENSE: энергию при прилёте получает каждое тело', noSense.response[0] > 2 * noSense.base[0] && noSense.before < noSense.response[0], `без SENSE в первые 0.1 с: ${pct(noSense.response[0])} против ${pct(noSense.base[0])}`)
  check('часть импульсов тело начинает только потому, что кончилась пауза (энергии уже хватало)', report.all.held > .25, `${pct(report.all.held)} импульсов`)
  const sr = pearson(rank(programs.map((p) => p.memory)), rank(programs.map((p) => p.rate)))
  check('чем длиннее «память» программы, тем короче пауза и тем чаще импульсы', sr >= .8, `ранговая корреляция память ↔ частота ${fmt(sr, 2)}`)
  check('никакое тело не импульсит чаще, чем позволяет его пауза', programs.every((p) => p.rate < 1 / p.pause), programs.map((p) => `${p.name} ${fmt(p.rate / (1 / p.pause))} лимита`).join(', '))
})

// ── 4. Диапазон миров ─────────────────────────────────────────────────────────
const seeds400 = (() => { // детерминированные 400 произвольных seed
  let s = 20261125
  return Array.from({length: 400}, () => (s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff))
})()
const worlds = await page.evaluate((seeds) => seeds.map((seed) => {
  const d = window.lanternDebug
  d.reset(seed)
  const st = d.structure()
  return {seed, bodies: st.bodies.length, reach: st.reach, kinds: new Set(st.bodies.map((b) => b.program)).size,
    links: st.links.length, emissions: d.simulate(1800).emissions}
}), [...seeds400, 140821])

await section('4. Диапазон миров: 400 seed, импульсы за первые 30 с', async () => {
  const ws = worlds.filter((w) => w.seed !== 140821)
  const em = ws.map((w) => w.emissions).sort((a, b) => a - b)
  const quiet = ws.reduce((a, b) => (b.emissions < a.emissions ? b : a))
  const loud = ws.reduce((a, b) => (b.emissions > a.emissions ? b : a))
  const perBody = ws.map((w) => w.emissions / w.bodies)
  const corr = Object.fromEntries(['bodies', 'links', 'reach', 'kinds'].map((k) => [k, pearson(ws.map((w) => w[k]), ws.map((w) => w.emissions))]))
  report.spread = {min: em[0], median: (em[199] + em[200]) / 2, max: em[399], quiet, loud, ...corr,
    perBodyMin: Math.min(...perBody), perBodyMax: Math.max(...perBody), start: worlds.find((w) => w.seed === 140821)}
  const s = report.spread
  console.log(`  минимум ${s.min} (seed ${s.quiet.seed}: ${s.quiet.bodies} тел, порог связи ${fmt(s.quiet.reach, 2)} м) · медиана ${fmt(s.median, 1)} · максимум ${s.max} (seed ${s.loud.seed}: ${s.loud.bodies} тел, порог связи ${fmt(s.loud.reach, 2)} м)`)
  console.log(`  на одно тело за 30 с: от ${fmt(s.perBodyMin, 1)} до ${fmt(s.perBodyMax, 1)} импульсов`)
  console.log(`  связь числа импульсов: с числом тел r=${fmt(s.bodies, 2)}, с числом связей r=${fmt(s.links, 2)}, с порогом связи r=${fmt(s.reach, 2)}, с числом видов программ r=${fmt(s.kinds, 2)}`)
  console.log(`  стартовый мир 140821: ${s.start.emissions} импульсов (${s.start.bodies} тел, порог связи ${fmt(s.start.reach, 2)} м)`)
  check('громкий мир кричит в несколько раз чаще тихого', s.max / s.min >= 5, `${s.max} / ${s.min} = ${fmt(s.max / s.min, 1)} раза`)
  check('число импульсов решает население мира (число тел и связей), а не «разговорчивость»-порог', s.bodies >= .7 && s.links >= .7 && s.reach < .5, `r: тела ${fmt(s.bodies, 2)}, связи ${fmt(s.links, 2)}, порог ${fmt(s.reach, 2)}`)
})

// ── 5. Соседние seed ──────────────────────────────────────────────────────────
await section('5. Соседние seed и устройство мира (20000 seed)', async () => {
  // Без seedMix первый бросок генератора — линейная функция seed: считаем её прямо здесь.
  const rawCount = (s) => 6 + Math.floor(7 * ((Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
  let same = 0, run = 1, longest = 1
  for (let s = 1; s <= 20000; s++) if (rawCount(s) === rawCount(s + 1)) same++
  for (let s = 1; s <= 1 << 22; s++) { run = rawCount(s) === rawCount(s + 1) ? run + 1 : 1; longest = Math.max(longest, run) }
  const stats = await page.evaluate(() => {
    const d = window.lanternDebug, behind = [0, 0, 0, 0], kinds = [0, 0, 0, 0, 0, 0]
    let flipped = 0, reachMin = Infinity, reachMax = 0, sameBodies = 0, sameBoth = 0, prev = null
    for (let s = 1; s <= 20000; s++) {
      d.reset(s)
      const st = d.structure(), n = st.bodies.length
      behind[st.bodies.filter((b) => b.layer === 'behind').length]++
      kinds[new Set(st.bodies.map((b) => b.program)).size]++
      if (st.bodies[0].x < 0) flipped++
      reachMin = Math.min(reachMin, st.reach); reachMax = Math.max(reachMax, st.reach)
      if (prev && prev.n === n) { sameBodies++; if (prev.reach === st.reach) sameBoth++ }
      prev = {n, reach: st.reach}
    }
    return {behind, kinds, flipped, reachMin, reachMax, sameBodies, sameBoth}
  })
  const n = report.neighbours = {rawSame: same / 20000, longest, mixedSame: stats.sameBodies / 20000, sameBoth: stats.sameBoth / 20000}
  const s = report.structure = {behind: stats.behind.map((v) => v / 20000), kinds: stats.kinds.map((v) => v / 20000), flipped: stats.flipped / 20000, reachMin: stats.reachMin, reachMax: stats.reachMax}
  console.log(`  без перемешивания: у соседних seed одно число тел в ${pct(n.rawSame)} случаев; самый длинный отрезок с одним числом тел — ${n.longest} seed подряд`)
  console.log(`  с перемешиванием: то же число тел у ${pct(n.mixedSame)} соседей; одинаковое число тел И порог связи — у ${pct(n.sameBoth)}`)
  console.log(`  тел за спиной: одно — ${pct(s.behind[1])}, два — ${pct(s.behind[2])}, ни одного — ${pct(s.behind[0])}`)
  console.log(`  видов программ в мире: 2 — ${pct(s.kinds[2])}, 3 — ${pct(s.kinds[3])}, 4 — ${pct(s.kinds[4])}, 5 — ${pct(s.kinds[5])}`)
  console.log(`  мир отражён слева направо: ${pct(s.flipped)}; порог связи ${fmt(s.reachMin, 3)}…${fmt(s.reachMax, 3)} м`)
  check('без перемешивания соседние seed почти всегда дают одно число тел', n.rawSame >= .99 && n.longest >= 300, `${pct(n.rawSame)}, рекорд ${n.longest} подряд`)
  check('с перемешиванием соседние seed независимы: совпадений около 1/7 и ни одной общей структуры', n.mixedSame > .1 && n.mixedSame < .2 && n.sameBoth === 0, `${pct(n.mixedSame)}; общая структура ${pct(n.sameBoth)}`)
  check('за спиной посетителя всегда есть тело — одно или два', s.behind[0] === 0 && s.behind[1] > 0 && s.behind[2] > 0 && s.behind[3] === 0)
  check('в мире бывает от 2 до 5 видов программ, и все варианты встречаются', [2, 3, 4, 5].every((k) => s.kinds[k] > .05) && s.kinds[0] + s.kinds[1] === 0)
  check('половина миров отражена слева направо', s.flipped > .45 && s.flipped < .55, pct(s.flipped))
})

// ── 6. Шум p5 и отрицательные координаты ──────────────────────────────────────
await section('6. p.noise и отрицательные координаты', async () => {
  const m = await page.evaluate(() => new Promise((resolve) => {
    // Отдельный экземпляр p5 в режиме instance, чтобы не трогать холст опыта.
    new p5((sk) => { // eslint-disable-line no-new
      sk.setup = () => {
        const n = (x) => sk.noise(x, .63, 2.2)
        const mirror = Math.abs(n(-2.31) - n(2.31))                  // точка и её отражение
        const varied = Math.max(...[1, 2, 3].map((k) => Math.abs(n(2.31) - n(2.31 + k * .37)))) // шум не константа
        sk.remove()
        resolve({mirror, varied})
      }
    })
  }))
  report.p5 = m
  check('p.noise(-x, y, z) = p.noise(x, y, z): шум зеркалит отрицательные координаты', m.mirror === 0 && m.varied > .01,
    `разница с отражением ${fmt(m.mirror, 6)}, с соседними точками ${fmt(m.varied, 3)}`)
})

check('нет ошибок страницы', errors.length === 0, errors.slice(0, 3).join(' | '))
writeFileSync(join(here, 'tmp', 'rules-ab.json'), JSON.stringify(report, null, 2))
await browser.close()
console.log(`\n${failed ? `${failed} провалено, ` : ''}${passed} пройдено; числа: test/tmp/rules-ab.json`)
process.exit(failed ? 1 : 0)
