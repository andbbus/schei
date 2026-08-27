// Schedule occurrence date math (mirror of the backend engine/schedule.ts so
// the register editor can preview upcoming occurrences client-side).

export type Frequency = 'once' | 'weekly' | 'everyOtherWeek' | 'monthly' | 'yearly'

function addDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function addMonths(month: string, n: number): string {
  const [y, m] = month.slice(0, 7).split('-').map(Number)
  const total = y * 12 + (m - 1) + n
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}-01`
}

function clampDay(month: string, day: number): string {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${month.slice(0, 7)}-${String(Math.min(day, last)).padStart(2, '0')}`
}

export function nextOccurrence(frequency: string, date: string, anchorDay?: number): string | null {
  switch (frequency as Frequency) {
    case 'once':
      return null
    case 'weekly':
      return addDays(date, 7)
    case 'everyOtherWeek':
      return addDays(date, 14)
    case 'monthly':
      if (anchorDay) return clampDay(addMonths(date, 1), anchorDay)
      return clampDay(addMonths(date, 1), Number(date.slice(8, 10)))
    case 'yearly': {
      const next = `${Number(date.slice(0, 4)) + 1}${date.slice(4, 7)}`
      return clampDay(next, anchorDay ?? Number(date.slice(8, 10)))
    }
    default:
      return null
  }
}

// The next `n` occurrence dates strictly after `from` (cap 120).
export function nextDates(frequency: string, from: string, n: number, anchorDay?: number): string[] {
  const out: string[] = []
  let cursor = from
  for (let i = 0; out.length < n && i < 120; i++) {
    const next = nextOccurrence(frequency, cursor, anchorDay)
    if (!next) break
    out.push(next)
    cursor = next
  }
  return out
}
