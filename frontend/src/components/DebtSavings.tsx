import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts'
import type { BudgetMeta } from '../api'
import { api } from '../api'
import { fmt, parseAmount, normalizeAmount, parsePercent, shortMonth, type Currency } from '../format'
import { amortize, moneyWeightedRate, perMonthRate, requiredPayment } from '../payoff'

export default function DebtSavings({ meta, range, c }: { meta: BudgetMeta; range: { from: string; to: string }; c: Currency }) {
  const windowEnd = range.to < meta.currentMonth ? range.to : meta.currentMonth
  const { data } = useQuery({
    queryKey: ['rep', 'ie', range.from, range.to],
    queryFn: () => api.reportIncomeExpense(range.from, range.to),
  })
  const series = useMemo(() => {
    const raw = (data ?? []).filter((m) => m.month <= windowEnd)
    return raw.map((m) => ({
      month: m.month,
      income: m.income,
      expense: m.expense,
      net: m.income - m.expense,
      rate: perMonthRate(m),
    }))
  }, [data, windowEnd])

  const trailing = (n: number) => series.slice(-n)
  const cards = [3, 6, 12].map((n) => {
    const rate = moneyWeightedRate(trailing(n))
    return { n, rate, months: Math.min(n, series.length) }
  })

  const tracking = meta.accounts.filter((a) => !a.onBudget && !a.closed)
  const [accountId, setAccountId] = useState('')
  const [balance, setBalance] = useState('')
  const [tan, setTan] = useState('4')
  const [payment, setPayment] = useState('')
  const [extra, setExtra] = useState('')
  const [mode, setMode] = useState<'payment' | 'byDate'>('payment')
  const [targetDate, setTargetDate] = useState('')

  const pickAccount = (id: string) => {
    setAccountId(id)
    const acct = meta.accounts.find((a) => a.id === id)
    if (acct && acct.working < 0) setBalance((-acct.working / 1000).toString())
  }

  const bal = parseAmount(balance) / 1000
  const tanPct = parsePercent(tan) * 100
  const targetMonths =
    mode === 'byDate' && targetDate
      ? (Number(targetDate.slice(0, 4)) - new Date().getFullYear()) * 12 +
        (Number(targetDate.slice(5, 7)) - (new Date().getMonth() + 1))
      : 0
  const effPayment =
    mode === 'byDate' && targetMonths >= 1 ? requiredPayment(bal, tanPct, targetMonths) : parseAmount(payment) / 1000
  const sim = useMemo(
    () => amortize({ balance: bal, tanPercent: tanPct, payment: effPayment, extra: parseAmount(extra) / 1000 }),
    [bal, tanPct, effPayment, extra],
  )
  const balanceChart = sim.rows.map((r) => ({ month: r.month, balance: r.balance * 1000, principal: r.principal * 1000 }))
  const showFullTable = sim.rows.length <= 120
  const tableRows = showFullTable
    ? sim.rows
    : [...sim.rows.slice(0, 12), ...sim.rows.slice(-12)]

  return (
    <div className="max-w-5xl">
      {/* ---- Savings rate ---- */}
      <h2 className="mb-2 font-semibold text-slate-700">Savings Rate</h2>
      <div className="mb-1 text-xs text-slate-400">
        Money-weighted rate over trailing windows (never an average of monthly rates — lumpy income like the grant would
        distort it). Expense includes transfers to tracking accounts; uncategorized outflows are excluded; income is
        inflows to Ready to Assign. Current month shows activity to date.
      </div>
      <div className="mb-4 flex gap-3">
        {cards.map((crd) => (
          <div key={crd.n} className="flex-1 rounded-lg border border-slate-200 p-3">
            <div className="text-xs text-slate-400">{crd.n} months</div>
            <div className={`tnum text-2xl font-semibold ${crd.rate === null ? 'text-slate-300' : crd.rate < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
              {crd.rate === null ? 'n/a' : `${(crd.rate * 100).toFixed(1)}%`}
            </div>
            {crd.rate !== null && crd.rate < 0 && <div className="text-[11px] text-slate-400">spending more than income</div>}
          </div>
        ))}
      </div>
      {series.length > 0 && (
        <div className="print:hidden">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={series}>
              <CartesianGrid strokeDasharray="3 3" stroke="#282c3f" />
              <XAxis dataKey="month" tickFormatter={shortMonth} fontSize={12} />
              <YAxis yAxisId="eur" tickFormatter={(v) => fmt(v, { ...c, digits: 0 })} fontSize={12} width={80} />
              <YAxis
                yAxisId="pct"
                orientation="right"
                tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
                fontSize={12}
                width={45}
              />
              <Tooltip
                formatter={(v, name) => {
                  if (name === 'Rate') return v === null ? 'no income' : `${(Number(v) * 100).toFixed(0)}%`
                  return fmt(Number(v), c)
                }}
                labelFormatter={(m) => shortMonth(String(m))}
              />
              <Legend />
              <Bar yAxisId="eur" dataKey="net" name="Net savings" fill={series.some((s) => s.net < 0) ? '#ff9e64' : '#9ece6a'} />
              <Line
                yAxisId="pct"
                type="monotone"
                dataKey="rate"
                name="Rate"
                stroke="#bb9af7"
                strokeWidth={2}
                dot={false}
                connectNulls={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="mt-8">
        <h2 className="mb-2 font-semibold text-slate-700">Payoff Simulator</h2>
        <div className="mb-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm md:grid-cols-3">
          <label className="flex flex-col text-xs text-slate-500">
            Tracking account (optional prefill)
            <select
              value={accountId}
              onChange={(e) => pickAccount(e.target.value)}
              className="mt-1 rounded border border-slate-200 px-2 py-1.5 text-sm text-slate-700"
            >
              <option value="">— manual entry —</option>
              {tracking.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs text-slate-500">
            Balance
            <input value={balance} onChange={(e) => setBalance(e.target.value)} onBlur={(e) => setBalance(normalizeAmount(e.target.value))} inputMode="decimal" className="tnum mt-1 rounded border border-slate-200 px-2 py-1.5 text-right text-sm" />
          </label>
          <label className="flex flex-col text-xs text-slate-500">
            TAN / APR % (nominal; TAEG fees not modeled)
            <input value={tan} onChange={(e) => setTan(e.target.value)} onBlur={(e) => setTan(normalizeAmount(e.target.value))} inputMode="decimal" className="tnum mt-1 rounded border border-slate-200 px-2 py-1.5 text-right text-sm" />
          </label>
          <label className="flex flex-col text-xs text-slate-500">
            Mode
            <select value={mode} onChange={(e) => setMode(e.target.value as 'payment' | 'byDate')} className="mt-1 rounded border border-slate-200 px-2 py-1.5 text-sm text-slate-700">
              <option value="payment">Fixed monthly payment</option>
              <option value="byDate">Pay off by date</option>
            </select>
          </label>
          {mode === 'payment' ? (
            <label className="flex flex-col text-xs text-slate-500">
              Monthly payment
              <input value={payment} onChange={(e) => setPayment(e.target.value)} onBlur={(e) => setPayment(normalizeAmount(e.target.value))} inputMode="decimal" className="tnum mt-1 rounded border border-slate-200 px-2 py-1.5 text-right text-sm" />
            </label>
          ) : (
            <label className="flex flex-col text-xs text-slate-500">
              Target date
              <input type="month" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} className="mt-1 rounded border border-slate-200 px-2 py-1.5 text-sm" />
            </label>
          )}
          <label className="flex flex-col text-xs text-slate-500">
            Extra monthly payment
            <input value={extra} onChange={(e) => setExtra(e.target.value)} onBlur={(e) => setExtra(normalizeAmount(e.target.value))} inputMode="decimal" className="tnum mt-1 rounded border border-slate-200 px-2 py-1.5 text-right text-sm" />
          </label>
        </div>

        {sim.doesNotAmortize && (
          <div className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-600">
            Payment is less than the first month's interest — the balance would never shrink.
          </div>
        )}
        {sim.rows.length > 0 && (
          <>
            <div className="mb-3 flex gap-3 text-sm">
              <div className="rounded-lg border border-slate-200 px-3 py-2">
                <div className="text-xs text-slate-400">{mode === 'byDate' ? 'Required payment' : 'Monthly payment'}</div>
                <div className="tnum font-semibold">{fmt(Math.round(effPayment * 1000), c)}</div>
                {mode === 'byDate' && targetMonths < 1 && (
                  <div className="text-[11px] text-amber-600">target date must be in the future</div>
                )}
              </div>
              <div className="rounded-lg border border-slate-200 px-3 py-2">
                <div className="text-xs text-slate-400">Payoff</div>
                <div className="tnum font-semibold">
                  {sim.payoffMonths > 0 ? `${Math.ceil(sim.payoffMonths / 12)}y ${sim.payoffMonths % 12}m (month ${sim.payoffMonths})` : '—'}
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 px-3 py-2">
                <div className="text-xs text-slate-400">Total interest</div>
                <div className="tnum font-semibold">{fmt(Math.round(sim.totalInterest * 1000), c)}</div>
              </div>
              <div className="rounded-lg border border-slate-200 px-3 py-2">
                <div className="text-xs text-slate-400">Final payment</div>
                <div className="tnum font-semibold">{fmt(Math.round(sim.finalPayment * 1000), c)}</div>
              </div>
            </div>

            <div className="mb-4 print:hidden">
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={balanceChart}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#282c3f" />
                  <XAxis dataKey="month" fontSize={11} />
                  <YAxis tickFormatter={(v) => fmt(v, { ...c, digits: 0 })} fontSize={11} width={80} />
                  <Tooltip formatter={(v) => fmt(Number(v), c)} />
                  <Line type="monotone" dataKey="balance" name="Remaining balance" stroke="#7aa2f7" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="max-h-80 overflow-y-auto rounded border border-slate-200">
              <table className="w-full text-[13px]">
                <thead className="sticky top-0 bg-panel text-left text-[11px] tracking-wide text-slate-400 uppercase">
                  <tr className="border-b border-slate-200">
                    <th className="px-3 py-1.5">Month</th>
                    <th className="px-3 py-1.5 text-right">Payment</th>
                    <th className="px-3 py-1.5 text-right">Interest</th>
                    <th className="px-3 py-1.5 text-right">Principal</th>
                    <th className="px-3 py-1.5 text-right">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((r) => (
                    <tr key={r.month} className="border-b border-slate-50">
                      <td className="px-3 py-1">{r.month}</td>
                      <td className="tnum px-3 py-1 text-right">{fmt(Math.round(r.payment * 1000), c)}</td>
                      <td className="tnum px-3 py-1 text-right text-slate-500">{fmt(Math.round(r.interest * 1000), c)}</td>
                      <td className="tnum px-3 py-1 text-right text-emerald-700">{fmt(Math.round(r.principal * 1000), c)}</td>
                      <td className="tnum px-3 py-1 text-right">{fmt(Math.round(r.balance * 1000), c)}</td>
                    </tr>
                  ))}
                  {!showFullTable && (
                    <tr>
                      <td colSpan={5} className="px-3 py-2 text-center text-xs text-slate-400">
                        … {sim.rows.length - 24} rows omitted …
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="mt-1 text-[11px] text-slate-400">
              Monthly model: TAN/12, month-end payments, interest rounded per row. Real statements may differ by a few
              cents.
            </div>
          </>
        )}
      </div>
    </div>
  )
}
