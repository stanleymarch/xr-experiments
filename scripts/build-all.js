// build-all.js — builds every app in 8thwall/ (8th Wall, webpack),
// copies every no-build experience in experiences/ (XR Blocks, plain static),
// and assembles _site/, the static output that GitHub Pages serves.
// Each 8th Wall app keeps its own webpack config; dependencies resolve
// from the root node_modules.

const path = require('path')
const fs = require('fs')
const webpack = require('webpack')

const root = path.join(__dirname, '..')
const wallDir = path.join(root, '8thwall')
const expDir = path.join(root, 'experiences')
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

// A no-build XR Blocks experience is any folder in experiences/ with its own
// index.html (shared assets like common/ are skipped).
function listExperiences() {
  if (!isDir(expDir)) return []
  return fs.readdirSync(expDir)
    .filter((d) => isDir(path.join(expDir, d)))
    .filter((d) => fs.existsSync(path.join(expDir, d, 'index.html')))
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

function assemble(wallNames, expNames) {
  fs.rmSync(siteDir, {recursive: true, force: true})
  fs.mkdirSync(path.join(siteDir, '8thwall'), {recursive: true})
  fs.mkdirSync(path.join(siteDir, 'experiences'), {recursive: true})

  // Landing page lives at the repo root; copy it next to its manifest.
  fs.copyFileSync(path.join(root, 'index.html'), path.join(siteDir, 'index.html'))

  const manifest = []

  // XR Blocks: plain static folders, no build step.
  for (const name of expNames) {
    fs.cpSync(
      path.join(expDir, name),
      path.join(siteDir, 'experiences', name),
      {recursive: true, filter: SITE_FILTER}
    )
    manifest.push({stack: 'xrblocks', name, path: `experiences/${name}/`, ...readMeta(expDir, name)})
  }
  // Shared assets for the XR Blocks experiences (styles, helpers).
  if (isDir(path.join(expDir, 'common'))) {
    fs.cpSync(path.join(expDir, 'common'), path.join(siteDir, 'experiences', 'common'), {recursive: true})
  }

  // 8th Wall: webpack output from dist/.
  for (const name of wallNames) {
    const dist = path.join(wallDir, name, 'dist')
    if (!isDir(dist)) throw new Error(`App "${name}" produced no dist/`)
    fs.cpSync(dist, path.join(siteDir, '8thwall', name), {recursive: true})
    manifest.push({stack: '8thwall', name, path: `8thwall/${name}/`, ...readMeta(wallDir, name)})
  }

  fs.writeFileSync(path.join(siteDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return manifest
}

async function main() {
  const wallNames = listWall()
  const expNames = listExperiences()
  if (wallNames.length === 0) console.warn('No apps found in 8thwall/ — nothing to build.')
  if (expNames.length === 0) console.warn('No experiences found in experiences/ — nothing to copy.')
  const rebuild = process.argv.includes('--rebuild-8thwall') || wallNames.some((name) => !isDir(path.join(wallDir, name, 'dist')))
  for (const name of rebuild ? wallNames : []) {
    console.log(`\n=== Building ${name} ===`)
    await buildOne(name)
  }
  const manifest = assemble(wallNames, expNames)
  console.log(`\nAssembled ${manifest.length} experience(s) into _site/`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
