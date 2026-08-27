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
// Basic arithmetic expressions ("5+3", "2*4", "10/2", "1.234,56-20") are evaluated.
export function parseAmount(input: string): number {
  const s = input.trim()
  const isPlain = /^-?\d[\d.,]*$/.test(s)
  if (isPlain) {
    const v = parsePlainNumber(s)
    return v !== null ? Math.round(v * 1000) : 0
  }
  const expr = evalExpression(s)
  if (expr !== null) return Math.round(expr * 1000)
  if (/[+\-*/()]/.test(s)) return 0
  const v = parsePlainNumber(s.replace(/[^0-9.,-]/g, ''))
  return v !== null ? Math.round(v * 1000) : 0
}

// "5+3" → 8, "2*4" → 8, "10/2" → 5, "1.234,56+10" → 1244.56; null if not a valid expression.
export function evalExpression(input: string): number | null {
  const s = input.trim()
  if (!s) return null
  const tokens: string[] = []
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (/\s/.test(ch)) { i++; continue }
    if (/[0-9.,]/.test(ch)) {
      let j = i
      while (j < s.length && /[0-9.,]/.test(s[j])) j++
      tokens.push(s.slice(i, j))
      i = j
      continue
    }
    if ('+-*/()'.includes(ch)) { tokens.push(ch); i++; continue }
    return null
  }
  if (!tokens.length) return null
  const prec: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, 'u-': 3, 'u+': 3 }
  const out: number[] = []
  const ops: string[] = []
  let expectOperand = true
  const applyTop = (): boolean => {
    const op = ops.pop()
    if (op === 'u-' || op === 'u+') {
      if (!out.length) return false
      if (op === 'u-') out[out.length - 1] = -out[out.length - 1]
      return true
    }
    if (out.length < 2 || op === undefined) return false
    const b = out.pop()!
    const a = out.pop()!
    if (op === '/' && b === 0) return false
    out.push(op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : a / b)
    return true
  }
  for (const t of tokens) {
    if (t === '(') { ops.push(t); expectOperand = true; continue }
    if (t === ')') {
      while (ops.length && ops[ops.length - 1] !== '(') {
        if (!applyTop()) return null
      }
      if (!ops.length || ops[ops.length - 1] !== '(') return null
      ops.pop()
      expectOperand = false
      continue
    }
    if (prec[t] !== undefined) {
      if (expectOperand && (t === '-' || t === '+')) {
        ops.push(t === '-' ? 'u-' : 'u+')
        continue
      }
      if (expectOperand) return null
      while (ops.length && ops[ops.length - 1] !== '(' && prec[ops[ops.length - 1]] >= prec[t]) {
        if (!applyTop()) return null
      }
      ops.push(t)
      expectOperand = true
      continue
    }
    const v = parsePlainNumber(t)
    if (v === null) return null
    out.push(v)
    expectOperand = false
  }
  while (ops.length) {
    if (!applyTop()) return null
  }
  return out.length === 1 && Number.isFinite(out[0]) ? out[0] : null
}

// Replace a typed expression with its result ("5+3" → "8"); plain numbers pass through.
export function normalizeAmount(input: string): string {
  const s = input.trim()
  if (!s) return s
  if (/^-?\d[\d.,]*$/.test(s)) return s
  const expr = evalExpression(s)
  return expr !== null ? String(Math.round(expr * 1000) / 1000) : s
}

function parsePlainNumber(raw: string): number | null {
  const s = raw.trim()
  if (!s || s === '-') return null
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
  const v = parseFloat(t)
  return Number.isFinite(v) ? (neg ? -v : v) : null
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

// "2026-06-01" → "Jun '26"
export function shortMonth(m: string): string {
  const [y, mm] = m.split('-')
  return `${new Date(Date.UTC(+y, +mm - 1, 1)).toLocaleDateString('en-US', { month: 'short' })} '${y.slice(2)}`
}

// "4,5" / "4.5" / "4,5%" → 0.045 (fraction). For APR fields.
export function parsePercent(input: string): number {
  const s = input.trim().replace(/%/g, '').replace(/\s/g, '').replace(',', '.')
  const v = parseFloat(s)
  return Number.isFinite(v) ? v / 100 : 0
}
