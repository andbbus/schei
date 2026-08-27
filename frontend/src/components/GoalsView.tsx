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
import { fmt, parseAmount, normalizeAmount, shortMonth, type Currency } from '../format'
import { monthsToTarget, requiredContribution } from '../payoff'

type Goal = {
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
}

const addMonthsLabel = (month: string, n: number) => {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + n, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
}
const monthsBetween = (from: string, to: string) => {
  const [y1, m1] = from.split('-').map(Number)
  const [y2, m2] = to.split('-').map(Number)
  return Math.max(1, (y2 - y1) * 12 + (m2 - m1))
}

export default function GoalsView() {
  const meta = useOutletContext<BudgetMeta>()
  const c: Currency = {
    symbol: meta.budget.currencySymbol,
    digits: meta.budget.decimalDigits,
    locale: meta.budget.locale,
  }
  const qc = useQueryClient()
  const { data: goals } = useQuery({ queryKey: ['goal-plans'], queryFn: api.goalPlans })
  const { data: groups } = useQuery({ queryKey: ['categories'], queryFn: api.categories })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editing, setEditing] = useState<Goal | 'new' | null>(null)
  const selected = goals?.find((g) => g.id === selectedId) ?? goals?.[0] ?? null

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['goal-plans'] })
    qc.invalidateQueries({ queryKey: ['txns'] })
    qc.invalidateQueries({ queryKey: ['budget'] })
  }
  const del = useMutation({
    mutationFn: (id: string) => api.deleteGoalPlan(id),
    onSuccess: () => {
      refresh()
      setSelectedId(null)
    },
    onError: (e: Error) => alert(errMsg(e)),
  })

  const onBudget = meta.accounts.filter((a) => a.onBudget && !a.closed)
  const allAccounts = meta.accounts.filter((a) => !a.closed)

  return (
    <div className="flex h-full bg-panel">
      <div className="flex w-80 shrink-0 flex-col border-r border-slate-200">
        <div className="flex items-center justify-between px-4 py-3">
          <h1 className="text-lg font-semibold text-slate-800">Goals</h1>
          <button
            onClick={() => setEditing('new')}
            className="rounded bg-positive px-3 py-1.5 text-sm font-medium text-white hover:bg-positive-hover"
          >
            + New goal
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-4">
          {goals?.length === 0 && <div className="px-3 py-6 text-center text-sm text-slate-400">No goals yet.</div>}
          {goals?.map((g) => {
            const active = g.id === selected?.id
            const pct = g.target > 0 ? Math.min(1, g.effectiveCurrent / g.target) : 0
            return (
              <button
                key={g.id}
                onClick={() => setSelectedId(g.id)}
                className={`mb-1.5 block w-full rounded-lg border p-3 text-left ${
                  active ? 'border-emerald-400 bg-emerald-50' : 'border-slate-200 hover:bg-slate-50'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className={`truncate text-sm font-semibold ${g.active ? 'text-slate-800' : 'text-slate-400'}`}>
                    {g.name}
                  </span>
                  {g.hasContributionSchedule && (
                    <span className="ml-1 shrink-0 rounded bg-emerald-100 px-1.5 text-[10px] text-emerald-700">schedule</span>
                  )}
                </div>
                <div className="mt-1 flex items-baseline justify-between">
                  <span className="tnum text-sm text-slate-700">
                    {fmt(g.effectiveCurrent, c)} <span className="text-slate-400">/ {fmt(g.target, c)}</span>
                  </span>
                  <span className="text-[11px] text-slate-400">{Math.round(pct * 100)}%</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-200">
                  <div className="h-full rounded-full bg-positive" style={{ width: `${pct * 100}%` }} />
                </div>
                <div className="mt-1 text-[11px] text-slate-400">
                  {g.monthlyContribution > 0 ? `${fmt(g.monthlyContribution, c)}/month` : 'no contribution set'}
                  {g.categoryName ? ` · ${g.categoryName}` : ''}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {!selected && <div className="p-6 text-slate-400">Select or create a goal.</div>}
        {selected && (
          <GoalDetail
            key={selected.id}
            goal={selected}
            c={c}
            onBudget={onBudget}
            onEdit={() => setEditing(selected)}
            onDelete={() => {
              if (window.confirm(`Delete goal "${selected.name}"? Existing contribution schedules stay.`)) del.mutate(selected.id)
            }}
            onChanged={refresh}
          />
        )}
      </div>

      {editing && (
        <GoalEditor
          goal={editing === 'new' ? null : editing}
          allAccounts={allAccounts}
          groups={groups ?? []}
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

function GoalDetail({
  goal,
  c,
  onBudget,
  onEdit,
  onDelete,
  onChanged,
}: {
  goal: Goal
  c: Currency
  onBudget: { id: string; name: string }[]
  onEdit: () => void
  onDelete: () => void
  onChanged: () => void
}) {
  const [sourceId, setSourceId] = useState('')
  const [amount, setAmount] = useState('')

  const current = goal.effectiveCurrent / 1000
  const target = goal.target / 1000
  const contribution =
    goal.monthlyContribution > 0
      ? goal.monthlyContribution / 1000
      : goal.targetMonth
        ? requiredContribution(current, target, monthsBetween(goal.startMonth, goal.targetMonth))
        : 0
  const contributionMilli = Math.round(contribution * 1000)
  const months = monthsToTarget(current, target, contribution)
  const completionMonth = months !== null && months > 0 ? addMonthsLabel(goal.startMonth, months - 1) : null

  // projected balance line in milliunits (formatters expect milliunits)
  const chartData = useMemo(() => {
    const out: { month: number; balance: number }[] = []
    let bal = goal.effectiveCurrent
    const cap = months ?? 0
    for (let m = 1; m <= Math.max(1, Math.min(cap, 60)); m++) {
      bal = Math.min(goal.target, bal + contributionMilli)
      out.push({ month: m, balance: bal })
      if (bal >= goal.target) break
    }
    return out
  }, [goal.effectiveCurrent, goal.target, contributionMilli, months])

  const createSchedule = useMutation({
    mutationFn: () =>
      api.createContributionSchedule(goal.id, {
        accountId: sourceId,
        amount: Math.round((parseAmount(amount) || goal.monthlyContribution || contribution * 1000) / 1000) * 1000,
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
          <h2 className="text-xl font-semibold text-slate-800">{goal.name}</h2>
          <div className="mt-0.5 text-sm text-slate-500">
            {goal.accountName ? `Progress synced from ${goal.accountName}` : 'Manual progress'}
            {goal.categoryName ? ` · funded via ${goal.categoryName}` : ''}
            {goal.active ? '' : ' · inactive'}
            {goal.note ? ` · ${goal.note}` : ''}
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
        {stat('Progress', `${fmt(goal.effectiveCurrent, c)} / ${fmt(goal.target, c)}`)}
        {stat('Remaining', fmt(Math.max(0, goal.target - goal.effectiveCurrent), c))}
        {stat('Contribution', goal.monthlyContribution > 0 ? fmt(goal.monthlyContribution, c) : `${fmt(Math.round(contribution * 1000), c)} required`)}
        {stat(
          'Reached',
          months === null ? 'never' : months === 0 ? 'now' : completionMonth ? `${shortMonth(completionMonth)} (${months}m)` : '—',
        )}
      </div>

      {!goal.hasContributionSchedule && onBudget.length > 0 && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
          <div className="mb-2 text-sm font-semibold text-slate-700">Schedule the contribution</div>
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
              Amount
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                onBlur={(e) => setAmount(normalizeAmount(e.target.value))}
                placeholder={(goal.monthlyContribution / 1000).toString() || (contribution > 0 ? contribution.toFixed(2) : '')}
                inputMode="decimal"
                className="tnum mt-0.5 w-28 rounded border border-slate-300 px-1 py-1 text-right text-sm"
              />
            </label>
            <button
              disabled={!sourceId || !goal.categoryId || createSchedule.isPending}
              onClick={() => createSchedule.mutate()}
              className="rounded bg-positive px-3 py-1 text-sm text-white disabled:opacity-40"
              title={goal.categoryId ? '' : 'The goal needs a funding category (edit it first)'}
            >
              Create schedule
            </button>
            <span className="text-[11px] text-slate-400">Monthly, categorized to {goal.categoryName ?? '…'}.</span>
          </div>
        </div>
      )}
      {goal.hasContributionSchedule && (
        <div className="mb-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Contribution schedule created — it shows in the register and the Cash Flow projection.
        </div>
      )}

      {chartData.length > 0 && (
        <div className="mb-4 print:hidden">
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#282c3f" />
              <XAxis dataKey="month" fontSize={11} />
              <YAxis tickFormatter={(v) => fmt(v, { ...c, digits: 0 })} fontSize={11} width={70} />
              <Tooltip formatter={(v) => fmt(Number(v), c)} />
              <Line type="monotone" dataKey="balance" name="Saved" stroke="#9ece6a" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      {months === null && (
        <div className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-700">
          No contribution set and no target date — set one to see the projection.
        </div>
      )}
    </div>
  )
}

function GoalEditor({
  goal,
  allAccounts,
  groups,
  c,
  onClose,
  onSaved,
}: {
  goal: Goal | null
  allAccounts: { id: string; name: string; working: number }[]
  groups: { id: string; name: string; categories: { id: string; name: string }[] }[]
  c: Currency
  onClose: () => void
  onSaved: (id: string | null) => void
}) {
  const [name, setName] = useState(goal?.name ?? '')
  const [accountId, setAccountId] = useState(goal?.accountId ?? '')
  const [categoryId, setCategoryId] = useState(goal?.categoryId ?? '')
  const [target, setTarget] = useState(goal ? (goal.target / 1000).toString() : '')
  const [current, setCurrent] = useState(goal ? (goal.effectiveCurrent / 1000).toString() : '')
  const [mode, setMode] = useState<'contribution' | 'byDate'>(!goal || goal.monthlyContribution > 0 ? 'contribution' : 'byDate')
  const [contribution, setContribution] = useState(goal && goal.monthlyContribution > 0 ? (goal.monthlyContribution / 1000).toString() : '')
  const [targetMonth, setTargetMonth] = useState(goal?.targetMonth?.slice(0, 7) ?? '')
  const [startMonth, setStartMonth] = useState(goal?.startMonth?.slice(0, 7) ?? new Date().toISOString().slice(0, 7))
  const [note, setNote] = useState(goal?.note ?? '')
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        name: name.trim(),
        target: Math.round(parseAmount(target)),
        accountId: accountId || null,
        categoryId: categoryId || null,
        monthlyContribution: Math.round(parseAmount(mode === 'contribution' ? contribution : '')),
        targetMonth: mode === 'byDate' ? `${targetMonth}-01` : null,
        startMonth: `${startMonth}-01`,
        note: note.trim() || null,
      }
      if (!accountId) body.current = Math.round(parseAmount(current))
      return goal ? api.updateGoalPlan(goal.id, body) : api.createGoalPlan(body)
    },
    onSuccess: (r: unknown) => {
      const createdId = (r as { id?: string } | null)?.id ?? null
      onSaved(goal ? goal.id : createdId)
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
          <h2 className="text-[15px] font-semibold text-slate-800">{goal ? 'Edit goal' : 'New goal'}</h2>
          <button onClick={onClose} className="rounded px-2 py-1 text-slate-400 hover:bg-slate-100">
            ✕
          </button>
        </div>
        {error && <div className="mb-2 rounded bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>}
        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-2 gap-3">
            <label className={`${label} col-span-2`}>
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} className={input} placeholder="e.g. Emergency fund" />
            </label>
            <label className={`${label} col-span-2`}>
              Linked account (progress syncs) — optional
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={input}>
                <option value="">— manual progress —</option>
                {allAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({fmt(a.working, c)})
                  </option>
                ))}
              </select>
            </label>
            {manual && (
              <label className={label}>
                Current saved
                <input value={current} onChange={(e) => setCurrent(e.target.value)} onBlur={(e) => setCurrent(normalizeAmount(e.target.value))} inputMode="decimal" className={`${input} tnum text-right`} />
              </label>
            )}
            <label className={label}>
              Target amount
              <input value={target} onChange={(e) => setTarget(e.target.value)} onBlur={(e) => setTarget(normalizeAmount(e.target.value))} inputMode="decimal" className={`${input} tnum text-right`} />
            </label>
            <label className={`${label} col-span-2`}>
              Funding category (for the contribution schedule)
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={input}>
                <option value="">—</option>
                {groups.map((g) => (
                  <optgroup key={g.id} label={g.name}>
                    {g.categories.map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        {cat.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label className={`${label} col-span-2`}>
              Mode
              <select value={mode} onChange={(e) => setMode(e.target.value as 'contribution' | 'byDate')} className={input}>
                <option value="contribution">Fixed monthly contribution</option>
                <option value="byDate">Reach by date</option>
              </select>
            </label>
            {mode === 'contribution' ? (
              <label className={label}>
                Monthly contribution (0 = compute from target date)
                <input value={contribution} onChange={(e) => setContribution(e.target.value)} onBlur={(e) => setContribution(normalizeAmount(e.target.value))} inputMode="decimal" className={`${input} tnum text-right`} />
              </label>
            ) : (
              <label className={label}>
                Reach by
                <input type="month" value={targetMonth} onChange={(e) => setTargetMonth(e.target.value)} className={input} />
              </label>
            )}
            <label className={label}>
              First contribution month
              <input type="month" value={startMonth} onChange={(e) => setStartMonth(e.target.value)} className={input} />
            </label>
            <label className={`${label} col-span-2`}>
              Note
              <input value={note} onChange={(e) => setNote(e.target.value)} className={input} placeholder="e.g. fondo emergenze 6 mesi" />
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
            className="rounded bg-positive px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          >
            {goal ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
