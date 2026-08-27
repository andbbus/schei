import { describe, expect, it } from 'vitest'
import { buildBva, rowColor, type BvaRow } from './bva'
import type { CategoryView, GroupView } from '../api'

const cat = (over: Partial<CategoryView>): CategoryView => ({
  id: 'c1',
  name: 'Cat',
  note: null,
  hidden: false,
  paymentAccountId: null,
  overspendType: null,
  goalType: null,
  goalTarget: null,
  goalCadence: null,
  goalDay: null,
  goalTargetMonth: null,
  goalNeedsWholeAmount: null,
  assigned: 0,
  activity: 0,
  available: 0,
  target: { hasTarget: false, neededThisMonth: 0, underfunded: 0, progress: 0, state: 'none' },
  ...over,
})

const group = (name: string, cats: CategoryView[], extra: Partial<GroupView> = {}): GroupView => ({
  id: 'g' + name,
  name,
  isSystem: false,
  hidden: false,
  assigned: 0,
  activity: 0,
  available: 0,
  categories: cats,
  ...extra,
})

describe('buildBva', () => {
  it('splits payment categories out and computes row totals', () => {
    const g = group('Bills', [
      cat({ id: 'a', name: 'Rent', assigned: 100000, activity: -80000, available: 20000 }),
      cat({ id: 'p', name: 'Card payment', paymentAccountId: 'acct1', assigned: 0, activity: 50000, available: 50000 }),
    ])
    const { regular, payments, totals } = buildBva([g])
    expect(regular).toHaveLength(1)
    expect(regular[0].rows.map((r) => r.name)).toEqual(['Rent'])
    expect(payments.map((r) => r.name)).toEqual(['Card payment'])
    expect(totals).toEqual({ assigned: 100000, activity: -80000, available: 20000, spent: 80000, refunded: 0 })
  })

  it('drops the inflow group (empty categories)', () => {
    const { regular } = buildBva([group('Inflow', [])])
    expect(regular).toHaveLength(0)
  })

  it('computes spent/refunded and null utilization', () => {
    const { regular } = buildBva([
      group('N', [cat({ id: 'a', assigned: 100000, activity: -60000 }), cat({ id: 'b', assigned: 0, activity: 0 })]),
    ])
    const [a, b] = regular[0].rows
    expect(a.spent).toBe(60000)
    expect(a.refunded).toBe(0)
    expect(a.utilization).toBe(0.6)
    expect(b.utilization).toBeNull()
    const refundRow = cat({ id: 'r', assigned: 50000, activity: 120000 })
    expect(buildBva([group('N', [refundRow])]).regular[0].rows[0].refunded).toBe(120000)
  })

  it('hidden categories stay in totals', () => {
    const { totals } = buildBva([group('N', [cat({ id: 'h', hidden: true, assigned: 50000, activity: 0 }), cat({ id: 'v', assigned: 10000, activity: 0 })])])
    expect(totals.assigned).toBe(60000)
  })
})

describe('rowColor', () => {
  const row = (over: Partial<BvaRow>): BvaRow => ({
    categoryId: 'x',
    name: 'x',
    hidden: false,
    assigned: 0,
    activity: 0,
    available: 0,
    overspendType: null,
    spent: 0,
    refunded: 0,
    utilization: null,
    ...over,
  })
  it('negative available: red for cash/mixed, amber for credit', () => {
    expect(rowColor(row({ available: -100, overspendType: 'cash' }))).toBe('red')
    expect(rowColor(row({ available: -100, overspendType: 'mixed' }))).toBe('red')
    expect(rowColor(row({ available: -100, overspendType: 'credit' }))).toBe('amber')
  })
  it('positive available with high utilization → amberLight, else green', () => {
    expect(rowColor(row({ available: 10, utilization: 0.95 }))).toBe('amberLight')
    expect(rowColor(row({ available: 10, utilization: 0.4 }))).toBe('green')
    expect(rowColor(row({ available: 10, utilization: null }))).toBe('green')
  })
  it('available negative wins over utilization', () => {
    expect(rowColor(row({ available: -1, overspendType: null, utilization: 0.1 }))).toBe('red')
  })
})
