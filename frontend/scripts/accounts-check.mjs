// Quick headless check: Accounts summary page renders, sidebar link navigates,
// rows open the register, zero console/page errors.
import puppeteer from 'puppeteer-core'
import { existsSync } from 'node:fs'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
if (!existsSync(CHROME)) {
  console.log('SKIP: Chrome not found')
  process.exit(0)
}

const BASE = 'http://localhost:5173'
const errors = []
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`))

const results = []
const check = (name, ok, extra = '') => {
  results.push(`${ok ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`)
}

await page.goto(`${BASE}/accounts`, { waitUntil: 'networkidle0' })
await page.waitForSelector('h1', { timeout: 10000 })
check('page title', (await page.$eval('h1', (e) => e.textContent)) === 'Accounts', 'h1')

const sidebarHasAccounts = await page.evaluate(() =>
  [...document.querySelectorAll('nav a')].some((a) => a.textContent.includes('Accounts')),
)
check('sidebar Accounts link', sidebarHasAccounts)

const statOk = await page.evaluate(() =>
  ['On budget', 'Tracking', 'Net worth'].every((label) =>
    [...document.querySelectorAll('.uppercase')].some((e) => e.textContent === label),
  ),
)
check('stat cards (on budget/tracking/net worth)', statOk)

const headerCount = await page.evaluate(() =>
  [...document.querySelectorAll('h1 ~ span, h1 + span')].some((e) => /open/.test(e.textContent)),
)
check('header open/closed count', headerCount)

const rowCount = await page.evaluate(() => document.querySelectorAll('tbody tr').length)
check('account rows rendered', rowCount > 0, `${rowCount} rows`)

// open a row → register
const clicked = await page.evaluate(() => {
  const first = document.querySelector('tbody tr a')
  if (!first) return false
  first.click()
  return true
})
await new Promise((r) => setTimeout(r, 1200))
check('row navigates to register', clicked && page.url().includes('/accounts/'), `url=${page.url().replace(BASE, '')}`)

// back via sidebar link
await page.evaluate(() => {
  const a = [...document.querySelectorAll('nav a')].find((x) => x.textContent.includes('Accounts'))
  a?.click()
})
await new Promise((r) => setTimeout(r, 1000))
check('sidebar navigates back to /accounts', page.url().endsWith('/accounts'), `url=${page.url().replace(BASE, '')}`)

console.log(results.join('\n'))
console.log(`errors: ${errors.length === 0 ? 'NONE' : '\n' + errors.join('\n')}`)
await browser.close()
process.exit(errors.length > 0 ? 1 : 0)