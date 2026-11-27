// build-all.js — builds every experience under apps/ and assembles the whole
// catalogue into _site/. Google XR Blocks is intentionally gone.
//
// A folder in apps/ is recognised by how it is built:
//   package.json              -> npm project (Meta IWSDK): npm ci + npm run build -> dist/
//   config/webpack.config.js  -> webpack project (8th Wall / A-Frame)          -> dist/
//   index.html                -> static experiment, published exactly as it is

const path = require('path')
const fs = require('fs')
const {spawnSync} = require('child_process')
const webpack = require('webpack')

const root = path.join(__dirname, '..')
const appsDir = path.join(root, 'apps')
const siteDir = path.join(root, '_site')

const isDir = (p) => fs.existsSync(p) && fs.statSync(p).isDirectory()
const has = (dir, file) => fs.existsSync(path.join(dir, file))

// Files that stay in the repo but must not ship to the site.
const SITE_FILTER = (src) => !/(?:^|[\\/])(?:README\.md|exp\.json|AGENTS\.md|\.omp|\.agents|\.github)(?:[\\/]|$)/.test(src)
// Static experiments are published straight from their source folder, so the
// test suites and scratch output that live next to the experience stay out too.
const STATIC_FILTER = (src) => SITE_FILTER(src) && !/(?:^|[\\/])(?:tests?|tmp)(?:[\\/]|$)/.test(src)

// One pass over apps/: each folder is filed by the first marker it has.
function listExperiences() {
  const found = {npmApps: [], webpackApps: [], staticApps: []}
  if (!isDir(appsDir)) return found
  for (const name of fs.readdirSync(appsDir).sort()) {
    const dir = path.join(appsDir, name)
    if (!isDir(dir)) continue
    if (has(dir, 'package.json')) found.npmApps.push(name)
    else if (has(dir, path.join('config', 'webpack.config.js'))) found.webpackApps.push(name)
    else if (has(dir, 'index.html')) found.staticApps.push(name)
  }
  return found
}

function titleize(name) {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

// Every experience may carry an exp.json next to its entry point:
// { "title": "...", "description": "...", "description_ru": "...", "tags": ["..."] }
// A static experiment also names the catalog section it belongs to via "stack".
function readMeta(dir, name) {
  let meta = {}
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, name, 'exp.json'), 'utf8'))
  } catch {
    // No exp.json — fall back to the folder name.
  }
  return {
    title: meta.title || titleize(name),
    description: meta.description || '',
    ...(meta.description_ru ? {description_ru: meta.description_ru} : {}),
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    ...(meta.stack ? {stack: meta.stack} : {}),
  }
}

function buildOne(name) {
  const appDir = path.join(appsDir, name)
  const configPath = path.join(appDir, 'config', 'webpack.config.js')
  if (!fs.existsSync(configPath)) {
    throw new Error(`No webpack config for experiment "${name}": ${configPath}`)
  }

  return new Promise((resolve, reject) => {
    // The config computes paths from process.cwd(), so load it from the app dir.
    const prevCwd = process.cwd()
    process.chdir(appDir)
    let config
    try {
      config = require(configPath)
    } finally {
      process.chdir(prevCwd)
    }

    webpack(config, (err, stats) => {
      if (err) return reject(err)
      if (stats.hasErrors()) {
        return reject(new Error(stats.toString({all: false, errors: true, errorDetails: true})))
      }
      console.log(stats.toString({all: false, assets: true, colors: true}))
      resolve()
    })
  })
}

function buildApp(name) {
  const appDir = path.join(appsDir, name)
  const run = (args) =>
    spawnSync(`npm ${args.map((a) => `"${a}"`).join(' ')}`, {stdio: 'inherit', shell: true, cwd: appDir}).status === 0
  if (!run(['ci', '--no-fund', '--no-audit'])) throw new Error(`npm ci failed for IWSDK app "${name}"`)
  if (!run(['run', 'build'])) throw new Error(`Build failed for IWSDK app "${name}"`)
}

// Stack names double as the public folder of each experience, so the addresses
// that are already published keep working wherever the sources live.
function assemble(webpackNames, npmNames, staticNames) {
  fs.rmSync(siteDir, {recursive: true, force: true})
  fs.mkdirSync(path.join(siteDir, '8thwall'), {recursive: true})

  // Landing page lives at the repo root; copy it next to its manifest.
  fs.copyFileSync(path.join(root, 'index.html'), path.join(siteDir, 'index.html'))

  const manifest = []

  // 8th Wall: webpack output from dist/.
  for (const name of webpackNames) {
    const dist = path.join(appsDir, name, 'dist')
    if (!isDir(dist)) throw new Error(`App "${name}" produced no dist/`)
    fs.cpSync(dist, path.join(siteDir, '8thwall', name), {recursive: true})
    manifest.push({stack: '8thwall', name, path: `8thwall/${name}/`, ...readMeta(appsDir, name)})
  }
  // Meta IWSDK: vite output from dist/.
  if (npmNames.length > 0) fs.mkdirSync(path.join(siteDir, 'iwsdk'), {recursive: true})
  for (const name of npmNames) {
    const dist = path.join(appsDir, name, 'dist')
    if (!isDir(dist)) throw new Error(`IWSDK app "${name}" produced no dist/`)
    fs.cpSync(dist, path.join(siteDir, 'iwsdk', name), {recursive: true, filter: SITE_FILTER})
    manifest.push({stack: 'iwsdk', name, path: `iwsdk/${name}/`, ...readMeta(appsDir, name)})
  }
  // Static experiments: the source folder is the publishable artifact.
  // The catalog section comes from exp.json ("stack"), so a p5.js piece is
  // never filed under a stack it does not use.
  for (const name of staticNames) {
    const meta = readMeta(appsDir, name)
    if (!meta.stack) throw new Error(`Static experiment "${name}": exp.json must name its catalog "stack"`)
    fs.mkdirSync(path.join(siteDir, meta.stack), {recursive: true})
    fs.cpSync(path.join(appsDir, name), path.join(siteDir, meta.stack, name), {recursive: true, filter: STATIC_FILTER})
    manifest.push({...meta, name, path: `${meta.stack}/${name}/`})
  }

  fs.writeFileSync(path.join(siteDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return manifest
}

async function main() {
  const {npmApps, webpackApps, staticApps} = listExperiences()
  // --rebuild-8thwall is kept as the name of the "force a webpack rebuild" flag.
  const rebuild = process.argv.includes('--rebuild-8thwall') || webpackApps.some((name) => !isDir(path.join(appsDir, name, 'dist')))
  for (const name of rebuild ? webpackApps : []) {
    console.log(`\n=== Building ${name} ===`)
    await buildOne(name)
  }
  for (const name of npmApps) {
    console.log(`\n=== Building IWSDK ${name} ===`)
    buildApp(name)
  }
  const manifest = assemble(webpackApps, npmApps, staticApps)
  console.log(`\nAssembled ${manifest.length} experience(s) into _site/`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
