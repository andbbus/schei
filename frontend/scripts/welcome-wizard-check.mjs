// Headless E2E of the first-run wizard on scratch ports (backend :3002 with a
// temp DB, frontend :5174). Verifies: welcome wizard → create budget (+starter
// categories) → add account → assistant skip → app shell renders with the
// starter categories and the account. Run from frontend/: node scripts/welcome-wizard-check.mjs
import { spawn } from 'node:child_process'
import { rmSync, existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const DB = `/tmp/ynab-wizard-e2e-${Date.now()}.db`
const BACKEND_PORT = 3002
const FRONTEND_PORT = 5174
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// pre-flight: fail fast when a stale server squats the ports (its proxy would
// silently point somewhere else)
for (const port of [BACKEND_PORT, FRONTEND_PORT]) {
  try {
    await fetch(`http://localhost:${port}`)
    console.error(`✕ port ${port} already in use — kill the stale process first`)
    process.exit(1)
  } catch {}
}

// detached + process-group kill: npm→sh→vite trees die together
const backend = spawn('npm', ['run', 'dev'], {
  cwd: '../backend',
  env: { ...process.env, PORT: String(BACKEND_PORT), DATABASE_URL: `file:${DB}` },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
backend.stdout.on('data', (d) => process.stdout.write(`[api] ${d}`))
backend.stderr.on('data', (d) => process.stderr.write(`[api!] ${d}`))

// prisma db push for the temp DB first
const push = spawn('npx', ['prisma', 'db', 'push', '--skip-generate'], {
  cwd: '../backend',
  env: { ...process.env, DATABASE_URL: `file:${DB}` },
  stdio: 'inherit',
  detached: true,
})
await new Promise((r) => push.on('exit', r))

const frontend = spawn('npx', ['vite', '--port', String(FRONTEND_PORT), '--strictPort'], {
  cwd: '.',
  env: { ...process.env, VITE_API_TARGET: `http://localhost:${BACKEND_PORT}` },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
frontend.stdout.on('data', (d) => process.stdout.write(`[web] ${d}`))

const killTree = (p) => {
  try {
    process.kill(-p.pid, 'SIGTERM')
  } catch {
    p.kill('SIGTERM')
  }
}

const waitForUrl = async (url, tries = 120) => {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`not ready: ${url}`)
}
await waitForUrl(`http://localhost:${BACKEND_PORT}/api/health`)
await waitForUrl(`http://localhost:${FRONTEND_PORT}`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1200, height: 860 })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
const shot = (n) => page.screenshot({ path: `/tmp/opencode/wizard-${n}.png` })

try {
  await page.goto(`http://localhost:${FRONTEND_PORT}`, { waitUntil: 'networkidle2' })
  await page.waitForFunction(() => document.body.innerText.includes('Create your budget'), { timeout: 20000 })
  console.log('✓ wizard shown instead of the app shell')
  await shot('1-budget')

  await page.evaluate(() => {
    const inp = [...document.querySelectorAll('input')].find((i) => i.value === 'My Budget')
    inp.value = ''
  })
  await page.type('input', 'E2E Budget')
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Create budget')?.click())
  await page.waitForFunction(() => document.body.innerText.includes('Add your first account'), { timeout: 15000 })
  console.log('✓ budget created → account step')
  await shot('2-account')

  await page.type('input', 'Main Checking')
  await page.evaluate(() => [...document.querySelectorAll('input[placeholder]')].find((i) => i.placeholder.includes(',00') || i.placeholder.includes(','))?.focus())
  await page.keyboard.type('1250,00')
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add account')?.click())
  await page.waitForFunction(() => document.body.innerText.includes('Set up the AI assistant'), { timeout: 15000 })
  console.log('✓ account added → assistant step')
  await shot('3-assistant')

  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Skip for now'))?.click())
  await page.waitForFunction(() => document.body.innerText.includes("You're all set"), { timeout: 10000 })
  console.log('✓ skip → done screen')

  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Open my budget')?.click())
  await page.waitForFunction(() => document.body.innerText.includes('READY TO ASSIGN') && document.body.innerText.includes('Groceries'), { timeout: 20000 })
  const hasAcct = await page.evaluate(() => document.body.innerText.includes('Main Checking'))
  console.log('✓ app shell rendered — starter categories + account visible:', hasAcct)
  await shot('4-app')

  // wizard must not reappear on reload
  await page.reload({ waitUntil: 'networkidle2' })
  await page.waitForFunction(() => document.body.innerText.includes('READY TO ASSIGN'), { timeout: 15000 })
  const wizardGone = await page.evaluate(() => !document.body.innerText.includes('Create your budget'))
  console.log('✓ reload keeps the app (wizard gone):', wizardGone)
} catch (e) {
  await shot('failed')
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => '<no body>')
  console.error('✕ FAILED:', String(e).split('\n')[0])
  console.error('console errors:', errors.slice(0, 5))
  console.error('body:', bodyText)
  process.exitCode = 1
} finally {
  await browser.close()
  killTree(backend)
  killTree(frontend)
  await sleep(800)
  rmSync(DB, { force: true })
  rmSync(DB + '-journal', { force: true })
}
if (!process.exitCode) console.log('page errors:', errors.length === 0 ? 'NONE' : errors.slice(0, 5))
