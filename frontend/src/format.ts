export interface Currency {
  symbol: string
  digits: number
  locale: string
}

// Format milliunits → "€1.234,56" (negatives as "-€17,99").
export function fmt(milli: number, c?: Currency): string {
  const symbol = c?.symbol ?? '$'
  const digits = c?.digits ?? 2
  const locale = c?.locale ?? 'en-US'
  const neg = milli < 0
  const abs = Math.abs(milli) / 1000
  const body = abs.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })
  return `${neg ? '-' : ''}${symbol}${body}`
}

// Parse a typed amount ("1.234,56" or "1,234.56" or "12.5") → milliunits.
// Heuristic: the last '.' or ',' is the decimal separator.
export function parseAmount(input: string): number {
  const s = input.trim().replace(/[^0-9.,-]/g, '')
  if (!s || s === '-') return 0
  const neg = s.startsWith('-')
  let t = s.replace(/-/g, '')
  const decPos = Math.max(t.lastIndexOf(','), t.lastIndexOf('.'))
  if (decPos >= 0) {
    const intPart = t.slice(0, decPos).replace(/[.,]/g, '')
    const fracPart = t.slice(decPos + 1).replace(/[.,]/g, '')
    t = `${intPart}.${fracPart}`
  } else {
    t = t.replace(/[.,]/g, '')
  }
  const v = Math.round(parseFloat(t || '0') * 1000)
  return neg ? -v : v
}

// "2026-06-01" → "June 2026" (English month names — matches an English YNAB app).
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

export function addMonth(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + n, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
}

// "2026-07-12" → "12/07/2026" (DD/MM/YYYY).
export function dateDisplay(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

export const todayISO = () => new Date().toISOString().slice(0, 10)
