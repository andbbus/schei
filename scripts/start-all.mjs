#!/usr/bin/env node
// Cross-platform launcher: installs deps on first run, creates the SQLite
// database, starts backend (:3001) + frontend (:5173), waits for both, opens
// the browser. Used by `npm start` (repo root) and adapted by start.command.
//
//   node scripts/start-all.mjs              # run
//   node scripts/start-all.mjs --setup-only # install + db push, then exit

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import http from 'node:http'
import { createDesktopIcon } from './desktop-icon.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const backend = path.join(root, 'backend')
const frontend = path.join(root, 'frontend')
const setupOnly = process.argv.includes('--setup-only')

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const step = (msg) => console.log(`\x1b[2m▸\x1b[0m ${msg}`)

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) {
    console.error(`\n✕ command failed: ${cmd} ${args.join(' ')} (in ${cwd})`)
    process.exit(1)
  }
}

async function waitFor(url, label, tries = 120) {
  for (let i = 0; i < tries; i++) {
    const ok = await new Promise((resolve) => {
      http
        .get(url, (res) => {
          res.resume()
          resolve(res.statusCode !== undefined && res.statusCode < 500)
        })
        .on('error', () => resolve(false))
    })
    if (ok) return
    await new Promise((r) => setTimeout(r, 500))
  }
  console.error(`\n✕ ${label} did not become ready (${url})`)
  process.exit(1)
}

// --- dependencies ---
let firstRun = false
if (!existsSync(path.join(backend, 'node_modules'))) {
  firstRun = true
  step('Installing backend dependencies (first run)…')
  run(npm, ['install'], backend)
}
if (!existsSync(path.join(frontend, 'node_modules'))) {
  firstRun = true
  step('Installing frontend dependencies (first run)…')
  run(npm, ['install'], frontend)
}

// --- database (first run: empty DB → the in-app welcome wizard takes over) ---
if (!existsSync(path.join(backend, 'prisma', 'dev.db'))) {
  firstRun = true
  step('Creating the SQLite database…')
  run(npm, ['run', 'db:push'], backend)
  console.log('  Done. First launch opens a welcome wizard that creates your budget.')
}

// --- desktop icon (first run / setup: a clickable launcher they can pin) ---
if (setupOnly || firstRun) {
  step('Adding a "Schei" icon to your Desktop…')
  try {
    const { where } = createDesktopIcon()
    console.log(`  ✓ ${where}`)
    console.log('  Double-click it to start the app — drag it to your Dock / taskbar to pin it.')
  } catch (err) {
    console.warn(`  ⚠ Skipped (${err.message})`)
  }
}

if (setupOnly) {
  console.log('\n✓ Setup complete — start the app with `npm start` or the Desktop icon.')
  process.exit(0)
}

// --- servers ---
const children = []
let shuttingDown = false
const shutdown = (sig) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n${sig} — stopping servers…`)
  for (const c of children) c.kill(sig === 'SIGINT' ? 'SIGINT' : 'SIGTERM')
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

const prefix = (name, color) => {
  const c = color === 'b' ? '\x1b[36m' : '\x1b[35m'
  return (data) => process.stdout.write(data.toString().split('\n').filter(Boolean).map((l) => `${c}[${name}]\x1b[0m ${l}\n`).join(''))
}

step('Starting backend on :3001…')
children.push(spawn(npm, ['run', 'dev'], { cwd: backend, env: process.env }))
children[0].stdout.on('data', prefix('api', 'b'))
children[0].stderr.on('data', prefix('api', 'b'))

step('Starting frontend on :5173…')
children.push(spawn(npm, ['run', 'dev'], { cwd: frontend, env: process.env }))
children[1].stdout.on('data', prefix('web', 'c'))
children[1].stderr.on('data', prefix('web', 'c'))

await waitFor('http://localhost:3001/api/health', 'backend')
await waitFor('http://localhost:5173', 'frontend')

console.log('\n\x1b[32m✓ Ready → http://localhost:5173\x1b[0m  (Ctrl-C stops both servers)\n')

const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
spawn(opener, ['http://localhost:5173'], { shell: process.platform === 'win32', stdio: 'ignore' })

// keep the process alive while the servers run; surface crashes
children.forEach((c) =>
  c.on('exit', (code) => {
    if (!shuttingDown && code !== 0 && code !== null) shutdown('exit')
  }),
)
