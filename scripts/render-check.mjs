// Headless render check: loads the running dev server, captures console
// errors/page errors, verifies real content renders, and screenshots all themes.
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const URL = 'http://localhost:5173'
const THEMES = ['tokyonight-storm', 'catppuccin-mocha', 'gruvbox-dark', 'rose-pine-dawn']

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })

const problems = []
page.on('console', (m) => {
  if (m.type() === 'error') problems.push('console: ' + m.text().slice(0, 300))
})
page.on('pageerror', (e) => problems.push('pageerror: ' + String(e).slice(0, 300)))

await page.goto(URL, { waitUntil: 'networkidle0', timeout: 45000 })
await page.waitForSelector('#root > *', { timeout: 15000 })

const textLen = await page.$eval('#root', (el) => el.innerText.length)
const hasBudgetTable = await page.evaluate(() =>
  /READY TO ASSIGN|ASSIGNED|ACTIVITY|AVAILABLE/i.test(document.body.innerText),
)
console.log('root text length:', textLen, '| budget headers visible:', hasBudgetTable)

for (const t of THEMES) {
  await page.evaluate((id) => {
    localStorage.setItem('ui.theme', id)
    document.documentElement.dataset.theme = id
  }, t)
  await new Promise((r) => setTimeout(r, 400))
  await page.screenshot({ path: `/tmp/theme-${t}.png` })
  console.log('shot:', t)
}

// theme switch through the actual UI (gear → modal → pick light theme)
await page.reload({ waitUntil: 'networkidle0' })
await page.waitForSelector('#root > *')
await page.click('button[aria-label="Open options"]')
await page.waitForFunction(() => document.body.innerText.includes('Options'))
const picked = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('[aria-pressed]')].find(
    (b) => b.getAttribute('data-theme') === 'catppuccin-mocha',
  )
  ;(btn ?? []).click?.()
  return document.documentElement.dataset.theme
})
console.log('picked via UI:', picked)
await new Promise((r) => setTimeout(r, 300))
await page.screenshot({ path: '/tmp/theme-options-modal.png' })

// persistence across reload
await page.reload({ waitUntil: 'networkidle0' })
await page.waitForSelector('#root > *')
const persisted = await page.evaluate(() => ({
  attr: document.documentElement.dataset.theme,
  bg: getComputedStyle(document.body).backgroundColor,
}))
console.log('persisted:', JSON.stringify(persisted))

if (!hasBudgetTable) problems.push('budget table text missing')
console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'NO CONSOLE/PAGE ERRORS')
await browser.close()
process.exit(problems.length ? 1 : 0)
