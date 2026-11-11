'use strict'

// ─── Package or deploy the backend to AWS ──────────
// This repo is an npm workspace, so the backend's packages are installed in the
// repo root's node_modules. Serverless zips only apps/lambda, so a deploy from
// here would ship without them ("Cannot find module" on every function). Instead
// we build a standalone copy outside the repo:
//   1. copy src/ (no tests), serverless.yml (no local-only plugins), package.json
//      with each dependency pinned to the exact version the tests run against;
//   2. npm install the production packages there;
//   3. load every handler from that copy, so a missing package fails here, not
//      in Lambda;
//   4. run Serverless from that copy.
//
// usage:
//   node scripts/aws.js prepare            steps 1–3 only (no AWS calls)
//   node scripts/aws.js package [flags]    + `serverless package` (reads SSM, changes nothing)
//   node scripts/aws.js deploy  [flags]    + `serverless deploy` (changes AWS)
// The build folder is FLOWHQ_BUILD_DIR, or <tmp>/flowhq-lambda-build.

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')

const LAMBDA = path.join(__dirname, '..')
const ROOT = path.join(LAMBDA, '..', '..')
const BUILD = process.env.FLOWHQ_BUILD_DIR || path.join(os.tmpdir(), 'flowhq-lambda-build')
const WIN = process.platform === 'win32'

const [command = 'prepare', ...flags] = process.argv.slice(2)
if (!['prepare', 'package', 'deploy'].includes(command)) {
  console.error('usage: node scripts/aws.js prepare|package|deploy [serverless flags]')
  process.exit(1)
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: WIN, ...opts })
  if (r.status !== 0) {
    console.error(`\n✗ ${cmd} ${args.join(' ')} failed (exit ${r.status})`)
    process.exit(r.status || 1)
  }
}

function copyDir(from, to, skip) {
  fs.mkdirSync(to, { recursive: true })
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip(e.name)) continue
    const a = path.join(from, e.name), b = path.join(to, e.name)
    if (e.isDirectory()) copyDir(a, b, skip)
    else fs.copyFileSync(a, b)
  }
}

// The version actually installed (what the tests use), else the range from package.json.
function installedVersion(name, range) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version } catch { return range }
}

// ── 1. Copy ──────────────────────────────────────────────────────────────────
console.log(`Building the backend in ${BUILD}`)
fs.mkdirSync(BUILD, { recursive: true })
for (const name of ['src', 'serverless.yml', 'package.json', '.serverless']) fs.rmSync(path.join(BUILD, name), { recursive: true, force: true })
copyDir(path.join(LAMBDA, 'src'), path.join(BUILD, 'src'), n => n === '__tests__')

// serverless-offline is for local runs only; it isn't installed in the build.
const yml = fs.readFileSync(path.join(LAMBDA, 'serverless.yml'), 'utf8').replace(/\nplugins:\n(\s+- serverless-offline\n?)+/, '\n')
fs.writeFileSync(path.join(BUILD, 'serverless.yml'), yml)

const pkg = JSON.parse(fs.readFileSync(path.join(LAMBDA, 'package.json'), 'utf8'))
const dependencies = Object.fromEntries(Object.entries(pkg.dependencies || {}).map(([n, r]) => [n, installedVersion(n, r)]))
const buildPkg = { name: 'flowhq-lambda-build', private: true, version: pkg.version || '0.0.0', dependencies }
fs.writeFileSync(path.join(BUILD, 'package.json'), JSON.stringify(buildPkg, null, 2) + '\n')

// ── 2. Install (skipped when the pinned list hasn't changed) ─────────────────
const stamp = path.join(BUILD, 'node_modules', '.flowhq-deps')
const want = crypto.createHash('sha256').update(JSON.stringify(dependencies)).digest('hex')
const have = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8') : ''
if (have !== want) {
  fs.rmSync(path.join(BUILD, 'node_modules'), { recursive: true, force: true })
  fs.rmSync(path.join(BUILD, 'package-lock.json'), { force: true })
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: BUILD })
  fs.writeFileSync(stamp, want)
} else {
  console.log('Packages unchanged: reusing the installed ones.')
}

// ── 3. Every handler loads from the copy ─────────────────────────────────────
const handlers = [...new Set([...yml.matchAll(/^\s+handler:\s*(\S+)/gm)].map(m => m[1].replace(/\.[^./]+$/, '')))]
const check = `
  process.env.FLOW_LINK_SECRET = 'build-check'; process.env.AWS_REGION = 'ap-south-1'
  const bad = []
  for (const h of ${JSON.stringify(handlers)}) {
    try { require('./' + h) } catch (e) { bad.push(h + ': ' + e.message.split('\\n')[0]) }
  }
  if (bad.length) { console.error(bad.join('\\n')); process.exit(1) }
  console.log('All ' + ${handlers.length} + ' handlers load with only the build folder\\'s packages.')
`
run(process.execPath, ['-e', check], { cwd: BUILD, shell: false, env: { ...process.env, NODE_PATH: '' } })

const sizeMb = dir => {
  let n = 0
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : (n += fs.statSync(p).size) } }
  walk(dir)
  return (n / 1048576).toFixed(1)
}
console.log(`Unzipped size: ${sizeMb(BUILD)} MB (Lambda allows 250 MB).`)

// ── 4. Serverless ────────────────────────────────────────────────────────────
if (command === 'prepare') process.exit(0)
const sls = path.join(ROOT, 'node_modules', '.bin', WIN ? 'serverless.cmd' : 'serverless')
run(sls, [command, ...flags], { cwd: BUILD })
if (command === 'package') console.log(`\nPackage written to ${path.join(BUILD, '.serverless')}. Nothing was deployed.`)
