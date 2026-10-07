// build-all.js — builds active 8th Wall WebAR apps and Meta IWSDK apps,
// then assembles everything into _site/.
// Google XR Blocks is intentionally gone.

const path = require('path')
const fs = require('fs')
const {spawnSync} = require('child_process')

const root = path.join(__dirname, '..')
const wallDir = path.join(root, '8thwall')
const appsDir = path.join(root, 'apps')
const siteDir = path.join(root, '_site')

const isDir = (p) => fs.existsSync(p) && fs.statSync(p).isDirectory()

// Files that stay in the repo but must not ship to the site.
const SITE_FILTER = (src) => !/(?:^|[\\/])(?:README\.md|exp\.json)$/.test(src)

function listWall() {
  if (!isDir(wallDir)) return []
  return fs.readdirSync(wallDir)
    .filter((d) => isDir(path.join(wallDir, d)))
    .sort()
}

// Meta IWSDK apps: any apps/<name> with a package.json.
function listApps() {
  if (!isDir(appsDir)) return []
  return fs.readdirSync(appsDir)
    .filter((d) => isDir(path.join(appsDir, d)) && fs.existsSync(path.join(appsDir, d, 'package.json')))
    .sort()
}

function titleize(name) {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

// Every experience may carry an exp.json next to its entry point:
// { "title": "...", "description": "...", "description_ru": "...", "tags": ["..."] }
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
  }
}

function buildOne(name) {
  const appDir = path.join(wallDir, name)
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

function assemble(wallNames, appNames) {
  fs.rmSync(siteDir, {recursive: true, force: true})
  fs.mkdirSync(path.join(siteDir, '8thwall'), {recursive: true})

  // Landing page lives at the repo root; copy it next to its manifest.
  fs.copyFileSync(path.join(root, 'index.html'), path.join(siteDir, 'index.html'))

  const manifest = []

  // 8th Wall: webpack output from dist/.
  for (const name of wallNames) {
    const dist = path.join(wallDir, name, 'dist')
    if (!isDir(dist)) throw new Error(`App "${name}" produced no dist/`)
    fs.cpSync(dist, path.join(siteDir, '8thwall', name), {recursive: true})
    manifest.push({stack: '8thwall', name, path: `8thwall/${name}/`, ...readMeta(wallDir, name)})
  }
  // Meta IWSDK: vite output from dist/.
  if (appNames.length > 0) fs.mkdirSync(path.join(siteDir, 'iwsdk'), {recursive: true})
  for (const name of appNames) {
    const dist = path.join(appsDir, name, 'dist')
    if (!isDir(dist)) throw new Error(`IWSDK app "${name}" produced no dist/`)
    fs.cpSync(dist, path.join(siteDir, 'iwsdk', name), {recursive: true})
    manifest.push({stack: 'iwsdk', name, path: `iwsdk/${name}/`, ...readMeta(appsDir, name)})
  }

  fs.writeFileSync(path.join(siteDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return manifest
}

async function main() {
  const wallNames = listWall()
  const appNames = listApps()
  const rebuild = process.argv.includes('--rebuild-8thwall') || wallNames.some((name) => !isDir(path.join(wallDir, name, 'dist')))
  for (const name of rebuild ? wallNames : []) {
    console.log(`\n=== Building ${name} ===`)
    await buildOne(name)
  }
  for (const name of appNames) {
    console.log(`\n=== Building IWSDK ${name} ===`)
    buildApp(name)
  }
  const manifest = assemble(wallNames, appNames)
  console.log(`\nAssembled ${manifest.length} experience(s) into _site/`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
