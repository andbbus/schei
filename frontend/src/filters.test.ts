import { describe, expect, it } from 'vitest'
import { EMPTY_FILTERS, applyFilters, activeCount, filtersToQuery, filtersFromQuery, type Filters } from './filters'
import type { TxnRow } from './api'

const row = (over: Partial<TxnRow>): TxnRow => ({
  id: 't1',
  date: '2026-08-14',
  payee: 'Lidl',
  payeeId: 'p1',
  category: 'Groceries',
  categoryId: 'c1',
  memo: '',
  amount: -17990,
  cleared: 'cleared',
  flagColor: null,
  transferAccountId: null,
  accountId: 'a1',
  runningBalance: 0,
  upcoming: false,
  scheduledId: null,
  frequency: null,
  anchorDay: null,
  subtransactions: [],
  ...over,
})

const F = (over: Partial<Filters>): Filters => ({ ...EMPTY_FILTERS, ...over })

const params = (o: Record<string, string>) => new URLSearchParams(o)

describe('applyFilters', () => {
  it('returns everything with empty filters', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' })]
    expect(applyFilters(rows, EMPTY_FILTERS).map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('filters by text on payee/category/memo only, case-insensitive', () => {
    const rows = [row({ payee: 'Spotify' }), row({ memo: 'reno bill' }), row({ category: 'Mensa' })]
    expect(applyFilters(rows, F({ q: 'SPOT' })).length).toBe(1)
    expect(applyFilters(rows, F({ q: 'bill' })).length).toBe(1)
    expect(applyFilters(rows, F({ q: '17.99' })).length).toBe(0) // amount is not text-searchable
  })

  it('date bounds are inclusive ISO comparisons', () => {
    const rows = [row({ id: 'a', date: '2026-06-01' }), row({ id: 'b', date: '2026-07-31' })]
    expect(applyFilters(rows, F({ from: '2026-06-01', to: '2026-07-31' })).length).toBe(2)
    expect(applyFilters(rows, F({ from: '2026-07-01' })).map((r) => r.id)).toEqual(['b'])
    expect(applyFilters(rows, F({ to: '2026-06-30' })).map((r) => r.id)).toEqual(['a'])
  })

  it('empty min/max are unbounded, values are signed milliunits', () => {
    const rows = [row({ id: 'a', amount: -25000 }), row({ id: 'b', amount: -17990 }), row({ id: 'c', amount: 50000 })]
    expect(applyFilters(rows, F({ min: '' })).length).toBe(3)
    expect(applyFilters(rows, F({ min: '-20' })).map((r) => r.id)).toEqual(['b', 'c']) // €-20 → -20000 milliunits
    expect(applyFilters(rows, F({ max: '-18' })).map((r) => r.id)).toEqual(['a']) // €-18 → -18000 milliunits
    expect(applyFilters(rows, F({ min: '-25' })).length).toBe(3) // boundary is inclusive
  })

  it('min > max yields nothing', () => {
    const rows = [row({ amount: -17990 })]
    expect(applyFilters(rows, F({ min: '-1000', max: '-2000' })).length).toBe(0)
  })

  it('cleared pill: "cleared" means cleared OR reconciled', () => {
    const rows = [row({ id: 'u', cleared: 'uncleared' }), row({ id: 'c', cleared: 'cleared' }), row({ id: 'r', cleared: 'reconciled' })]
    expect(applyFilters(rows, F({ cleared: 'cleared' })).map((r) => r.id)).toEqual(['c', 'r'])
    expect(applyFilters(rows, F({ cleared: 'uncleared' })).map((r) => r.id)).toEqual(['u'])
    expect(applyFilters(rows, F({ cleared: 'reconciled' })).map((r) => r.id)).toEqual(['r'])
  })

  it('multi-select categories/payees/flags are OR-composed', () => {
    const rows = [
      row({ id: 'c1', categoryId: 'c1' }),
      row({ id: 'c2', categoryId: 'c2' }),
      row({ id: 'c3', categoryId: 'c3' }),
    ]
    expect(applyFilters(rows, F({ categories: ['c1', 'c3'] })).map((r) => r.id).sort()).toEqual(['c1', 'c3'])
    expect(applyFilters(rows, F({ categories: ['c2'] })).map((r) => r.id)).toEqual(['c2'])
    expect(applyFilters(rows, F({ categories: [] })).length).toBe(3)
    // payee multi-select
    const pr = [row({ id: 'p1', payeeId: 'p1' }), row({ id: 'p2', payeeId: 'p2' }), row({ id: 'none', payeeId: null })]
    expect(applyFilters(pr, F({ payees: ['p1', '__none__'] })).map((r) => r.id).sort()).toEqual(['none', 'p1'])
  })

  it('flag filter matches null via __none__ sentinel, OR-composed', () => {
    const rows = [row({ id: 'n', flagColor: null }), row({ id: 'r', flagColor: 'red' }), row({ id: 'b', flagColor: 'blue' })]
    expect(applyFilters(rows, F({ flags: ['__none__'] })).map((r) => r.id)).toEqual(['n'])
    expect(applyFilters(rows, F({ flags: ['red'] })).map((r) => r.id)).toEqual(['r'])
    expect(applyFilters(rows, F({ flags: ['red', 'blue'] })).map((r) => r.id).sort()).toEqual(['b', 'r'])
    expect(applyFilters(rows, F({ flags: ['__none__', 'blue'] })).map((r) => r.id).sort()).toEqual(['b', 'n'])
  })

  it('category/payee null matching via __none__', () => {
    const rows = [row({ id: 'n', categoryId: null, category: 'Split' }), row({ id: 'c', categoryId: 'c1' })]
    expect(applyFilters(rows, F({ categories: ['__none__'] })).map((r) => r.id)).toEqual(['n'])
    expect(applyFilters(rows, F({ payees: ['__none__'] })).length).toBe(0)
  })

  it('scheduled ghosts pass through the same filters', () => {
    const ghost = row({ id: 'sched:s1', scheduledId: 's1', frequency: 'monthly', cleared: 'uncleared', date: '2026-09-01', runningBalance: 0, upcoming: true })
    expect(applyFilters([ghost], F({ cleared: 'cleared' })).length).toBe(0)
    expect(applyFilters([ghost], F({ cleared: 'uncleared' })).length).toBe(1)
    expect(applyFilters([ghost], F({ to: '2026-08-31' })).length).toBe(0)
  })

  it('AND-composes across fields', () => {
    const rows = [
      row({ id: 'a', payee: 'Lidl', category: 'Groceries' }),
      row({ id: 'b', payee: 'Lidl', category: 'Clothing', categoryId: 'c2' }),
    ]
    expect(applyFilters(rows, F({ q: 'lidl', categories: ['c1'] })).map((r) => r.id)).toEqual(['a'])
  })
})

describe('activeCount', () => {
  it('counts only non-default fields', () => {
    expect(activeCount(EMPTY_FILTERS)).toBe(0)
    expect(activeCount(F({ q: 'x', cleared: 'reconciled' }))).toBe(2)
    expect(activeCount(F({ from: '2026-01-01' }))).toBe(1)
    expect(activeCount(F({ flags: ['__none__'] }))).toBe(1)
    expect(activeCount(F({ categories: ['c1', 'c2'] }))).toBe(1) // one multi-select = one filter
  })
})

describe('URL persistence round-trip', () => {
  it('serializes only non-default fields, comma-joined multis', () => {
    expect(filtersToQuery(EMPTY_FILTERS)).toEqual({})
    expect(filtersToQuery(F({ q: 'lidl', categories: ['c1', 'c2'], cleared: 'cleared' }))).toEqual({
      q: 'lidl',
      cat: 'c1,c2',
      cleared: 'cleared',
    })
    expect(filtersToQuery(F({ flags: ['__none__', 'red'], payees: ['p1'] }))).toEqual({
      flag: '__none__,red',
      payee: 'p1',
    })
  })

  it('parses back to the same filters, ignoring junk params', () => {
    const f = filtersFromQuery(params({ q: 'lidl', cat: 'c1,c2', min: '-20', cleared: 'reconciled', flag: 'red', junk: 'x' }))
    expect(f).toEqual(F({ q: 'lidl', categories: ['c1', 'c2'], min: '-20', cleared: 'reconciled', flags: ['red'] }))
    expect(filtersFromQuery(params({ cleared: 'bogus' })).cleared).toBe('all')
    expect(filtersFromQuery(new URLSearchParams())).toEqual(EMPTY_FILTERS)
  })

  it('round-trips through toQuery/fromQuery', () => {
    const f = F({ q: 'x', from: '2026-01-01', payees: ['p1', '__none__'], max: '100', cleared: 'uncleared' })
    expect(filtersFromQuery(new URLSearchParams(filtersToQuery(f)))).toEqual(f)
  })
})
