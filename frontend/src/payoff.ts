// Loan payoff math (Italian ammortamento francese convention):
// monthly rate = TAN/12 (nominal APR), month-end payments, per-row interest and
// principal rounded to the cent (milliunit precision), final row pays the exact
// residual. Pure and unit-tested.

export interface PayoffRow {
  month: number
  payment: number
  interest: number
  principal: number
  balance: number
}

export interface PayoffResult {
  rows: PayoffRow[]
  totalInterest: number
  payoffMonths: number
  finalPayment: number
  doesNotAmortize: boolean
}

export function amortize(opts: { balance: number; tanPercent: number; payment: number; extra: number }): PayoffResult {
  const { balance, tanPercent, payment, extra } = opts
  const r = tanPercent / 100 / 12
  const totalPayment = payment + extra
  if (balance <= 0 || totalPayment <= 0) {
    return { rows: [], totalInterest: 0, payoffMonths: 0, finalPayment: 0, doesNotAmortize: false }
  }
  const firstInterest = Math.round(balance * r)
  if (r > 0 && totalPayment <= firstInterest) {
    return { rows: [], totalInterest: 0, payoffMonths: 0, finalPayment: 0, doesNotAmortize: true }
  }
  const rows: PayoffRow[] = []
  let bal = balance
  let totalInterest = 0
  let month = 0
  while (bal > 0 && month < 600) {
    month++
    const interest = Math.round(bal * r)
    const pay = Math.min(totalPayment, bal + interest)
    const principal = pay - interest
    bal -= principal
    totalInterest += interest
    rows.push({ month, payment: pay, interest, principal, balance: Math.max(0, bal) })
    if (bal <= 0) break
  }
  const last = rows[rows.length - 1]
  return {
    rows,
    totalInterest,
    payoffMonths: month,
    finalPayment: last?.payment ?? 0,
    doesNotAmortize: false,
  }
}

// Fixed payment that clears the debt in `months` calendar months (r = 0 handled),
// rounded up to the cent so the final payment is smaller, never larger.
export function requiredPayment(balance: number, tanPercent: number, months: number): number {
  if (balance <= 0 || months < 1) return 0
  const r = tanPercent / 100 / 12
  const p = r === 0 ? balance / months : (balance * r) / (1 - Math.pow(1 + r, -months))
  return Math.ceil(p * 100) / 100
}

// Savings rate helpers. Money-weighted windows (Σinc−Σexp)/Σinc — never an
// average of per-month rates, which lumpy income (grant) would destroy.
export function moneyWeightedRate(series: { income: number; expense: number }[]): number | null {
  const inc = series.reduce((s, x) => s + x.income, 0)
  const exp = series.reduce((s, x) => s + x.expense, 0)
  if (inc <= 0) return null
  return (inc - exp) / inc
}

// Per-month rate, suppressed when income is missing/negative or the denominator
// is dominated (expense ≥ 2×income → absurd spikes like −15.600%).
export function perMonthRate(r: { income: number; expense: number }): number | null {
  if (r.income <= 0) return null
  if (r.expense >= 2 * r.income) return null
  return (r.income - r.expense) / r.income
}

// Residual balance at the END of month `month` (after that month's payment).
// null for month ≤ 0 (no payments yet) or when no schedule exists; the last
// row's balance when the plan ended earlier.
export function balanceAtMonth(rows: PayoffRow[], month: number): number | null {
  if (rows.length === 0 || month <= 0) return null
  const row = rows.find((r) => r.month === month) ?? rows[rows.length - 1]
  return row.balance
}

// Monthly contribution needed to reach `target` from `current` in `months`
// calendar months (interest-free). Returns 0 when already at/over target.
export function requiredContribution(current: number, target: number, months: number): number {
  const gap = target - current
  if (gap <= 0 || months < 1) return 0
  return Math.ceil((gap / months) * 100) / 100
}

// Months needed to reach `target` from `current` contributing `monthly` per
// month. null when monthly ≤ 0 or already done (0 months).
export function monthsToTarget(current: number, target: number, monthly: number): number | null {
  const gap = target - current
  if (gap <= 0) return 0
  if (monthly <= 0) return null
  return Math.ceil(gap / monthly)
}
