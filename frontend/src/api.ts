import type { Currency } from './format'

const BASE = '/api'

async function get<T>(path: string): Promise<T> {
  const r = await fetch(BASE + path)
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}
async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  // content-type only with a body: Fastify 400s on an empty JSON body (DELETEs)
  const r = await fetch(BASE + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
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
    categoryLearning?: boolean
  }
  months: string[]
  currentMonth: string
  ageOfMoney: number | null
  accounts: AccountLite[]
}

export interface RulePayload {
  pattern: string
  field?: string
  op?: string
  stage?: string
  enabled?: boolean
  action?: string
  actionText?: string | null
  categoryId?: string | null
}

export function isCategoryRule(rule: { action?: string | null }): boolean {
  return (rule.action ?? 'category') === 'category'
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
export interface ExpectedItem {
  date: string
  payee: string
  category: string | null
  categoryId: string | null
  amount: number // signed milliunits, positive = inflow
  source: 'scheduled' | 'upcoming'
  frequency: string | null
}
export interface ExpectedMonth {
  month: string
  items: ExpectedItem[]
  net: number
}
export interface ExpectedData {
  months: ExpectedMonth[]
}
export interface ForecastCat {
  categoryId: string
  categoryName: string
  avg: number // signed milliunits, negative = spending
  overridden?: boolean
}
export interface ForecastData {
  window: number
  month: string
  historyMonths: number
  projected: ForecastCat[]
  projectedTotal: number
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
  accountId: string
  runningBalance: number
  upcoming: boolean
  scheduledId: string | null
  frequency: string | null
  anchorDay: number | null
  subtransactions: {
    id: string
    amount: number
    categoryId: string | null
    payeeId: string | null
    memo: string
    transferAccountId: string | null
  }[]
}
export type AutoAssignMode =
  | 'underfunded'
  | 'assignedLastMonth'
  | 'spentLastMonth'
  | 'averageAssigned'
  | 'averageSpent'
  | 'resetAvailable'
  | 'resetAssigned'

export interface ScheduledRow {
  id: string
  accountId: string
  payeeId: string | null
  payee: string | null
  categoryId: string | null
  category: string | null
  amount: number
  memo: string | null
  flagColor: string | null
  frequency: string
  nextDate: string
  anchorDay: number | null
  startMonth: string | null
  endMonth: string | null
  transferAccountId: string | null
}

export const api = {
  budget: () => get<BudgetMeta>('/budget'),
  month: (m: string) => get<MonthView>(`/months/${m}`),
  expected: (months: number) => get<ExpectedData>(`/expected?months=${months}`),
  forecast: (month: string, months: number) => get<ForecastData>(`/forecast?month=${month}&window=${months}`),
  setForecastOverride: (categoryId: string, month: string, amount: number) =>
    send<{ ok: boolean }>('PUT', `/forecast/overrides/${categoryId}`, { month, amount }),
  deleteForecastOverride: (categoryId: string, month: string) =>
    send<{ ok: boolean }>('DELETE', `/forecast/overrides/${categoryId}?month=${month}`),
  assign: (m: string, categoryId: string, assigned: number) =>
    send<MonthView>('PATCH', `/months/${m}/categories/${categoryId}`, { assigned }),
  autoAssign: (m: string, categoryIds: string[], mode: AutoAssignMode) =>
    send<MonthView>('POST', `/months/${m}/auto-assign`, { categoryIds, mode }),
  move: (m: string, fromCategoryId: string, toCategoryId: string, amount: number) =>
    send<MonthView>('POST', `/months/${m}/move`, { fromCategoryId, toCategoryId, amount }),

  accountTxns: (id: string) => get<TxnRow[]>(`/accounts/${id}/transactions`),
  bulkTxns: (ids: string[], data: Record<string, unknown>, del = false) =>
    send<{ ok: boolean; updated: number; skipped: number }>('POST', '/transactions/bulk', { ids, data, delete: del }),
  txnsByCategory: (b: { categoryId: string; from: string; to: string; accountId?: string }) => {
    const q = `categoryId=${b.categoryId}&from=${b.from}&to=${b.to}${b.accountId ? `&accountId=${b.accountId}` : ''}`
    return get<{ categoryId: string; categoryName: string; from: string; to: string; txns: TxnRow[] }>(
      `/transactions?${q}`,
    )
  },
  createTxn: (b: Record<string, unknown>) => send('POST', '/transactions', b),
  updateTxn: (id: string, b: Record<string, unknown>) => send('PATCH', `/transactions/${id}`, b),
  deleteTxn: (id: string) => send('DELETE', `/transactions/${id}`),
  toggleCleared: (id: string, cleared: string) => send('PATCH', `/transactions/${id}/cleared`, { cleared }),
  skipScheduled: (id: string) => send<{ nextDate: string }>('POST', `/scheduled/${id}/skip`),
  duplicates: (accountId?: string) =>
    get<{ date: string; amount: number; payeeId: string | null; payee: string; txnIds: string[] }[]>(
      `/transactions/duplicates${accountId ? `?accountId=${accountId}` : ''}`,
    ),
  importCsv: (csv: string, accountName: string) =>
    send<{ imported: number; skipped: number; transferPairs: number; account: string; backup: string | null }>(
      'POST',
      '/import/csv',
      { csv, accountName },
    ),
  importTrCsv: (csv: string) =>
    send<{ imported: number; skipped: number; account: string; backup: string | null }>('POST', '/import/tr-csv', { csv }),
  payeesSimilar: () =>
    get<{ fromId: string; toId: string; fromName: string; toName: string; distance: number; similarity: number }[]>(
      '/payees/similar',
    ),
  dismissSuggestion: (payeeId: string, accountId: string) =>
    send('POST', '/suggestions/dismiss', { payeeId, accountId }),
  restoreSuggestion: (payeeId: string, accountId: string) =>
    send('DELETE', `/suggestions/dismiss?payeeId=${payeeId}&accountId=${accountId}`),
  dismissedSuggestions: () =>
    get<{ payeeId: string; payee: string; accountId: string; createdAt: string }[]>('/suggestions/dismissed'),
  createScheduled: (b: Record<string, unknown>) => send('POST', '/scheduled', b),
  scheduledList: () => get<ScheduledRow[]>('/scheduled'),
  suggestions: (accountId?: string) =>
    get<
      {
        payeeId: string
        payee: string
        accountId: string
        categoryId: string | null
        amount: number
        frequency: string
        anchorDay: number | null
        nextDate: string
        occurrences: number
        confidence: number
        varies: boolean
        recentDates: string[]
      }[]
    >(`/scheduled/suggestions${accountId ? `?accountId=${accountId}` : ''}`),
  updateScheduled: (id: string, b: Record<string, unknown>) => send('PATCH', `/scheduled/${id}`, b),
  deleteScheduled: (id: string) => send('DELETE', `/scheduled/${id}`),
  createAccount: (b: Record<string, unknown>) => send('POST', '/accounts', b),
  reconcile: (accountId: string, balance: number) =>
    send<{ adjusted: number }>('POST', `/accounts/${accountId}/reconcile`, { balance }),

  payees: () => get<{ id: string; name: string }[]>('/payees'),
  createPayee: (name: string) => send<{ id: string; name: string }>('POST', '/payees', { name }),
  payeeManager: () =>
    get<
      {
        id: string
        name: string
        isTransfer: boolean
        learnDisabled?: boolean
        txnCount: number
        categories: { categoryId: string; name: string; count: number }[]
      }[]
    >('/payees/manage'),
  renamePayee: (id: string, name: string) => send('POST', `/payees/${id}/rename`, { name }),
  mergePayees: (fromId: string, toId: string) => send<{ ok: boolean; moved: number }>('POST', '/payees/merge', { fromId, toId }),
  ops: () => get<{ id: number; kind: string; summary: string; createdAt: string }[]>('/ops'),
  undoOp: (id: number) => send('POST', `/ops/${id}/undo`),

  debtPlans: () =>
    get<
      {
        id: string
        name: string
        accountId: string | null
        accountName: string | null
        balance: number
        effectiveBalance: number
        tanBps: number
        payment: number
        targetMonth: string | null
        extraPayment: number
        startMonth: string
        active: boolean
        note: string | null
        hasPaymentSchedule: boolean
        createdAt: string
        updatedAt: string
      }[]
    >('/debt-plans'),
  createDebtPlan: (b: Record<string, unknown>) => send('POST', '/debt-plans', b),
  updateDebtPlan: (id: string, b: Record<string, unknown>) => send('PATCH', `/debt-plans/${id}`, b),
  deleteDebtPlan: (id: string) => send('DELETE', `/debt-plans/${id}`),
  createPaymentSchedule: (id: string, b: Record<string, unknown>) => send('POST', `/debt-plans/${id}/payment-schedule`, b),

  goalPlans: () =>
    get<
      {
        id: string
        name: string
        accountId: string | null
        accountName: string | null
        categoryId: string | null
        categoryName: string | null
        target: number
        current: number
        effectiveCurrent: number
        monthlyContribution: number
        targetMonth: string | null
        startMonth: string
        active: boolean
        note: string | null
        hasContributionSchedule: boolean
        createdAt: string
        updatedAt: string
      }[]
    >('/goal-plans'),
  createGoalPlan: (b: Record<string, unknown>) => send('POST', '/goal-plans', b),
  updateGoalPlan: (id: string, b: Record<string, unknown>) => send('PATCH', `/goal-plans/${id}`, b),
  deleteGoalPlan: (id: string) => send('DELETE', `/goal-plans/${id}`),
  createContributionSchedule: (id: string, b: Record<string, unknown>) =>
    send('POST', `/goal-plans/${id}/contribution-schedule`, b),

  shoppingSync: () =>
    send<{ week: string; results: { store: string; status: string; count?: number; error?: string }[] }>(
      'POST',
      '/shopping/sync',
    ),
  shoppingImportCsv: (csv: string) => send<{ week: string; count: number }>('POST', '/shopping/import-csv', { csv }),
  shoppingCatalog: (q = '', store = 'all') =>
    get<{
      week: string
      items: { id: string; store: string; name: string; brand: string | null; price: number; unit: string | null; imageUrl: string | null }[]
    }>(`/shopping/catalog?q=${encodeURIComponent(q)}&store=${store}`),
  shoppingLists: () =>
    get<
      {
        id: string
        name: string
        createdAt: string
        items: { id: string; itemId: string | null; name: string; price: number; quantity: number; store: string; imageUrl: string | null }[]
      }[]
    >('/shopping/lists'),
  createShoppingList: (name?: string) => send('POST', '/shopping/lists', { name }),
  updateShoppingList: (id: string, name: string) => send('PATCH', `/shopping/lists/${id}`, { name }),
  deleteShoppingList: (id: string) => send('DELETE', `/shopping/lists/${id}`),
  shoppingAddItem: (listId: string, b: Record<string, unknown>) => send('POST', `/shopping/lists/${listId}/items`, b),
  shoppingSetQty: (listId: string, itemId: string, quantity: number) =>
    send('PATCH', `/shopping/lists/${listId}/items/${itemId}`, { quantity }),
  shoppingRemoveItem: (listId: string, itemId: string) => send('DELETE', `/shopping/lists/${listId}/items/${itemId}`),
  shoppingEmail: (listId: string, to?: string) => send('POST', `/shopping/lists/${listId}/email`, { to }),
  categories: () => get<GroupView[]>('/categories'),
  patchCategory: (id: string, b: Record<string, unknown>) => send('PATCH', `/categories/${id}`, b),
  createCategory: (groupId: string, name: string) => send('POST', '/categories', { groupId, name }),
  deleteCategory: (id: string) => send('DELETE', `/categories/${id}`),
  createGroup: (name: string) => send('POST', '/category-groups', { name }),
  patchGroup: (id: string, b: Record<string, unknown>) => send('PATCH', `/category-groups/${id}`, b),
  deleteGroup: (id: string) => send('DELETE', `/category-groups/${id}`),

  payeeRules: () =>
    get<
      {
        id: string
        pattern: string
        field?: string | null
        op?: string | null
        stage?: string | null
        enabled?: boolean
        action?: string | null
        actionText?: string | null
        categoryId: string | null
        categoryName: string
        categoryDeleted: boolean
        matchCount: number
        createdAt?: string
      }[]
    >('/payee-rules'),
  createPayeeRule: (b: RulePayload) => send('POST', '/payee-rules', b),
  updatePayeeRule: (id: string, b: Partial<RulePayload>) => send('PATCH', `/payee-rules/${id}`, b),
  deletePayeeRule: (id: string) => send('DELETE', `/payee-rules/${id}`),
  previewPayeeRule: (b: { pattern: string; field?: string; op?: string }) =>
    send<{ count: number; sample: { id: string; date: string; payee: string; memo: string | null; categoryName: string | null }[] }>(
      'POST',
      '/payee-rules/preview',
      b,
    ),
  applyPayeeRules: (b: { ruleId?: string; overwrite?: boolean; includeReconciled?: boolean }) =>
    send<{ applied: number; perRule: Record<string, number>; skipped: Record<string, number> }>(
      'POST',
      '/payee-rules/apply',
      b,
    ),
  learningOffer: (payeeName: string) =>
    get<{ payeeId: string; pattern: string; categoryId: string; categoryName: string; count: number; total: number } | null>(
      `/rules/learning-offer?payee=${encodeURIComponent(payeeName)}`,
    ),
  learnToggle: (payeeId: string, disabled: boolean) =>
    send('POST', `/payees/${payeeId}/learn-toggle`, { disabled }),
  autoRenameRule: (pattern: string, toName: string) => send('POST', '/rules/auto-rename', { pattern, toName }),
  setCategoryLearning: (enabled: boolean) => send('POST', '/settings/category-learning', { enabled }),

  reportSpending: (from: string, to: string, accountId?: string) =>
    get<{ from: string; to: string; total: number; categories: { categoryId: string; name: string; amount: number }[] }>(
      `/reports/spending?from=${from}&to=${to}${accountId ? `&accountId=${accountId}` : ''}`,
    ),
  reportIncomeExpense: (from?: string, to?: string) =>
    get<{ month: string; income: number; expense: number }[]>(`/reports/income-expense?from=${from}&to=${to}`),
  reportNetWorth: (from?: string, to?: string) =>
    get<{ month: string; assets: number; debts: number; netWorth: number }[]>(`/reports/net-worth?from=${from}&to=${to}`),
  reportAge: (from?: string, to?: string) =>
    get<{ month: string; age: number | null }[]>(`/reports/age-of-money?from=${from}&to=${to}`),
  reportCashflow: (months: number) =>
    get<{
      anchorRta: number
      anchorMonth: string
      historyMonths: number
      sufficient: boolean
      horizonMonths: number
      rows: {
        month: string
        partial: boolean
        knownScheduledNet: number
        projectedIncome: number
        projectedSpending: number
        projectedAssigned: number
        projectedNet: number
        projectedRTA: number | null
        overridesUsed: number
        schedules: { date: string; payee: string; amount: number; frequency: string; source: 'scheduled' | 'upcoming' }[]
      }[]
    }>(`/reports/cashflow?months=${months}`),
}
