import { useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts'
import type { BudgetMeta } from '../api'
import { api, errMsg } from '../api'
import { fmt, parseAmount, normalizeAmount, parsePercent, shortMonth, type Currency } from '../format'
import { amortize, balanceAtMonth, requiredPayment } from '../payoff'

type Plan = {
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
}

const monthsBetween = (from: string, to: string) => {
  const [y1, m1] = from.split('-').map(Number)
  const [y2, m2] = to.split('-').map(Number)
  return Math.max(1, (y2 - y1) * 12 + (m2 - m1))
}

export default function DebtsView() {
  const meta = useOutletContext<BudgetMeta>()
  const c: Currency = {
    symbol: meta.budget.currencySymbol,
    digits: meta.budget.decimalDigits,
    locale: meta.budget.locale,
  }
  const qc = useQueryClient()
  const { data: plans } = useQuery({ queryKey: ['debt-plans'], queryFn: api.debtPlans })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editing, setEditing] = useState<Plan | 'new' | null>(null)
  const selected = plans?.find((p) => p.id === selectedId) ?? plans?.[0] ?? null
  const activeId = selected?.id ?? null

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['debt-plans'] })
    qc.invalidateQueries({ queryKey: ['txns'] })
    qc.invalidateQueries({ queryKey: ['budget'] })
  }
  const del = useMutation({
    mutationFn: (id: string) => api.deleteDebtPlan(id),
    onSuccess: () => {
      refresh()
      setSelectedId(null)
    },
    onError: (e: Error) => alert(errMsg(e)),
  })

  const tracking = meta.accounts.filter((a) => !a.onBudget && !a.closed)
  const onBudget = meta.accounts.filter((a) => a.onBudget && !a.closed)

  return (
    <div className="flex h-full bg-panel">
      <div className="flex w-80 shrink-0 flex-col border-r border-slate-200">
        <div className="flex items-center justify-between px-4 py-3">
          <h1 className="text-lg font-semibold text-slate-800">Debts</h1>
          <button
            onClick={() => setEditing('new')}
            className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover"
          >
            + New plan
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-4">
          {plans?.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-slate-400">No plans yet.</div>
          )}
          {plans?.map((p) => {
            const active = p.id === activeId
            return (
              <button
                key={p.id}
                onClick={() => setSelectedId(p.id)}
                className={`mb-1.5 block w-full rounded-lg border p-3 text-left ${
                  active ? 'border-blue-400 bg-blue-50' : 'border-slate-200 hover:bg-slate-50'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className={`truncate text-sm font-semibold ${p.active ? 'text-slate-800' : 'text-slate-400'}`}>
                    {p.name}
                  </span>
                  {p.hasPaymentSchedule && (
                    <span className="ml-1 shrink-0 rounded bg-emerald-100 px-1.5 text-[10px] text-emerald-700">
                      schedule
                    </span>
                  )}
                </div>
                <div className="mt-1 flex items-baseline justify-between">
                  <span className={`tnum text-lg font-semibold ${p.effectiveBalance < 0 ? 'text-red-600' : 'text-slate-700'}`}>
                    {fmt(p.effectiveBalance, c)}
                  </span>
                  <span className="text-[11px] text-slate-400">{(p.tanBps / 100).toFixed(1)}%</span>
                </div>
                <div className="mt-0.5 text-[11px] text-slate-400">
                  {p.payment > 0
                    ? `${fmt(p.payment, c)}/month`
                    : p.targetMonth
                      ? `pay off by ${shortMonth(p.targetMonth)}`
                      : 'no payment set'}
                  {p.accountName ? ` · ${p.accountName}` : ''}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {!selected && <div className="p-6 text-slate-400">Select or create a plan.</div>}
        {selected && (
          <PlanDetail
            key={selected.id}
            plan={selected}
            c={c}
            tracking={tracking}
            onBudget={onBudget}
            onEdit={() => setEditing(selected)}
            onDelete={() => {
              if (window.confirm(`Delete plan "${selected.name}"? Existing scheduled payments stay.`)) del.mutate(selected.id)
            }}
            onChanged={refresh}
          />
        )}
      </div>

      {editing && (
        <PlanEditor
          plan={editing === 'new' ? null : editing}
          tracking={tracking}
          c={c}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            refresh()
            setEditing(null)
            if (id) setSelectedId(id)
          }}
        />
      )}
    </div>
  )
}

function PlanDetail({
  plan,
  c,
  tracking,
  onBudget,
  onEdit,
  onDelete,
  onChanged,
}: {
  plan: Plan
  c: Currency
  tracking: { id: string; name: string; working: number }[]
  onBudget: { id: string; name: string }[]
  onEdit: () => void
  onDelete: () => void
  onChanged: () => void
}) {
  const [sourceId, setSourceId] = useState('')
  const [freq, setFreq] = useState<'monthly' | 'once'>('monthly')
  const [amount, setAmount] = useState('')
  const [lookupMonth, setLookupMonth] = useState(1)

  const bal = plan.effectiveBalance / 1000
  const tanPct = (plan.tanBps / 10000) * 100
  const targetMonths = plan.targetMonth ? monthsBetween(plan.startMonth, plan.targetMonth) : null
  const payment =
    plan.payment > 0 ? plan.payment / 1000 : targetMonths ? requiredPayment(bal, tanPct, targetMonths) : 0
  const sim = useMemo(
    () => amortize({ balance: bal, tanPercent: tanPct, payment, extra: plan.extraPayment / 1000 }),
    [bal, tanPct, payment, plan.extraPayment],
  )
  const chartData = sim.rows.map((r) => ({ month: r.month, balance: r.balance * 1000 }))
  const residual = balanceAtMonth(sim.rows, lookupMonth)
  const showFullTable = sim.rows.length <= 120
  const tableRows = showFullTable ? sim.rows : [...sim.rows.slice(0, 12), ...sim.rows.slice(-12)]

  const createSchedule = useMutation({
    mutationFn: () =>
      api.createPaymentSchedule(plan.id, {
        accountId: sourceId,
        amount: Math.round((parseAmount(amount) || plan.payment || payment * 1000) / 1000) * 1000,
        frequency: freq,
      }),
    onSuccess: onChanged,
    onError: (e: Error) => alert(errMsg(e)),
  })

  const stat = (label: string, value: string, tone = 'text-slate-800') => (
    <div className="rounded-lg border border-slate-200 px-3 py-2">
      <div className="text-xs text-slate-400">{label}</div>
      <div className={`tnum text-lg font-semibold ${tone}`}>{value}</div>
    </div>
  )

  return (
    <div className="max-w-4xl">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-800">{plan.name}</h2>
          <div className="mt-0.5 text-sm text-slate-500">
            {plan.accountName ? `Balance synced from ${plan.accountName}` : 'Manual balance'}
            {plan.active ? '' : ' · inactive'}
            {plan.note ? ` · ${plan.note}` : ''}
          </div>
        </div>
        <div className="flex gap-1.5">
          <button onClick={onEdit} className="rounded border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
            Edit
          </button>
          <button onClick={onDelete} className="rounded border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50">
            Delete
          </button>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {stat('Balance', fmt(plan.effectiveBalance, c), plan.effectiveBalance < 0 ? 'text-red-600' : 'text-slate-800')}
        {stat('Rate (TAN)', `${tanPct.toFixed(1)}%`)}
        {stat(
          'Payment',
          plan.payment > 0 ? fmt(plan.payment, c) : `${fmt(Math.round(payment * 1000), c)} required`,
        )}
        {sim.doesNotAmortize
          ? stat('Payoff', 'never', 'text-red-600')
          : stat('Payoff', sim.payoffMonths > 0 ? `${shortMonth(addMonthsLabel(plan.startMonth, sim.payoffMonths))} (${sim.payoffMonths}m)` : '—')}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2 text-sm">
          <label className="text-xs text-slate-500">Balance at month</label>
          <input
            type="number"
            min={0}
            value={lookupMonth}
            onChange={(e) => setLookupMonth(Number(e.target.value))}
            className="tnum w-20 rounded border border-slate-200 px-2 py-1 text-right text-sm"
          />
          <span className="tnum font-semibold text-slate-700">
            {residual === null ? '—' : fmt(Math.round(residual * 1000), c)}
          </span>
        </div>
        <div className="text-xs text-slate-400">
          Total interest {fmt(Math.round(sim.totalInterest * 1000), c)} · final payment{' '}
          {fmt(Math.round(sim.finalPayment * 1000), c)}
        </div>
      </div>

      {!plan.hasPaymentSchedule && onBudget.length > 0 && (
        <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-3">
          <div className="mb-2 text-sm font-semibold text-slate-700">Schedule the payment</div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col text-[11px] text-slate-500">
              From account
              <select value={sourceId} onChange={(e) => setSourceId(e.target.value)} className="mt-0.5 rounded border border-slate-300 px-1 py-1 text-sm">
                <option value="">Choose…</option>
                {onBudget.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col text-[11px] text-slate-500">
              Frequency
              <select value={freq} onChange={(e) => setFreq(e.target.value as 'monthly' | 'once')} className="mt-0.5 rounded border border-slate-300 px-1 py-1 text-sm">
                <option value="monthly">Monthly</option>
                <option value="once">Once (lump sum)</option>
              </select>
            </label>
            <label className="flex flex-col text-[11px] text-slate-500">
              Amount
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                onBlur={(e) => setAmount(normalizeAmount(e.target.value))}
                placeholder={(plan.payment / 1000).toString() || (payment > 0 ? payment.toFixed(2) : '')}
                inputMode="decimal"
                className="tnum mt-0.5 w-28 rounded border border-slate-300 px-1 py-1 text-right text-sm"
              />
            </label>
            <button
              disabled={!sourceId || createSchedule.isPending}
              onClick={() => createSchedule.mutate()}
              className="rounded bg-positive px-3 py-1 text-sm text-white disabled:opacity-40"
            >
              Create schedule
            </button>
            <span className="text-[11px] text-slate-400">
              Appears in the register and the Cash Flow projection.
            </span>
          </div>
        </div>
      )}
      {plan.hasPaymentSchedule && (
        <div className="mb-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Payment schedule created — it shows in the register and the Cash Flow projection.
        </div>
      )}

      {!sim.doesNotAmortize && chartData.length > 0 && (
        <div className="mb-4 print:hidden">
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#282c3f" />
              <XAxis dataKey="month" fontSize={11} />
              <YAxis tickFormatter={(v) => fmt(v, { ...c, digits: 0 })} fontSize={11} width={70} />
              <Tooltip formatter={(v) => fmt(Number(v), c)} />
              <Line type="monotone" dataKey="balance" name="Balance" stroke="#7aa2f7" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      {sim.doesNotAmortize && (
        <div className="mb-4 rounded bg-red-50 px-3 py-2 text-sm text-red-600">
          Payment is less than the first month's interest — the balance would never shrink.
        </div>
      )}

      {sim.rows.length > 0 && (
        <div className="max-h-96 overflow-y-auto rounded border border-slate-200">
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
                  <td className="px-3 py-1">{shortMonth(addMonthsLabel(plan.startMonth, r.month - 1))}</td>
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
      )}
      {tracking.length === 0 && (
        <div className="mt-2 text-xs text-slate-400">No tracking accounts — balances are manual.</div>
      )}
    </div>
  )
}

function addMonthsLabel(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + n, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
}

function PlanEditor({
  plan,
  tracking,
  c,
  onClose,
  onSaved,
}: {
  plan: Plan | null
  tracking: { id: string; name: string; working: number }[]
  c: Currency
  onClose: () => void
  onSaved: (id: string | null) => void
}) {
  const [name, setName] = useState(plan?.name ?? '')
  const [accountId, setAccountId] = useState(plan?.accountId ?? '')
  const [balance, setBalance] = useState(plan ? (plan.effectiveBalance / 1000).toString() : '')
  const [tan, setTan] = useState(plan ? ((plan.tanBps / 10000) * 100).toString() : '3')
  const [mode, setMode] = useState<'payment' | 'byDate'>(!plan || (plan.payment ?? 0) > 0 ? 'payment' : 'byDate')
  const [payment, setPayment] = useState(plan && plan.payment > 0 ? (plan.payment / 1000).toString() : '')
  const [targetMonth, setTargetMonth] = useState(plan?.targetMonth?.slice(0, 7) ?? '')
  const [extra, setExtra] = useState(plan ? (plan.extraPayment / 1000).toString() : '')
  const [startMonth, setStartMonth] = useState(plan?.startMonth?.slice(0, 7) ?? new Date().toISOString().slice(0, 7))
  const [note, setNote] = useState(plan?.note ?? '')
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        name: name.trim(),
        tanBps: Math.round(parsePercent(tan) * 10000),
        payment: Math.round(parseAmount(payment)),
        extraPayment: Math.round(parseAmount(extra)),
        startMonth: `${startMonth}-01`,
        targetMonth: mode === 'byDate' ? `${targetMonth}-01` : null,
        note: note.trim() || null,
        accountId: accountId || null,
      }
      if (!accountId) body.balance = Math.round(parseAmount(balance))
      return plan ? api.updateDebtPlan(plan.id, body) : api.createDebtPlan(body)
    },
    onSuccess: (r: unknown) => {
      const createdId = (r as { id?: string } | null)?.id ?? null
      onSaved(plan ? plan.id : createdId)
    },
    onError: (e: Error) => setError(errMsg(e)),
  })

  const input = 'mt-1 rounded border border-slate-200 px-2 py-1.5 text-sm'
  const label = 'flex flex-col text-xs text-slate-500'
  const manual = !accountId
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative z-10 flex max-h-[85vh] w-[520px] flex-col rounded-xl bg-panel p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-slate-800">{plan ? 'Edit plan' : 'New plan'}</h2>
          <button onClick={onClose} className="rounded px-2 py-1 text-slate-400 hover:bg-slate-100">
            ✕
          </button>
        </div>
        {error && <div className="mb-2 rounded bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>}
        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-2 gap-3">
            <label className={`${label} col-span-2`}>
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} className={input} placeholder="e.g. Car loan" />
            </label>
            <label className={`${label} col-span-2`}>
              Linked tracking account (balance syncs) — optional
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={input}>
                <option value="">— manual balance —</option>
                {tracking.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({fmt(a.working, c)})
                  </option>
                ))}
              </select>
            </label>
            {manual && (
              <label className={`${label} col-span-2`}>
                Balance
                <input value={balance} onChange={(e) => setBalance(e.target.value)} onBlur={(e) => setBalance(normalizeAmount(e.target.value))} inputMode="decimal" className={`${input} tnum text-right`} />
              </label>
            )}
            <label className={label}>
              TAN / APR % (nominal)
              <input value={tan} onChange={(e) => setTan(e.target.value)} onBlur={(e) => setTan(normalizeAmount(e.target.value))} inputMode="decimal" className={`${input} tnum text-right`} />
            </label>
            <label className={label}>
              First payment month
              <input type="month" value={startMonth} onChange={(e) => setStartMonth(e.target.value)} className={input} />
            </label>
            <label className={`${label} col-span-2`}>
              Mode
              <select value={mode} onChange={(e) => setMode(e.target.value as 'payment' | 'byDate')} className={input}>
                <option value="payment">Fixed monthly payment</option>
                <option value="byDate">Pay off by date</option>
              </select>
            </label>
            {mode === 'payment' ? (
              <label className={label}>
                Monthly payment (0 = compute from target)
                <input value={payment} onChange={(e) => setPayment(e.target.value)} onBlur={(e) => setPayment(normalizeAmount(e.target.value))} inputMode="decimal" className={`${input} tnum text-right`} />
              </label>
            ) : (
              <label className={label}>
                Pay off by
                <input type="month" value={targetMonth} onChange={(e) => setTargetMonth(e.target.value)} className={input} />
              </label>
            )}
            <label className={label}>
              Extra monthly payment
              <input value={extra} onChange={(e) => setExtra(e.target.value)} onBlur={(e) => setExtra(normalizeAmount(e.target.value))} inputMode="decimal" className={`${input} tnum text-right`} />
            </label>
            <label className={`${label} col-span-2`}>
              Note
              <input value={note} onChange={(e) => setNote(e.target.value)} className={input} placeholder="e.g. 2.500 capitale + ~488 interessi (cfr. PROJECT.md)" />
            </label>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded border border-slate-200 px-3 py-1.5 text-sm text-slate-600">
            Cancel
          </button>
          <button
            disabled={!name.trim() || save.isPending}
            onClick={() => save.mutate()}
            className="rounded bg-accent px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          >
            {plan ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
