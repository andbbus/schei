// Headless CRUD smoke for the calendar editor: add → edit → delete a scratch
// transaction through the real UI. Run from frontend/: node scripts/calendar-crud-check.mjs
import puppeteer from 'puppeteer-core'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('dialog', (d) => d.accept())

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = (name) => page.screenshot({ path: `/tmp/opencode/cal-${name}.png` })

await page.goto('http://localhost:5173/calendar', { waitUntil: 'networkidle2' })
await page.waitForFunction(() => document.body.innerText.includes('Mon'), { timeout: 15000 })

// pick day 20 of the shown month
const dayClicked = await page.evaluate(() => {
  const cells = [...document.querySelectorAll('button')]
  const cell = cells.find((b) => b.className.includes('min-h-[92px]') && b.innerText.split('\n')[0] === '20')
  if (!cell) return false
  cell.click()
  return true
})
console.log('day 20 clicked:', dayClicked)
await sleep(300)

// open the add editor
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '+ Add')?.click())
await sleep(300)
const editorOpen = await page.evaluate(() => document.body.innerText.includes('Add transaction'))
console.log('editor open:', editorOpen)
await page.type('input[list]', 'Calendar Test')
const inputs = await page.$$('input[placeholder="0,00"]')
await inputs[0].type('5,00')
await shot('editor')
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add transaction')?.click())
await sleep(800)
const added = await page.evaluate(() => document.body.innerText.includes('Calendar Test'))
console.log('added + visible in rail:', added)
await shot('added')

// edit it: 5,00 → 7,50
await page.evaluate(() => [...document.querySelectorAll('button[title="Edit"]')][0]?.click())
await sleep(300)
const editPrefilled = await page.evaluate(() => document.querySelector('input[list]')?.value === 'Calendar Test')
console.log('edit prefilled payee:', editPrefilled)
const outflow = (await page.$$('input[placeholder="0,00"]'))[0]
await outflow.click({ clickCount: 3 })
await outflow.type('7,50')
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save changes')?.click())
await sleep(800)
const edited = await page.evaluate(() => document.body.innerText.includes('7,50'))
console.log('edited amount visible:', edited)
await shot('edited')

// delete it
await page.evaluate(() => [...document.querySelectorAll('button[title^="Delete"]')][0]?.click())
await sleep(800)
const gone = await page.evaluate(() => !document.body.innerText.includes('Calendar Test'))
console.log('deleted:', gone)
await shot('deleted')

console.log('page errors:', errors.length === 0 ? 'NONE' : errors.slice(0, 5))
await browser.close()
