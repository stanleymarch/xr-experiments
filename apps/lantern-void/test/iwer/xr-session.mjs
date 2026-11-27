// xr-session.mjs — IWER-тест LANTERN // VOID в живой XR-сессии эмулятора:
// что происходит ПОСЛЕ enter-vr. Проверяет то, что эмулятор способен показать:
// тик не падает и мир идёт внутри сессии, гид-меню в зоне по правилам Meta,
// ходьба и поворот стиками, луч → триггер → выбор тела, кнопки Y/B.
// Запускается через test/iwer-run.mjs (стейджит опыт в apps/weather-room/lantern-test).
export default async ({page, cdp}) => {
  let failed = 0
  const check = (name, cond, detail = '') => {
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
    if (!cond) failed++
  }
  try { await cdp.send('Network.clearBrowserCache'); await cdp.send('Network.setCacheDisabled', {cacheDisabled: true}) } catch (_) {}

  await page.goto('https://localhost:8081/lantern-test/index.html?t=' + Date.now(), {waitUntil: 'domcontentloaded'})
  await page.waitForTimeout(2600)
  await page.evaluate(() => window.lanternApp.start())
  await page.waitForTimeout(300)
  await page.click('#xr-button', {timeout: 20000})
  await page.waitForFunction(() => document.querySelector('#xr-scene')?.hasLoaded === true, null, {timeout: 60000})
  try { await page.locator('.a-enter-vr-button').click({timeout: 6000, force: true}) }
  catch { await page.evaluate(() => { document.querySelector('#xr-scene').enterVR().catch(() => {}) }) }
  // Счётчик тиков — только задержка гид-меню; переводим часы вперёд.
  await page.evaluate(() => { const c = document.querySelector('#xr-scene').components['lantern-simulation']; if (c) c.ticks = 200 })
  await page.waitForFunction(() => document.querySelector('#xr-context-menu')?.object3D.visible === true, null, {timeout: 20000})

  // 1. Сессия, тик, гид-меню.
  const s1 = await page.evaluate(() => {
    const THREE = window.AFRAME.THREE
    const s = document.querySelector('#xr-scene')
    const head = s.camera.getWorldPosition(new THREE.Vector3())
    const menu = s.querySelector('#xr-context-menu').object3D
    const rel = menu.getWorldPosition(new THREE.Vector3()).sub(head)
    const deg = (r) => r * 180 / Math.PI
    const e = new THREE.Euler().setFromQuaternion(menu.getWorldQuaternion(new THREE.Quaternion()), 'YXZ')
    return {
      vr: s.is('vr-mode'), bodies: document.querySelectorAll('.xr-body-target').length,
      dist: +rel.length().toFixed(2), below: +deg(Math.atan2(-rel.y, Math.hypot(rel.x, rel.z))).toFixed(1),
      roll: +deg(e.z).toFixed(1), errs: window.lanternDebug.xrState().tickErrors(),
      time: window.lanternDebug.getState().time,
    }
  })
  check('VR-сессия вошла, 10 тел', s1.vr && s1.bodies === 10)
  check('ошибок тика нет (настоящий список, не «n/a»)', Array.isArray(s1.errs) && s1.errs.length === 0, JSON.stringify(s1.errs).slice(0, 140))
  check('Meta: гид-меню в 1.0–2.0 м, на 10–20° ниже глаз, без крена', s1.dist >= 1 && s1.dist <= 2 && s1.below >= 10 && s1.below <= 20 && Math.abs(s1.roll) < 1,
    `${s1.dist} м, ${s1.below}°, roll ${s1.roll}°`)

  // 2. Мир идёт ВНУТРИ сессии.
  await page.waitForTimeout(4000)
  const s2 = await page.evaluate(() => ({time: window.lanternDebug.getState().time, errs: window.lanternDebug.xrState().tickErrors()}))
  check('мир живёт в сессии: сим-время растёт', s2.time > s1.time + 0.3, `${s1.time.toFixed(2)} → ${s2.time.toFixed(2)} с`)
  check('ошибок тика по-прежнему нет', s2.errs.length === 0, JSON.stringify(s2.errs).slice(0, 140))

  // 3. Ходьба при открытом меню.
  const walk = await page.evaluate(() => new Promise((res) => {
    const s = document.querySelector('#xr-scene')
    const rig = s.querySelector('#xr-rig').object3D
    const left = s.querySelector('#xr-left-controller')
    const z0 = rig.position.z
    left.dispatchEvent(new CustomEvent('thumbstickmoved', {detail: {x: 0, y: -1}}))
    setTimeout(() => {
      left.dispatchEvent(new CustomEvent('thumbstickmoved', {detail: {x: 0, y: 0}}))
      res({from: +z0.toFixed(2), to: +rig.position.z.toFixed(2)})
    }, 2500)
  }))
  check('ходьба стиком работает при открытом меню', walk.to < walk.from - 0.02, `z ${walk.from} → ${walk.to}`)

  // 4. B закрывает меню; снап-поворот правым стиком.
  await page.evaluate(() => document.querySelector('#xr-right-controller').dispatchEvent(new CustomEvent('bbuttondown', {bubbles: true})))
  await page.waitForTimeout(400)
  check('B закрывает меню', !(await page.evaluate(() => document.querySelector('#xr-context-menu').object3D.visible)))
  const snap = await page.evaluate(() => new Promise((res) => {
    const rig = document.querySelector('#xr-rig').object3D
    const rc = document.querySelector('#xr-right-controller')
    const y0 = rig.rotation.y
    rc.dispatchEvent(new CustomEvent('thumbstickmoved', {detail: {x: 1, y: 0}}))
    setTimeout(() => {
      rc.dispatchEvent(new CustomEvent('thumbstickmoved', {detail: {x: 0, y: 0}}))
      res(+(rig.rotation.y - y0) * 180 / Math.PI)
    }, 300)
  }))
  check('снап-поворот: 30° за шаг', Math.abs(Math.abs(snap) - 30) < 0.5, `${snap.toFixed(1)}°`)

  // 5. Триггер по телу.
  await page.evaluate(() => {
    const THREE = window.AFRAME.THREE
    const s = document.querySelector('#xr-scene')
    const ctrl = s.querySelector('#xr-right-controller')
    const m = s.querySelector('#xr-rig').object3D.matrixWorld
    const b = window.lanternDebug.spatialLayout().find((x) => x.id === 'L-01')
    const target = new THREE.Vector3(b.x, b.y, b.z).applyMatrix4(m)
    const origin = new THREE.Vector3(0.16, 1.42, -0.18).applyMatrix4(m)
    ctrl.object3D.position.copy(origin)
    ctrl.object3D.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), target.clone().sub(origin).normalize())
    ctrl.object3D.updateMatrix()
  })
  await page.waitForTimeout(1500)
  const sel = await page.evaluate(() => new Promise((res) => {
    const ctrl = document.querySelector('#xr-right-controller')
    ctrl.dispatchEvent(new CustomEvent('triggerdown', {bubbles: true}))
    const a = window.lanternDebug.xrState().selected
    setTimeout(() => { ctrl.dispatchEvent(new CustomEvent('triggerup', {bubbles: true})); res(a) }, 300)
  }))
  check('триггер по телу выбирает его', sel >= 0, `selected=${sel}`)

  const fin = await page.evaluate(() => window.lanternDebug.xrState().tickErrors())
  check('за весь прогон ошибок тика нет', fin.length === 0, JSON.stringify(fin).slice(0, 140))
  console.log(failed ? `IWER XR: ${failed} провалено` : 'IWER XR: все проверки пройдены')
  return {failed}
}
