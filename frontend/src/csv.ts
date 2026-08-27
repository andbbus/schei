import type { Currency } from './format'

// Locale-aware delimiter/decimal pair: it-IT → ';' + ',', en-US → ',' + '.',
// so exported CSVs open as numbers in the user's Excel.
export function csvSeparators(locale: string): { delim: string; decimal: string } {
  const parts = new Intl.NumberFormat(locale).formatToParts(1.1)
  const decimal = parts.find((p) => p.type === 'decimal')?.value ?? '.'
  return { delim: decimal === ',' ? ';' : ',', decimal }
}

function csvCell(value: string | number | null): string {
  if (value === null || value === undefined) return ''
  // Formula-injection guard for free text only — machine-generated numbers stay raw.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(value)) return `'${value}`
  return String(value)
}

// RFC 4180 quoting, CRLF line endings, UTF-8 BOM prefix.
export function toCsv(cells: (string | number | null)[][], locale: string): string {
  const { delim } = csvSeparators(locale)
  const lines = cells.map((row) =>
    row
      .map((v) => {
        const s = csvCell(v)
        return s.includes(delim) || s.includes('"') || s.includes('\n') || s.includes('\r')
          ? `"${s.replace(/"/g, '""')}"`
          : s
      })
      .join(delim),
  )
  return '\uFEFF' + lines.join('\r\n') + '\r\n'
}

export function csvAmount(milli: number, c: Currency): string {
  const abs = Object.is(milli, -0) ? 0 : milli / 1000
  return abs.toLocaleString(c.locale, { minimumFractionDigits: c.digits, maximumFractionDigits: c.digits })
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '_')
}

export function downloadFile(name: string, text: string, mime = 'text/csv;charset=utf-8') {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: mime }))
  a.download = sanitizeFilename(name)
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
