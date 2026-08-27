import type { TxnRow } from './api'
import { parseAmount } from './format'

export interface Filters {
  q: string
  from: string
  to: string
  categories: string[] // category ids + '__none__' sentinel
  payees: string[] // payee ids + '__none__' sentinel
  min: string
  max: string
  cleared: 'all' | 'uncleared' | 'cleared' | 'reconciled'
  flags: string[] // flag colors
}

export const EMPTY_FILTERS: Filters = {
  q: '',
  from: '',
  to: '',
  categories: [],
  payees: [],
  min: '',
  max: '',
  cleared: 'all',
  flags: [],
}

export function activeCount(f: Filters): number {
  let n = 0
  if (f.q) n++
  if (f.from || f.to) n++
  if (f.categories.length > 0) n++
  if (f.payees.length > 0) n++
  if (f.min || f.max) n++
  if (f.cleared !== 'all') n++
  if (f.flags.length > 0) n++
  return n
}

// '__none__' is the sentinel for "matches the null value" (no payee / no
// category / no flag). Multi-select arrays are OR-composed; empty = any.
export function applyFilters(txns: TxnRow[], f: Filters): TxnRow[] {
  const q = f.q.trim().toLowerCase()
  const minV = f.min.trim() === '' ? -Infinity : parseAmount(f.min)
  const maxV = f.max.trim() === '' ? Infinity : parseAmount(f.max)
  return txns.filter((t) => {
    if (q && ![t.payee, t.category, t.memo].some((s) => s.toLowerCase().includes(q))) return false
    if (f.from && t.date < f.from) return false
    if (f.to && t.date > f.to) return false
    if (f.categories.length > 0 && !f.categories.some((c) => (c === '__none__' ? t.categoryId === null : t.categoryId === c))) return false
    if (f.payees.length > 0 && !f.payees.some((p) => (p === '__none__' ? t.payeeId === null : t.payeeId === p))) return false
    if (t.amount < minV || t.amount > maxV) return false
    if (f.cleared === 'cleared' && t.cleared === 'uncleared') return false
    if (f.cleared === 'uncleared' && t.cleared !== 'uncleared') return false
    if (f.cleared === 'reconciled' && t.cleared !== 'reconciled') return false
    if (f.flags.length > 0 && !f.flags.some((fl) => (fl === '__none__' ? t.flagColor === null : t.flagColor === fl))) return false
    return true
  })
}

// ---- URL persistence ----
// Multi-select values serialize as comma-joined params: ?cat=a,b&payee=x&flag=red.

export function filtersToQuery(f: Filters): Record<string, string> {
  const q: Record<string, string> = {}
  if (f.q) q.q = f.q
  if (f.from) q.from = f.from
  if (f.to) q.to = f.to
  if (f.categories.length > 0) q.cat = f.categories.join(',')
  if (f.payees.length > 0) q.payee = f.payees.join(',')
  if (f.min) q.min = f.min
  if (f.max) q.max = f.max
  if (f.cleared !== 'all') q.cleared = f.cleared
  if (f.flags.length > 0) q.flag = f.flags.join(',')
  return q
}

export function filtersFromQuery(params: URLSearchParams): Filters {
  return {
    q: params.get('q') ?? '',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
    categories: (params.get('cat') ?? '').split(',').filter(Boolean),
    payees: (params.get('payee') ?? '').split(',').filter(Boolean),
    min: params.get('min') ?? '',
    max: params.get('max') ?? '',
    cleared: ['uncleared', 'cleared', 'reconciled'].includes(params.get('cleared') ?? '')
      ? (params.get('cleared') as Filters['cleared'])
      : 'all',
    flags: (params.get('flag') ?? '').split(',').filter(Boolean),
  }
}
