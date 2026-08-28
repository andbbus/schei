import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  LineChart,
  Line,
  Area,
  ComposedChart,
  ReferenceLine,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts'
import type { BudgetMeta } from '../api'
import { api } from '../api'
import { fmt, monthLabel, dateDisplay, type Currency } from '../format'
import { csvAmount, downloadFile, toCsv } from '../csv'
import TxnListModal, { type Drill } from './TxnListModal'
import DebtSavings from './DebtSavings'
import { buildBva, rowColor, type BvaRow } from '../lib/bva'

const TABS = ['Spending', 'Net Worth', 'Income v Expense', 'Age of Money', 'Budget vs Actual', 'Cash Flow', 'Debt & Savings', 'Anomalies'] as const
type Tab = (typeof TABS)[number]

const COLORS = ['#7aa2f7', '#9ece6a', '#ff9e64', '#bb9af7', '#f7768e', '#73daca', '#e0af68', '#f477c1', '#565f89']

const shortMonth = (m: string) => {
  const [y, mm] = m.split('-')
  return `${new Date(Date.UTC(+y, +mm - 1, 1)).toLocaleDateString('en-US', { month: 'short' })} '${y.slice(2)}`
}

export default function ReflectView() {
  const meta = useOutletContext<BudgetMeta>()
  const [tab, setTab] = useState<Tab>('Spending')
  const months = meta.months
  const mo = (i: number) => months[Math.min(Math.max(0, i), months.length - 1)]
  const last = mo(months.length - 1)
  const ytd = `${new Date().getFullYear()}-01-01`
  const curIdx = months.indexOf(meta.currentMonth)
  const cur = meta.currentMonth
  const presets: { label: string; from: string; to: string }[] = [
    { label: 'All time', from: mo(0), to: last },
    { label: 'This year', from: ytd < mo(0) ? mo(0) : ytd, to: cur },
    { label: '12 months', from: mo(curIdx - 11), to: cur },
    { label: '6 months', from: mo(curIdx - 5), to: cur },
    { label: '3 months', from: mo(curIdx - 2), to: cur },
    { label: 'This month', from: cur, to: cur },
    { label: 'Last month', from: mo(curIdx - 1), to: mo(curIdx - 1) },
  ]
  const [range, setRange] = useState<{ from: string; to: string }>({ from: mo(0), to: last })
  const [accountId, setAccountId] = useState('all')
  const [drill, setDrill] = useState<Drill | null>(null)
  const [month, setMonth] = useState(meta.currentMonth)
  const [horizon, setHorizon] = useState(6)
  const monthIdx = months.indexOf(month)
  const active = (p: { from: string; to: string }) => range.from === p.from && range.to === p.to
  const setFrom = (v: string) => {
    const from = `${v}-01`
    setRange((r) => ({ from, to: r.to < from ? from : r.to }))
  }
  const setTo = (v: string) => {
    const to = `${v}-01`
    setRange((r) => ({ from: r.from > to ? to : r.from, to }))
  }

  const c: Currency = {
    symbol: meta.budget.currencySymbol,
    digits: meta.budget.decimalDigits,
    locale: meta.budget.locale,
  }
  const tip = (v: number) => fmt(v, c)
  const axis = (v: number) => fmt(v, { ...c, digits: 0 })
  const rangeLabel =
    range.from === range.to ? shortMonth(range.from) : `${shortMonth(range.from)} – ${shortMonth(range.to)}`

  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="print-hide flex gap-1 border-b border-slate-200 px-5 py-3">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded px-3 py-1.5 text-sm font-medium ${
              tab === t ? 'bg-accent text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="print-hide flex flex-wrap items-center gap-1.5 border-b border-slate-200 px-5 py-2">
        {tab === 'Cash Flow' ? (
          <div className="flex items-center gap-1.5">
            {[3, 6, 12].map((n) => (
              <button
                key={n}
                onClick={() => setHorizon(n)}
                className={`rounded px-2.5 py-1 text-[12px] font-medium ${
                  horizon === n ? 'bg-accent text-white' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {n} months
              </button>
            ))}
          </div>
        ) : tab === 'Anomalies' ? (
          <span className="text-[12px] text-slate-400">Unusual charges vs each payee’s own history</span>
        ) : tab === 'Budget vs Actual' ? (
          <div className="flex items-center gap-1.5">
            <button
              disabled={monthIdx <= 0}
              onClick={() => setMonth(months[monthIdx - 1])}
              className="rounded border border-slate-200 px-2 py-1 text-[12px] text-slate-600 disabled:opacity-30"
            >
              ‹
            </button>
            <input
              type="month"
              value={month.slice(0, 7)}
              min={mo(0).slice(0, 7)}
              max={last.slice(0, 7)}
              onChange={(e) => e.target.value && setMonth(`${e.target.value}-01`)}
              className="rounded border border-slate-200 px-2 py-1 text-[12px] text-slate-600"
            />
            <button
              disabled={monthIdx >= months.length - 1}
              onClick={() => setMonth(months[monthIdx + 1])}
              className="rounded border border-slate-200 px-2 py-1 text-[12px] text-slate-600 disabled:opacity-30"
            >
              ›
            </button>
          </div>
        ) : (
          <>
            {presets.map((p) => (
              <button
                key={p.label}
                onClick={() => setRange({ from: p.from, to: p.to })}
                className={`rounded px-2.5 py-1 text-[12px] font-medium ${
                  active(p) ? 'bg-accent text-white' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {p.label}
              </button>
            ))}
            <div className="ml-2 flex items-center gap-1.5">
              <input
                type="month"
                value={range.from.slice(0, 7)}
                onChange={(e) => setFrom(e.target.value)}
                className="rounded border border-slate-200 px-2 py-1 text-[12px] text-slate-600"
              />
              <span className="text-slate-400">–</span>
              <input
                type="month"
                value={range.to.slice(0, 7)}
                onChange={(e) => setTo(e.target.value)}
                className="rounded border border-slate-200 px-2 py-1 text-[12px] text-slate-600"
              />
            </div>
          </>
        )}
        {tab === 'Spending' && (
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="ml-auto rounded border border-slate-200 px-2 py-1 text-[12px] text-slate-600"
          >
            <option value="all">All accounts</option>
            {meta.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="flex-1 overflow-auto p-6">
        {tab === 'Spending' && <Spending tip={tip} c={c} range={range} accountId={accountId} onOpenCategory={(catId, name) => setDrill({ categoryId: catId, categoryName: name, from: range.from, to: range.to, accountId: accountId === 'all' ? undefined : accountId, mode: 'spending' })} />}
        {tab === 'Net Worth' && <NetWorth tip={tip} axis={axis} c={c} range={range} />}
        {tab === 'Income v Expense' && <IncomeExpense tip={tip} axis={axis} c={c} range={range} />}
        {tab === 'Age of Money' && <Age range={range} c={c} />}
        {tab === 'Cash Flow' && <CashFlow horizon={horizon} c={c} tip={tip} />}
        {tab === 'Debt & Savings' && <DebtSavings meta={meta} range={range} c={c} />}
        {tab === 'Anomalies' && <Anomalies c={c} />}
        {tab === 'Budget vs Actual' && (
          <BudgetVsActual
            month={month}
            currentMonth={meta.currentMonth}
            c={c}
            tip={tip}
            onOpenCategory={(catId, name) =>
              setDrill({ categoryId: catId, categoryName: name, from: month, to: month, mode: 'activity' })
            }
          />
        )}
      </div>
      {drill && <TxnListModal drill={drill} c={c} accounts={meta.accounts} onClose={() => setDrill(null)} />}
      <div className="print-hide shrink-0 border-t border-slate-200 px-5 py-1.5 text-[11px] text-slate-400">
        {tab === 'Spending' && `Range: ${rangeLabel}`}
        {tab === 'Budget vs Actual' && `Showing ${monthLabel(month)} · activity through today`}
        {tab === 'Cash Flow' && `Projection: ${horizon} months`}
        {(tab === 'Net Worth' || tab === 'Income v Expense' || tab === 'Age of Money') && `Showing ${rangeLabel}`}
        {tab === 'Debt & Savings' && ''}
        {tab === 'Anomalies' && 'Most recent 90 days unless widened'}
      </div>
    </div>
  )
}

function Spending({
  tip,
  c,
  range,
  accountId,
  onOpenCategory,
}: {
  tip: (v: number) => string
  c: Currency
  range: { from: string; to: string }
  accountId: string
  onOpenCategory: (categoryId: string, name: string) => void
}) {
  const { data } = useQuery({
    queryKey: ['rep', 'spending', range.from, range.to, accountId],
    queryFn: () => api.reportSpending(range.from, range.to, accountId === 'all' ? undefined : accountId),
  })
  if (!data) return <Loading />
  const top = data.categories.slice(0, 9)
  const where = data.from === data.to ? shortMonth(data.from) : `${shortMonth(data.from)} – ${shortMonth(data.to)}`
  const open = (cat: { categoryId: string; name: string }) => onOpenCategory(cat.categoryId, cat.name)
  const exportCsv = () => {
    const rows: (string | number | null)[][] = [
      ['Category', 'Amount'],
      ...data.categories.map((cat) => [cat.name, csvAmount(cat.amount, c)]),
    ]
    downloadFile(`reflect spending ${data.from}–${data.to}.csv`, toCsv(rows, c.locale))
  }
  return (
    <div className="grid grid-cols-2 gap-8">
      <div className="min-w-0">
        <SectionTitle title="Spending by Category" onExport={exportCsv} />
        <div className="text-sm text-slate-500">
          Total spent: {tip(data.total)} · {where} <span className="text-slate-400">(click a slice for transactions)</span>
        </div>
        {/* fixed size: ResponsiveContainer can measure 0 inside a CSS-grid cell */}
        <div className="print:hidden">
          <PieChart width={380} height={360}>
            <Pie
              data={top}
              dataKey="amount"
              nameKey="name"
              innerRadius={70}
              outerRadius={130}
              paddingAngle={1}
              onClick={(entry) => open(entry as unknown as { categoryId: string; name: string })}
              className="cursor-pointer"
            >
              {top.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip formatter={(v) => tip(Number(v))} />
          </PieChart>
        </div>
        <table className="hidden print:block print:text-[10px]">
          <thead>
            <tr className="border-b border-black text-left">
              <th className="pr-2">Category</th>
              <th className="text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {data.categories.map((cat) => (
              <tr key={cat.categoryId} className="border-b border-slate-300">
                <td className="pr-2">{cat.name}</td>
                <td className="text-right">{fmt(cat.amount, c)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <h2 className="mb-2 font-semibold text-slate-700">Breakdown</h2>
        <div className="divide-y divide-slate-100">
          {data.categories.map((cat, i) => (
            <div
              key={cat.categoryId}
              onClick={() => open(cat)}
              className="flex cursor-pointer items-center justify-between py-1.5 text-sm hover:bg-slate-50"
              title="Show transactions"
            >
              <span className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
                {cat.name}
              </span>
              <span className="tnum text-slate-700">{fmt(cat.amount, c)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function NetWorth({
  tip,
  axis,
  c,
  range,
}: {
  tip: (v: number) => string
  axis: (v: number) => string
  c: Currency
  range: { from: string; to: string }
}) {
  const { data } = useQuery({
    queryKey: ['rep', 'networth', range.from, range.to],
    queryFn: () => api.reportNetWorth(range.from, range.to),
  })
  // projection: actual series + dashed continuation at the cash-flow pace
  const { data: fc } = useQuery({ queryKey: ['rep', 'networth-forecast', 12], queryFn: () => api.reportNetWorthForecast(12) })
  const chart = (() => {
    if (!data) return []
    const rows: { month: string; netWorth: number | null; projected: number | null }[] = data.map((m) => ({
      month: m.month,
      netWorth: m.netWorth,
      projected: null,
    }))
    if (fc && rows.length > 0) {
      // anchor the projection at the last actual month so the lines connect
      rows[rows.length - 1].projected = fc.lastNetWorth
      for (const f of fc.forecast) rows.push({ month: f.month, netWorth: null, projected: f.projected })
    }
    return rows
  })()
  if (!data) return <Loading />
  const exportCsv = () => {
    const rows: (string | number | null)[][] = [
      ['Month', 'Assets', 'Debts', 'NetWorth'],
      ...data.map((m) => [m.month, csvAmount(m.assets, c), csvAmount(m.debts, c), csvAmount(m.netWorth, c)]),
    ]
    downloadFile(`reflect net-worth ${range.from.slice(0, 7)}–${range.to.slice(0, 7)}.csv`, toCsv(rows, c.locale))
  }
  return (
    <>
      <SectionTitle title="Net Worth" onExport={exportCsv} />
      <div className="print:hidden">
        <ResponsiveContainer width="100%" height={420}>
          <ComposedChart data={chart}>
            <CartesianGrid strokeDasharray="3 3" stroke="#282c3f" />
            <XAxis dataKey="month" tickFormatter={shortMonth} fontSize={12} />
            <YAxis tickFormatter={axis} fontSize={12} width={80} />
            <Tooltip formatter={(v) => tip(Number(v))} labelFormatter={(m) => shortMonth(String(m))} />
            <Legend />
            <Area type="monotone" dataKey="netWorth" name="Net Worth" stroke="#7aa2f7" fill="rgba(122,162,247,0.18)" connectNulls />
            {fc && <Line type="monotone" dataKey="projected" name="Projected" stroke="#bb9af7" strokeDasharray="6 4" dot={false} connectNulls />}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <table className="hidden print:block print:text-[10px]">
        <thead>
          <tr className="border-b border-black text-left">
            <th className="pr-2">Month</th>
            <th className="pr-2 text-right">Assets</th>
            <th className="pr-2 text-right">Debts</th>
            <th className="text-right">Net Worth</th>
          </tr>
        </thead>
        <tbody>
          {data.map((m) => (
            <tr key={m.month} className="border-b border-slate-300">
              <td className="pr-2">{shortMonth(m.month)}</td>
              <td className="pr-2 text-right">{fmt(m.assets, c)}</td>
              <td className="pr-2 text-right">{fmt(m.debts, c)}</td>
              <td className="text-right">{fmt(m.netWorth, c)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

function IncomeExpense({
  tip,
  axis,
  c,
  range,
}: {
  tip: (v: number) => string
  axis: (v: number) => string
  c: Currency
  range: { from: string; to: string }
}) {
  const { data } = useQuery({
    queryKey: ['rep', 'ie', range.from, range.to],
    queryFn: () => api.reportIncomeExpense(range.from, range.to),
  })
  if (!data) return <Loading />
  const exportCsv = () => {
    const rows: (string | number | null)[][] = [
      ['Month', 'Income', 'Expense'],
      ...data.map((m) => [m.month, csvAmount(m.income, c), csvAmount(m.expense, c)]),
    ]
    downloadFile(`reflect income-expense ${range.from.slice(0, 7)}–${range.to.slice(0, 7)}.csv`, toCsv(rows, c.locale))
  }
  return (
    <>
      <SectionTitle title="Income vs Expense" onExport={exportCsv} />
      <div className="print:hidden">
        <ResponsiveContainer width="100%" height={420}>
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#282c3f" />
            <XAxis dataKey="month" tickFormatter={shortMonth} fontSize={12} />
            <YAxis tickFormatter={axis} fontSize={12} width={80} />
            <Tooltip formatter={(v) => tip(Number(v))} labelFormatter={(m) => shortMonth(String(m))} />
            <Legend />
            <Bar dataKey="income" name="Income" fill="#9ece6a" />
            <Bar dataKey="expense" name="Expense" fill="#f7768e" />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <table className="hidden print:block print:text-[10px]">
        <thead>
          <tr className="border-b border-black text-left">
            <th className="pr-2">Month</th>
            <th className="pr-2 text-right">Income</th>
            <th className="text-right">Expense</th>
          </tr>
        </thead>
        <tbody>
          {data.map((m) => (
            <tr key={m.month} className="border-b border-slate-300">
              <td className="pr-2">{shortMonth(m.month)}</td>
              <td className="pr-2 text-right">{fmt(m.income, c)}</td>
              <td className="text-right">{fmt(m.expense, c)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

function Age({ range, c }: { range: { from: string; to: string }; c: Currency }) {
  const { data } = useQuery({
    queryKey: ['rep', 'age', range.from, range.to],
    queryFn: () => api.reportAge(range.from, range.to),
  })
  if (!data) return <Loading />
  const exportCsv = () => {
    const rows: (string | number | null)[][] = [
      ['Month', 'Age'],
      ...data.map((m) => [m.month, m.age]),
    ]
    downloadFile(`reflect age-of-money ${range.from.slice(0, 7)}–${range.to.slice(0, 7)}.csv`, toCsv(rows, c.locale))
  }
  return (
    <>
      <SectionTitle title="Age of Money" onExport={exportCsv} />
      <div className="print:hidden">
        <ResponsiveContainer width="100%" height={420}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#282c3f" />
            <XAxis dataKey="month" tickFormatter={shortMonth} fontSize={12} />
            <YAxis fontSize={12} width={50} />
            <Tooltip formatter={(v) => `${Number(v)} days`} labelFormatter={(m) => shortMonth(String(m))} />
            <Line type="monotone" dataKey="age" name="Age of Money" stroke="#bb9af7" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <table className="hidden print:block print:text-[10px]">
        <thead>
          <tr className="border-b border-black text-left">
            <th className="pr-2">Month</th>
            <th className="text-right">Age (days)</th>
          </tr>
        </thead>
        <tbody>
          {data.map((m) => (
            <tr key={m.month} className="border-b border-slate-300">
              <td className="pr-2">{shortMonth(m.month)}</td>
              <td className="text-right">{m.age ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

function Anomalies({ c }: { c: Currency }) {
  const [days, setDays] = useState(90)
  const { data } = useQuery({ queryKey: ['rep', 'anomalies', days], queryFn: () => api.reportAnomalies(days) })
  const rows = data?.anomalies ?? []
  const exportCsv = () => {
    const out: (string | number | null)[][] = [
      ['Date', 'Payee', 'Category', 'Amount', 'Typical', 'Deviation', 'Direction'],
      ...rows.map((a) => [
        a.date,
        a.payeeName,
        a.categoryName,
        csvAmount(a.amount, c),
        csvAmount(-a.mean, c),
        csvAmount(-a.delta, c),
        a.direction,
      ]),
    ]
    downloadFile(`reflect anomalies ${days}d.csv`, toCsv(out, c.locale))
  }
  return (
    <>
      <SectionTitle title="Anomalies" onExport={exportCsv} />
      <div className="print-hide mb-3 flex items-center gap-1.5">
        {[30, 60, 90, 180, 365].map((n) => (
          <button
            key={n}
            onClick={() => setDays(n)}
            className={`rounded px-2.5 py-1 text-[12px] font-medium ${
              days === n ? 'bg-accent text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {n} days
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-panel p-6 text-center text-[13px] text-slate-400">
          Nothing unusual — every recent charge is in line with its payee’s history.
        </div>
      ) : (
        <div className="overflow-visible rounded-lg border border-slate-200 bg-panel">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-500">
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Payee</th>
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2 text-right">Typical</th>
                <th className="px-3 py-2 text-right">Deviation</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.txnId} className="border-b border-slate-200 last:border-0">
                  <td className="px-3 py-2 whitespace-nowrap text-slate-500">{dateDisplay(a.date)}</td>
                  <td className="px-3 py-2 font-medium text-slate-700">{a.payeeName || '—'}</td>
                  <td className="px-3 py-2 text-slate-500">{a.categoryName ?? '—'}</td>
                  <td className="tnum px-3 py-2 text-right font-semibold text-slate-800">{fmt(a.amount, c)}</td>
                  <td className="tnum px-3 py-2 text-right text-slate-500">{fmt(-a.mean, c)}</td>
                  <td className={`tnum px-3 py-2 text-right font-semibold ${a.direction === 'increase' ? 'text-red-500' : 'text-emerald-600'}`}>
                    {a.direction === 'increase' ? '+' : '−'}
                    {fmt(a.delta, { ...c, symbol: '' })}
                  </td>
                  <td className="px-3 py-2 text-right text-[11px] text-slate-400">
                    {a.direction === 'increase' ? '▲ spike' : '▼ drop'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-3 text-[11px] text-slate-400">
        Flags charges deviating sharply (z ≥ 3, min €0.50) from the same payee’s past outflows — spikes and unusual drops.
      </div>
    </>
  )
}

function SectionTitle({ title, onExport }: { title: string; onExport: () => void }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h2 className="font-semibold text-slate-700">{title}</h2>
      <button
        onClick={onExport}
        className="print-hide rounded border border-slate-200 px-2 py-1 text-[12px] text-slate-600 hover:bg-slate-50"
      >
        Export CSV
      </button>
    </div>
  )
}

const UTIL_COLOR: Record<string, string> = {
  red: 'text-red-600',
  amber: 'text-amber-600',
  amberLight: 'text-amber-700',
  green: 'text-emerald-600',
}

function BudgetVsActual({
  month,
  currentMonth,
  c,
  tip,
  onOpenCategory,
}: {
  month: string
  currentMonth: string
  c: Currency
  tip: (v: number) => string
  onOpenCategory: (categoryId: string, name: string) => void
}) {
  const { data, isError, error } = useQuery({ queryKey: ['month', month], queryFn: () => api.month(month) })
  if (!data) return isError ? <div className="text-sm text-red-600">{String(error)}</div> : <Loading />
  const { regular, payments, totals } = buildBva(data.groups)
  const isFuture = month > currentMonth
  const allRows = regular.flatMap((s) => s.rows).filter((r) => r.spent > 0 || r.assigned !== 0)
  const axisFmt = (v: number) => fmt(v, { ...c, digits: 0 })
  const chartData = allRows
    .sort((a, b) => b.spent - a.spent)
    .slice(0, 12)
    .map((r) => ({ name: r.name, assigned: r.assigned, spent: r.spent }))
  const exportCsv = () => {
    const rows: (string | number | null)[][] = [
      ['Group', 'Category', 'Assigned', 'Activity', 'Available', 'Hidden'],
      ...regular.flatMap((s) =>
        s.rows.map((r) => [s.groupName, `${r.name}${r.hidden ? ' (hidden)' : ''}`, csvAmount(r.assigned, c), csvAmount(r.activity, c), csvAmount(r.available, c), r.hidden ? 'yes' : '']),
      ),
    ]
    downloadFile(`reflect budget-vs-actual ${month.slice(0, 7)}.csv`, toCsv(rows, c.locale))
  }
  const cell = 'px-2 py-1 text-right tnum'
  const head = 'px-2 py-1 text-[11px] font-semibold tracking-wide text-slate-400 uppercase'
  return (
    <div className="max-w-4xl">
      <SectionTitle title={`Budget vs Actual — ${monthLabel(month)}`} onExport={exportCsv} />
      <div className="text-xs text-slate-400">
        Activity is net (refunds net against spending). Click a row for its transactions.
      </div>

      <table className="mt-3 w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-slate-200 text-left">
            <th className="px-2 py-1">Category</th>
            <th className={head}>Assigned</th>
            <th className={head}>Activity (net)</th>
            <th className={head}>Available</th>
            <th className={head}>Utilization</th>
          </tr>
        </thead>
        <tbody>
          {regular.map((s) => (
            <FragmentRow key={s.groupId}>
              <tr className="border-b border-slate-200 bg-slate-100 text-[13px] font-semibold text-slate-700">
                <td className={`px-2 py-1 ${s.groupHidden ? 'text-slate-400 italic' : ''}`}>{s.groupName}</td>
                <td className={`${cell} font-semibold`}>{fmt(s.rows.reduce((a, r) => a + r.assigned, 0), c)}</td>
                <td className={`${cell} font-semibold`}>{fmt(s.rows.reduce((a, r) => a + r.activity, 0), c)}</td>
                <td className={`${cell} font-semibold`}>{fmt(s.rows.reduce((a, r) => a + r.available, 0), c)}</td>
                <td />
              </tr>
              {s.rows.map((r) => (
                <BvaRowRow key={r.categoryId} r={r} c={c} isFuture={isFuture} onOpen={onOpenCategory} />
              ))}
            </FragmentRow>
          ))}
          <tr className="border-b border-slate-200 font-semibold">
            <td className="px-2 py-1">Total</td>
            <td className={cell}>{fmt(totals.assigned, c)}</td>
            <td className={cell}>{fmt(totals.activity, c)}</td>
            <td className={cell}>{fmt(totals.available, c)}</td>
            <td />
          </tr>
        </tbody>
      </table>

      {payments.length > 0 && (
        <div className="mt-6">
          <div className="text-[13px] font-semibold text-slate-700">
            Credit Card Payments <span className="font-normal text-slate-400">(derived — activity is internal reallocation)</span>
          </div>
          <table className="mt-1 w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-slate-200 text-left">
                <th className="px-2 py-1">Category</th>
                <th className={head}>Assigned</th>
                <th className={head}>Payments</th>
                <th className={head}>Available</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {payments.map((r) => (
                <tr key={r.categoryId} className="border-b border-slate-100">
                  <td className={`px-2 py-1 ${r.hidden ? 'text-slate-400 italic' : ''}`}>{r.name}</td>
                  <td className={cell}>{fmt(r.assigned, c)}</td>
                  <td className={cell}>{fmt(r.activity, c)}</td>
                  <td className={cell}>{fmt(r.available, c)}</td>
                  <td />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!isFuture && chartData.length > 0 && (
        <div className="mt-8">
          <h3 className="mb-2 font-semibold text-slate-700">Assigned vs spent (top 12)</h3>
          <div className="print:hidden">
            <ResponsiveContainer width="100%" height={360}>
              <BarChart data={chartData} layout="vertical" margin={{ left: 40, right: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#282c3f" />
                <XAxis type="number" tickFormatter={axisFmt} fontSize={12} />
                <YAxis type="category" dataKey="name" width={150} fontSize={11} />
                <Tooltip formatter={(v) => tip(Number(v))} />
                <Legend />
                <Bar dataKey="assigned" name="Assigned" fill="#94a3b8" />
                <Bar dataKey="spent" name="Spent" fill="#7aa2f7" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="text-xs text-slate-400">Categories with no activity this month are omitted.</div>
        </div>
      )}
      {isFuture && (
        <div className="mt-4 rounded bg-slate-50 px-3 py-2 text-xs text-slate-500">
          Future month — activity hasn't happened yet; Available shows carried funds.
        </div>
      )}
    </div>
  )
}

function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

function CashFlow({ horizon, c, tip }: { horizon: number; c: Currency; tip: (v: number) => string }) {
  const { data, isError, error } = useQuery({
    queryKey: ['rep', 'cashflow', horizon],
    queryFn: () => api.reportCashflow(horizon),
  })
  if (!data) return isError ? <div className="text-sm text-red-600">{String(error)}</div> : <Loading />
  const rows = data.rows
  const fullRows = rows.filter((r) => !r.partial)
  const chartData = fullRows.map((r) => ({
    month: r.month,
    income: r.projectedIncome,
    spending: r.projectedSpending,
    rta: r.projectedRTA !== null ? r.projectedRTA : null,
  }))
  const fmtSigned = (v: number) => (v < 0 ? `-${fmt(-v, c)}` : fmt(v, c))
  const cell = 'px-2 py-1 text-right tnum'
  const head = 'px-2 py-1 text-[11px] font-semibold tracking-wide text-slate-400 uppercase'
  return (
    <div className="max-w-4xl">
      <SectionTitle
        title="Cash Flow"
        onExport={() => {
          const rowsCsv: (string | number | null)[][] = [
            ['Month', 'KnownScheduledNet', 'KnownIncome', 'ProjectedSpending', 'ProjectedNet', 'ProjectedRTA'],
            ...rows.map((r) => [
              r.month,
              csvAmount(r.knownScheduledNet, c),
              csvAmount(r.projectedIncome, c),
              csvAmount(r.projectedSpending, c),
              csvAmount(r.projectedNet, c),
              r.projectedRTA !== null ? csvAmount(r.projectedRTA, c) : '',
            ]),
          ]
          downloadFile(`reflect cash-flow ${horizon}m.csv`, toCsv(rowsCsv, c.locale))
        }}
      />
      {!data.sufficient && (
        <div className="mb-3 rounded bg-amber-50 px-3 py-2 text-sm text-amber-700">
          Not enough completed months of history for a reliable projection (need at least 2).
        </div>
      )}
      <div className="text-xs text-slate-400">
        Income is <b>known only</b>: scheduled and upcoming inflows land in their month; nothing is averaged or
        guessed. Spending is projected from actual <b>Activity</b> (trailing averages over {data.historyMonths} completed
        months, adjusted for the same calendar month a year ago when the history supports it), not from what you
        assign. Add any irregular income (e.g. a yearly grant) as a scheduled inflow so it lands in the right
        month. Projected RTA = last month's RTA + known income − projected activity.
      </div>

      <table className="mt-3 w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-slate-200 text-left">
            <th className="px-2 py-1">Month</th>
            <th className={head}>Known scheduled net</th>
            <th className={head}>Known income</th>
            <th className={head}>Projected spending</th>
            <th className={head}>Projected net</th>
            <th className={head}>Projected RTA</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.month} className={`border-b border-slate-100 ${r.partial ? 'bg-slate-50 text-slate-500' : ''}`}>
              <td className="px-2 py-1">
                {shortMonth(r.month)}
                {r.partial && <span className="ml-1 text-[10px] text-slate-400">(rest of month)</span>}
                {!r.partial && r.overridesUsed > 0 && (
                  <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-700" title="Projected expenses include manual overrides">
                    ✎{r.overridesUsed}
                  </span>
                )}
              </td>
              <td className={cell}>{fmtSigned(r.knownScheduledNet)}</td>
              <td className={`${cell} text-emerald-700`}>{r.partial ? '' : fmt(r.projectedIncome, c)}</td>
              <td className={`${cell} text-red-600`}>{r.partial ? '' : fmt(r.projectedSpending, c)}</td>
              <td className={`${cell} ${r.projectedNet < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{fmtSigned(r.projectedNet)}</td>
              <td className={`${cell} font-semibold ${r.projectedRTA !== null && r.projectedRTA < 0 ? 'text-red-600' : ''}`}>
                {r.partial ? `${fmt(data.anchorRta, c)} (anchor)` : r.projectedRTA !== null ? fmt(r.projectedRTA, c) : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {data.sufficient && chartData.length > 0 && (
        <div className="mt-8 print:hidden">
          <h3 className="mb-2 font-semibold text-slate-700">Projection</h3>
          <ResponsiveContainer width="100%" height={360}>
            <ComposedChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#282c3f" />
              <XAxis dataKey="month" tickFormatter={shortMonth} fontSize={12} />
              <YAxis tickFormatter={(v) => fmt(v, { ...c, digits: 0 })} fontSize={12} width={80} />
              <Tooltip formatter={(v) => tip(Number(v))} labelFormatter={(m) => shortMonth(String(m))} />
              <Legend />
              <ReferenceLine
                y={data.anchorRta}
                stroke="#94a3b8"
                strokeDasharray="4 4"
                label={{ value: 'anchor RTA', fontSize: 10, fill: '#94a3b8' }}
              />
              <ReferenceLine y={0} stroke="#e2e8f0" />
              <Bar dataKey="income" name="Known income" fill="#9ece6a" />
              <Bar dataKey="spending" name="Projected spending" fill="#f7768e" />
              <Line type="monotone" dataKey="rta" name="Projected RTA" stroke="#7aa2f7" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {rows.some((r) => r.schedules.length > 0) && (
        <div className="mt-8">
          <h3 className="mb-2 font-semibold text-slate-700">Known schedules</h3>
          {rows
            .filter((r) => r.schedules.length > 0)
            .map((r) => (
              <details key={r.month} className="mb-1 rounded border border-slate-200 px-3 py-1.5 text-sm">
                <summary className="cursor-pointer text-slate-700">
                  {shortMonth(r.month)} — {r.schedules.length} item(s)
                </summary>
                <ul className="mt-1 divide-y divide-slate-50">
                  {r.schedules.map((s, i) => (
                    <li key={i} className="flex items-center justify-between py-1 text-[13px]">
                      <span className="text-slate-600">
                        {s.payee || '(no payee)'} · {dateDisplay(s.date)}
                        {s.source === 'upcoming' && <span className="ml-1 text-[10px] text-slate-400">upcoming</span>}
                      </span>
                      <span className={`tnum ${s.amount < 0 ? 'text-slate-700' : 'text-emerald-700'}`}>{fmtSigned(s.amount)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
        </div>
      )}
    </div>
  )
}

function BvaRowRow({
  r,
  c,
  isFuture,
  onOpen,
}: {
  r: BvaRow
  c: Currency
  isFuture: boolean
  onOpen: (categoryId: string, name: string) => void
}) {
  const color = UTIL_COLOR[rowColor(r)]
  return (
    <tr
      onClick={() => onOpen(r.categoryId, r.name)}
      className="cursor-pointer border-b border-slate-50 hover:bg-blue-50"
      title={r.available < 0 ? 'Available negative — carried from a prior month' : 'Show transactions'}
    >
      <td className={`px-2 py-1 ${r.hidden ? 'text-slate-400 italic' : 'text-slate-800'}`}>
        {r.name}
        {r.hidden ? ' (hidden)' : ''}
      </td>
      <td className="px-2 py-1 text-right tnum">{fmt(r.assigned, c)}</td>
      <td className={`px-2 py-1 text-right tnum ${r.activity < 0 ? 'text-slate-600' : 'text-emerald-700'}`}>
        {fmt(r.activity, c)}
        {r.refunded !== 0 && (
          <span className="ml-1 text-[10px] text-slate-400" title={`${fmt(r.refunded, c)} refunded`}>
            {fmt(r.refunded, c)} back
          </span>
        )}
      </td>
      <td className={`px-2 py-1 text-right tnum ${isFuture ? 'text-slate-300' : r.available < 0 ? 'text-red-600' : 'text-slate-700'}`}>
        {fmt(r.available, c)}
      </td>
      <td className={`px-2 py-1 text-right text-[12px] ${color}`}>
        {r.utilization === null ? '—' : r.utilization > 1 ? '>100%' : `${Math.round(r.utilization * 100)}%`}
      </td>
    </tr>
  )
}

const Loading = () => <div className="text-slate-400">Loading…</div>
