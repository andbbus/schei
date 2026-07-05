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
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts'
import type { BudgetMeta } from '../api'
import { api } from '../api'
import { fmt, type Currency } from '../format'

const TABS = ['Spending', 'Net Worth', 'Income v Expense', 'Age of Money'] as const
type Tab = (typeof TABS)[number]

const COLORS = ['#3b82f6', '#22c55e', '#f97316', '#a855f7', '#ef4444', '#14b8a6', '#eab308', '#ec4899', '#64748b']

const shortMonth = (m: string) => {
  const [y, mm] = m.split('-')
  return `${new Date(Date.UTC(+y, +mm - 1, 1)).toLocaleDateString('en-US', { month: 'short' })} '${y.slice(2)}`
}

export default function ReflectView() {
  const meta = useOutletContext<BudgetMeta>()
  const [tab, setTab] = useState<Tab>('Spending')
  const c: Currency = {
    symbol: meta.budget.currencySymbol,
    digits: meta.budget.decimalDigits,
    locale: meta.budget.locale,
  }
  const tip = (v: number) => fmt(v, c)
  const axis = (v: number) => fmt(v, { ...c, digits: 0 })

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex gap-1 border-b border-slate-200 px-5 py-3">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded px-3 py-1.5 text-sm font-medium ${
              tab === t ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto p-6">
        {tab === 'Spending' && <Spending meta={meta} tip={tip} c={c} />}
        {tab === 'Net Worth' && <NetWorth tip={tip} axis={axis} />}
        {tab === 'Income v Expense' && <IncomeExpense tip={tip} axis={axis} />}
        {tab === 'Age of Money' && <Age />}
      </div>
    </div>
  )
}

function Spending({ meta, tip, c }: { meta: BudgetMeta; tip: (v: number) => string; c: Currency }) {
  const { data } = useQuery({
    queryKey: ['rep', 'spending'],
    queryFn: () => api.reportSpending(meta.budget.firstMonth, meta.budget.lastMonth),
  })
  if (!data) return <Loading />
  const top = data.categories.slice(0, 9)
  return (
    <div className="grid grid-cols-2 gap-8">
      <div className="min-w-0">
        <h2 className="mb-2 font-semibold text-slate-700">Spending by Category</h2>
        <div className="text-sm text-slate-500">Total spent: {tip(data.total)}</div>
        {/* fixed size: ResponsiveContainer can measure 0 inside a CSS-grid cell */}
        <PieChart width={380} height={360}>
          <Pie data={top} dataKey="amount" nameKey="name" innerRadius={70} outerRadius={130} paddingAngle={1}>
            {top.map((_, i) => (
              <Cell key={i} fill={COLORS[i % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip formatter={(v) => tip(Number(v))} />
        </PieChart>
      </div>
      <div>
        <h2 className="mb-2 font-semibold text-slate-700">Breakdown</h2>
        <div className="divide-y divide-slate-100">
          {data.categories.map((cat, i) => (
            <div key={cat.categoryId} className="flex items-center justify-between py-1.5 text-sm">
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

function NetWorth({ tip, axis }: { tip: (v: number) => string; axis: (v: number) => string }) {
  const { data } = useQuery({ queryKey: ['rep', 'networth'], queryFn: api.reportNetWorth })
  if (!data) return <Loading />
  return (
    <>
      <h2 className="mb-2 font-semibold text-slate-700">Net Worth</h2>
      <ResponsiveContainer width="100%" height={420}>
        <AreaChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
          <XAxis dataKey="month" tickFormatter={shortMonth} fontSize={12} />
          <YAxis tickFormatter={axis} fontSize={12} width={80} />
          <Tooltip formatter={(v) => tip(Number(v))} labelFormatter={(m) => shortMonth(String(m))} />
          <Legend />
          <Area type="monotone" dataKey="netWorth" name="Net Worth" stroke="#3b82f6" fill="#bfdbfe" />
        </AreaChart>
      </ResponsiveContainer>
    </>
  )
}

function IncomeExpense({ tip, axis }: { tip: (v: number) => string; axis: (v: number) => string }) {
  const { data } = useQuery({ queryKey: ['rep', 'ie'], queryFn: api.reportIncomeExpense })
  if (!data) return <Loading />
  return (
    <>
      <h2 className="mb-2 font-semibold text-slate-700">Income vs Expense</h2>
      <ResponsiveContainer width="100%" height={420}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
          <XAxis dataKey="month" tickFormatter={shortMonth} fontSize={12} />
          <YAxis tickFormatter={axis} fontSize={12} width={80} />
          <Tooltip formatter={(v) => tip(Number(v))} labelFormatter={(m) => shortMonth(String(m))} />
          <Legend />
          <Bar dataKey="income" name="Income" fill="#22c55e" />
          <Bar dataKey="expense" name="Expense" fill="#ef4444" />
        </BarChart>
      </ResponsiveContainer>
    </>
  )
}

function Age() {
  const { data } = useQuery({ queryKey: ['rep', 'age'], queryFn: api.reportAge })
  if (!data) return <Loading />
  return (
    <>
      <h2 className="mb-2 font-semibold text-slate-700">Age of Money</h2>
      <ResponsiveContainer width="100%" height={420}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
          <XAxis dataKey="month" tickFormatter={shortMonth} fontSize={12} />
          <YAxis fontSize={12} width={50} />
          <Tooltip formatter={(v) => `${Number(v)} days`} labelFormatter={(m) => shortMonth(String(m))} />
          <Line type="monotone" dataKey="age" name="Age of Money" stroke="#a855f7" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </>
  )
}

const Loading = () => <div className="text-slate-400">Loading…</div>
