// iwer-run.mjs — оркестратор IWER-теста LANTERN // VOID.
//
// Что делает: стейджит опыт в apps/weather-room/lantern-test (origin дев-сервера
// IWSDK даёт XR-эмуляцию), поднимает рантайм, прогоняет test/iwer/xr-session.mjs
// в живой сессии эмулятора и убирает за собой.
//
// Запуск из корня репозитория:  node apps/lantern-void/test/iwer-run.mjs
import {cpSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const WS = join(ROOT, 'apps', 'weather-room')      // рабочая область рантайма IWSDK
const SRC = join(ROOT, 'apps', 'lantern-void')
const STAGE = join(WS, 'lantern-test')
const SCRIPT = join(WS, 'iwer-xr-session.mjs')
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// npx на Windows — это npx.cmd, поэтому запуск через shell.
const cli = (args, capture = false) =>
  spawnSync('npx', ['@iwsdk/cli', ...args], {cwd: WS, shell: true, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'})
const runtimeStatus = () => (cli(['dev', 'status'], true).stdout || '')

function stage() {
  rmSync(STAGE, {recursive: true, force: true})
  mkdirSync(STAGE, {recursive: true})
  for (const name of ['index.html', 'style.css', 'en-US.json']) cpSync(join(SRC, name), join(STAGE, name))
  // vite кэширует статику по пути: новое имя файла гарантированно пробивает кэш.
  cpSync(join(SRC, 'mySketch.js'), join(STAGE, 'mySketch-iwer.js'))
  const html = readFileSync(join(STAGE, 'index.html'), 'utf8').replace('src="mySketch.js"', 'src="mySketch-iwer.js"')
  writeFileSync(join(STAGE, 'index.html'), html)
  cpSync(join(SRC, 'test', 'iwer', 'xr-session.mjs'), SCRIPT)
}

function cleanup() {
  rmSync(STAGE, {recursive: true, force: true})
  rmSync(SCRIPT, {force: true})
  cli(['dev', 'down'], true)
}

async function main() {
  console.log('== стейджинг lantern-test в apps/weather-room')
  stage()
  try {
    console.log('== рантайм IWER')
    if (!/"running": true/.test(runtimeStatus())) {
      cli(['dev', 'up', '--allow-browser-automation', '--headed', '--timeout', '120000'])
    }
    for (let attempt = 1; attempt <= 12; attempt++) {
      await sleep(7000)
      if (/"browserCommandReady": true/.test(runtimeStatus())) {
        console.log(`готов (попытка ${attempt})`)
        break
      }
    }
    console.log('== прогон')
    const run = cli(['browser', 'run', 'iwer-xr-session.mjs', '--workspace', '.', '--timeout', '110000'])
    process.exitCode = run.status === 0 ? 0 : 1
  } finally {
    console.log('== очистка')
    cleanup()
  }
}

main().catch((err) => {
  console.error(err)
  cleanup()
  process.exit(1)
})
