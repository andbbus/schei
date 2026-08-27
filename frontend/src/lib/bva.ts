import type { CategoryView, GroupView } from '../api'

export interface BvaRow {
  categoryId: string
  name: string
  hidden: boolean
  assigned: number
  activity: number
  available: number
  overspendType: 'cash' | 'credit' | 'mixed' | null
  spent: number // -min(activity, 0)
  refunded: number // max(activity, 0)
  utilization: number | null // spent/assigned when assigned > 0, else null
}

export interface BvaSection {
  groupId: string
  groupName: string
  groupHidden: boolean
  rows: BvaRow[]
}

export interface BvaTotals {
  assigned: number
  activity: number
  available: number
  spent: number
  refunded: number
}

const makeRow = (c: CategoryView): BvaRow => ({
  categoryId: c.id,
  name: c.name,
  hidden: c.hidden,
  assigned: c.assigned,
  activity: c.activity,
  available: c.available,
  overspendType: c.overspendType,
  spent: -Math.min(c.activity, 0),
  refunded: Math.max(c.activity, 0),
  utilization: c.assigned > 0 ? -Math.min(c.activity, 0) / c.assigned : null,
})

// Payment categories (credit-card payment accounts) are excluded from the
// regular sections, totals, utilization and chart: their activity is internal
// reallocation, not spending. Inflow group serializes with zero categories
// and drops out via the empty-sections filter.
export function buildBva(groups: GroupView[]): { regular: BvaSection[]; payments: BvaRow[]; totals: BvaTotals } {
  const regular: BvaSection[] = []
  const payments: BvaRow[] = []
  const totals: BvaTotals = { assigned: 0, activity: 0, available: 0, spent: 0, refunded: 0 }
  for (const g of groups) {
    if (g.categories.length === 0) continue
    for (const c of g.categories) {
      const row = makeRow(c)
      if (c.paymentAccountId) {
        payments.push(row)
        continue
      }
      let sec = regular.find((s) => s.groupId === g.id)
      if (!sec) {
        sec = { groupId: g.id, groupName: g.name, groupHidden: g.hidden, rows: [] }
        regular.push(sec)
      }
      sec.rows.push(row)
      totals.assigned += row.assigned
      totals.activity += row.activity
      totals.available += row.available
      totals.spent += row.spent
      totals.refunded += row.refunded
    }
  }
  return { regular, payments, totals }
}

export type RowColor = 'red' | 'amber' | 'amberLight' | 'green'

export function rowColor(row: BvaRow): RowColor {
  if (row.available < 0) return row.overspendType === 'credit' ? 'amber' : 'red'
  if (row.utilization !== null && row.utilization >= 0.9) return 'amberLight'
  return 'green'
}
