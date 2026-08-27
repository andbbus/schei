// Headless render check for the 10-feature batch. Requires dev servers on
// :3001 + :5173. Run: node scripts/features-render-check.mjs
import puppeteer from 'puppeteer-core'

const findChrome = async () => {
  const paths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ]
  for (const p of paths) {
    try { await fs.access(p); return p } catch {}
  }
  throw new Error('Chrome not found')
}
import fs from 'node:fs/promises'

const base = 'http://localhost:5173'
const browser = await puppeteer.launch({ executablePath: await findChrome(), headless: 'new' })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

const shot = (name) => page.screenshot({ path: `/tmp/opencode/feat-${name}.png` })

// 1. Budget view: quick-budget dropdown opens
await page.goto(base + '/', { waitUntil: 'networkidle2' })
await page.waitForFunction(() => document.body.innerText.includes('Auto-assign'), { timeout: 15000 })
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Auto-assign'))?.click())
await new Promise((r) => setTimeout(r, 300))
const qkModes = await page.evaluate(() => document.body.innerText.includes('Underfunded') && document.body.innerText.includes('Average spent'))
console.log('quick-budget menu:', qkModes)
await shot('quick-budget')
await page.keyboard.press('Escape')

// 2. Cmd+K palette
await page.keyboard.down('Meta'); await page.keyboard.press('k'); await page.keyboard.up('Meta')
await new Promise((r) => setTimeout(r, 300))
await page.keyboard.type('theme')
await new Promise((r) => setTimeout(r, 300))
const palette = await page.evaluate(() => document.body.innerText.includes('Theme:'))
console.log('palette themes:', palette)
await shot('palette')
await page.keyboard.press('Escape')

// 3. Calendar view
await page.goto(base + '/calendar', { waitUntil: 'networkidle2' })
await page.waitForFunction(() => document.body.innerText.includes('Mon') && document.body.innerText.includes('scheduled'), { timeout: 15000 })
const calDays = await page.evaluate(() => document.querySelectorAll('button[class*="min-h-[92px]"]').length)
console.log('calendar day cells:', calDays)
await shot('calendar')

// 4. Reflect → Anomalies tab
await page.goto(base + '/reflect', { waitUntil: 'networkidle2' })
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Anomalies')?.click())
await new Promise((r) => setTimeout(r, 800))
const anom = await page.evaluate(() => document.body.innerText.includes('Typical') || document.body.innerText.includes('Nothing unusual'))
console.log('anomalies tab:', anom)
await shot('anomalies')

// 5. Assistant (mic button presence + page renders)
await page.goto(base + '/assistant', { waitUntil: 'networkidle2' })
await page.waitForFunction(() => document.body.innerText.includes('Assistant'), { timeout: 15000 })
const mic = await page.evaluate(() => !!document.querySelector('button[title*="Dictate"]'))
console.log('mic button present:', mic)
await shot('assistant')

console.log('page errors:', errors.length === 0 ? 'NONE' : errors.slice(0, 5))
await browser.close()
