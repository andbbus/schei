import type { Currency } from './format'

const BASE = '/api'

async function get<T>(path: string): Promise<T> {
  const r = await fetch(BASE + path)
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}
async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

// Backend errors arrive as JSON text like {"error":"..."} — surface the message.
export function errMsg(e: Error): string {
  try {
    return (JSON.parse(e.message) as { error?: string }).error ?? e.message
  } catch {
    return e.message
  }
}

// ---- types (mirror backend payloads) ----
export interface AccountLite {
  id: string
  name: string
  type: string
  onBudget: boolean
  closed: boolean
  cleared: number
  uncleared: number
  working: number
  upcoming: number
}
export interface BudgetMeta {
  budget: {
    id: string
    name: string
    currencySymbol: string
    decimalDigits: number
    locale: string
    dateFormat: string
    firstMonth: string
    lastMonth: string
  }
  months: string[]
  currentMonth: string
  ageOfMoney: number | null
  accounts: AccountLite[]
}
export interface TargetState {
  hasTarget: boolean
  neededThisMonth: number
  underfunded: number
  progress: number
  state: 'none' | 'funded' | 'underfunded'
}
export interface CategoryView {
  id: string
  name: string
  note: string | null
  hidden: boolean
  paymentAccountId: string | null
  overspendType: 'cash' | 'credit' | 'mixed' | null
  goalType: string | null
  goalTarget: number | null
  goalCadence: string | null
  goalDay: number | null
  goalTargetMonth: string | null
  goalNeedsWholeAmount: boolean | null
  assigned: number
  activity: number
  available: number
  target: TargetState
}
export interface GroupView {
  id: string
  name: string
  isSystem: boolean
  hidden: boolean
  assigned: number
  activity: number
  available: number
  categories: CategoryView[]
}
export interface MonthView {
  month: string
  readyToAssign: number
  income: number
  totalAssigned: number
  totalActivity: number
  currency: Currency
  groups: GroupView[]
}
export interface TxnRow {
  id: string
  date: string
  payee: string
  payeeId: string | null
  category: string
  categoryId: string | null
  memo: string
  amount: number
  cleared: string
  flagColor: string | null
  transferAccountId: string | null
  runningBalance: number
  upcoming: boolean
  scheduledId: string | null
  frequency: string | null
}
export type AutoAssignMode =
  | 'underfunded'
  | 'assignedLastMonth'
  | 'spentLastMonth'
  | 'averageAssigned'
  | 'averageSpent'
  | 'resetAvailable'
  | 'resetAssigned'

export const api = {
  budget: () => get<BudgetMeta>('/budget'),
  month: (m: string) => get<MonthView>(`/months/${m}`),
  assign: (m: string, categoryId: string, assigned: number) =>
    send<MonthView>('PATCH', `/months/${m}/categories/${categoryId}`, { assigned }),
  autoAssign: (m: string, categoryIds: string[], mode: AutoAssignMode) =>
    send<MonthView>('POST', `/months/${m}/auto-assign`, { categoryIds, mode }),
  move: (m: string, fromCategoryId: string, toCategoryId: string, amount: number) =>
    send<MonthView>('POST', `/months/${m}/move`, { fromCategoryId, toCategoryId, amount }),

  accountTxns: (id: string) => get<TxnRow[]>(`/accounts/${id}/transactions`),
  createTxn: (b: Record<string, unknown>) => send('POST', '/transactions', b),
  updateTxn: (id: string, b: Record<string, unknown>) => send('PATCH', `/transactions/${id}`, b),
  deleteTxn: (id: string) => send('DELETE', `/transactions/${id}`),
  toggleCleared: (id: string, cleared: string) => send('PATCH', `/transactions/${id}/cleared`, { cleared }),
  createScheduled: (b: Record<string, unknown>) => send('POST', '/scheduled', b),
  updateScheduled: (id: string, b: Record<string, unknown>) => send('PATCH', `/scheduled/${id}`, b),
  deleteScheduled: (id: string) => send('DELETE', `/scheduled/${id}`),
  createAccount: (b: Record<string, unknown>) => send('POST', '/accounts', b),
  reconcile: (accountId: string, balance: number) =>
    send<{ adjusted: number }>('POST', `/accounts/${accountId}/reconcile`, { balance }),

  payees: () => get<{ id: string; name: string }[]>('/payees'),
  categories: () => get<GroupView[]>('/categories'),
  patchCategory: (id: string, b: Record<string, unknown>) => send('PATCH', `/categories/${id}`, b),
  createCategory: (groupId: string, name: string) => send('POST', '/categories', { groupId, name }),
  deleteCategory: (id: string) => send('DELETE', `/categories/${id}`),
  createGroup: (name: string) => send('POST', '/category-groups', { name }),
  patchGroup: (id: string, b: Record<string, unknown>) => send('PATCH', `/category-groups/${id}`, b),
  deleteGroup: (id: string) => send('DELETE', `/category-groups/${id}`),

  reportSpending: (from: string, to: string) =>
    get<{ from: string; to: string; total: number; categories: { categoryId: string; name: string; amount: number }[] }>(
      `/reports/spending?from=${from}&to=${to}`,
    ),
  reportIncomeExpense: () => get<{ month: string; income: number; expense: number }[]>('/reports/income-expense'),
  reportNetWorth: () => get<{ month: string; assets: number; debts: number; netWorth: number }[]>('/reports/net-worth'),
  reportAge: () => get<{ month: string; age: number | null }[]>('/reports/age-of-money'),
}
