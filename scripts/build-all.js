// build-all.js — builds every experiment in experiments/ (8th Wall, webpack),
// copies every no-build experience in xrblocks/ (XR Blocks, plain static),
// and assembles _site/, the static output that GitHub Pages serves.
// Each 8th Wall experiment keeps its own webpack config; dependencies resolve
// from the root node_modules.

const path = require('path')
const fs = require('fs')
const webpack = require('webpack')

const root = path.join(__dirname, '..')
const experimentsDir = path.join(root, 'experiments')
const xrblocksDir = path.join(root, 'xrblocks')
const siteDir = path.join(root, '_site')

const isDir = (p) => fs.existsSync(p) && fs.statSync(p).isDirectory()

// Files that stay in the repo but must not ship to the site.
const SITE_FILTER = (src) => !/(?:^|[\\/])(?:README\.md|exp\.json)$/.test(src)

function listExperiments() {
  if (!isDir(experimentsDir)) return []
  return fs.readdirSync(experimentsDir)
    .filter((d) => isDir(path.join(experimentsDir, d)))
    .sort()
}

// A no-build XR Blocks experience is any folder in xrblocks/ with its own
// index.html (shared assets like common/ are skipped).
function listXrblocks() {
  if (!isDir(xrblocksDir)) return []
  return fs.readdirSync(xrblocksDir)
    .filter((d) => isDir(path.join(xrblocksDir, d)))
    .filter((d) => fs.existsSync(path.join(xrblocksDir, d, 'index.html')))
    .sort()
}

function titleize(name) {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

// Every experience may carry an exp.json next to its entry point:
// { "title": "...", "description": "...", "tags": ["..."] }
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
    tags: Array.isArray(meta.tags) ? meta.tags : [],
  }
}

function buildOne(name) {
  const expDir = path.join(experimentsDir, name)
  const configPath = path.join(expDir, 'config', 'webpack.config.js')
  if (!fs.existsSync(configPath)) {
    throw new Error(`No webpack config for experiment "${name}": ${configPath}`)
  }

  return new Promise((resolve, reject) => {
    // The config computes paths from process.cwd(), so load it from the experiment dir.
    const prevCwd = process.cwd()
    process.chdir(expDir)
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

function assemble(expNames, xbNames) {
  fs.rmSync(siteDir, {recursive: true, force: true})
  fs.mkdirSync(path.join(siteDir, 'experiments'), {recursive: true})
  fs.mkdirSync(path.join(siteDir, 'xrblocks'), {recursive: true})

  // Landing page lives at the repo root; copy it next to its manifest.
  fs.copyFileSync(path.join(root, 'index.html'), path.join(siteDir, 'index.html'))

  const manifest = []

  // XR Blocks: plain static folders, no build step.
  for (const name of xbNames) {
    fs.cpSync(
      path.join(xrblocksDir, name),
      path.join(siteDir, 'xrblocks', name),
      {recursive: true, filter: SITE_FILTER}
    )
    manifest.push({stack: 'xrblocks', name, path: `xrblocks/${name}/`, ...readMeta(xrblocksDir, name)})
  }
  // Shared assets for the XR Blocks experiences (styles, helpers).
  if (isDir(path.join(xrblocksDir, 'common'))) {
    fs.cpSync(path.join(xrblocksDir, 'common'), path.join(siteDir, 'xrblocks', 'common'), {recursive: true})
  }

  // 8th Wall: webpack output from dist/.
  for (const name of expNames) {
    const dist = path.join(experimentsDir, name, 'dist')
    if (!isDir(dist)) throw new Error(`Experiment "${name}" produced no dist/`)
    fs.cpSync(dist, path.join(siteDir, 'experiments', name), {recursive: true})
    manifest.push({stack: '8thwall', name, path: `experiments/${name}/`, ...readMeta(experimentsDir, name)})
  }

  fs.writeFileSync(path.join(siteDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return manifest
}

async function main() {
  const expNames = listExperiments()
  const xbNames = listXrblocks()
  if (expNames.length === 0) console.warn('No experiments found in experiments/ — nothing to build.')
  if (xbNames.length === 0) console.warn('No experiences found in xrblocks/ — nothing to copy.')
  for (const name of expNames) {
    console.log(`\n=== Building ${name} ===`)
    await buildOne(name)
  }
  const manifest = assemble(expNames, xbNames)
  console.log(`\nAssembled ${manifest.length} experience(s) into _site/`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
