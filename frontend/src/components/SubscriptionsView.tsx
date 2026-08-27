import { useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BudgetMeta, ScheduledRow } from '../api'
import { api, errMsg } from '../api'
import { fmt, parseAmount, normalizeAmount, dateDisplay, shortMonth, type Currency } from '../format'

const FREQ_LABEL: Record<string, string> = {
  once: 'Once',
  weekly: 'Weekly',
  everyOtherWeek: 'Every 2 weeks',
  monthly: 'Monthly',
  yearly: 'Yearly',
}
const FREQ_KEYS = ['monthly', 'yearly', 'weekly', 'everyOtherWeek', 'once']

// Monthly-equivalent of a subscription's fee (signed; once = 0, not recurring).
function monthlyEq(s: ScheduledRow): number {
  switch (s.frequency) {
    case 'monthly':
      return s.amount
    case 'weekly':
      return (s.amount * 52) / 12
    case 'everyOtherWeek':
      return (s.amount * 26) / 12
    case 'yearly':
      return s.amount / 12
    default:
      return 0
  }
}

interface SubForm {
  payee: string
  categoryId: string
  amount: string
  frequency: string
  startMonth: string // "YYYY-MM"
  endMonth: string // "YYYY-MM"
}
const EMPTY_FORM: SubForm = { payee: '', categoryId: '', amount: '', frequency: 'monthly', startMonth: '', endMonth: '' }

export default function SubscriptionsView() {
  const meta = useOutletContext<BudgetMeta>()
  const qc = useQueryClient()
  const c: Currency = {
    symbol: meta.budget.currencySymbol,
    digits: meta.budget.decimalDigits,
    locale: meta.budget.locale,
  }

  const { data: subs, isLoading } = useQuery({ queryKey: ['scheduled'], queryFn: api.scheduledList })
  const { data: groups } = useQuery({ queryKey: ['categories'], queryFn: api.categories })
  const { data: payees } = useQuery({ queryKey: ['payees'], queryFn: api.payees })
  const { data: month } = useQuery({ queryKey: ['month', meta.currentMonth], queryFn: () => api.month(meta.currentMonth) })

  // categoryId → assigned (budgeted) this month, for the coverage link.
  const assignedByCat = useMemo(() => {
    const m = new Map<string, number>()
    for (const g of month?.groups ?? []) for (const cv of g.categories) m.set(cv.id, cv.assigned)
    return m
  }, [month])

  const [catFilter, setCatFilter] = useState<Set<string>>(new Set())
  const subCats = useMemo(() => {
    const seen = new Map<string, string>()
    for (const s of subs ?? []) if (s.categoryId && s.category !== 'Ready to Assign') seen.set(s.categoryId, s.category ?? '')
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [subs])
  const toggleCat = (id: string) =>
    setCatFilter((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const visible = useMemo(
    () =>
      (subs ?? []).filter((s) => catFilter.size === 0 || (s.categoryId != null && catFilter.has(s.categoryId))),
    [subs, catFilter],
  )
  // Recurring fees / income (monthly equivalents), one-off total, and the budgeted
  // money for the visible rows' categories — deduped so shared categories count once.
  const feesMonthly = visible.reduce((sum, s) => (s.amount < 0 ? sum + monthlyEq(s) : sum), 0)
  const incomeMonthly = visible.reduce((sum, s) => (s.amount > 0 ? sum + monthlyEq(s) : sum), 0)
  const netMonthly = incomeMonthly + feesMonthly
  const yearlyFees = feesMonthly * 12
  const oneOffTotal = visible.reduce((sum, s) => (s.frequency === 'once' ? sum + s.amount : sum), 0)
  const budgetedTotal = useMemo(() => {
    const seen = new Set<string>()
    let total = 0
    for (const s of visible) {
      if (!s.categoryId || s.category === 'Ready to Assign') continue
      if (seen.has(s.categoryId)) continue
      seen.add(s.categoryId)
      total += assignedByCat.get(s.categoryId) ?? 0
    }
    return total
  }, [visible, assignedByCat])

  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<SubForm>(EMPTY_FORM)
  const [error, setError] = useState<string | null>(null)

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['scheduled'] })
    qc.invalidateQueries({ queryKey: ['expected'] })
    qc.invalidateQueries({ queryKey: ['budget'] })
    qc.invalidateQueries({ queryKey: ['ops'] })
  }

  const save = useMutation({
    mutationFn: (b: Record<string, unknown>) => (editingId ? api.updateScheduled(editingId, b) : api.createScheduled(b)),
    onSuccess: () => {
      invalidate()
      setOpen(false)
      setEditingId(null)
    },
    onError: (e: Error) => setError(errMsg(e)),
  })
  const del = useMutation({
    mutationFn: (id: string) => {
      if (!window.confirm('Delete this subscription?')) return Promise.resolve({ ok: false })
      return api.deleteScheduled(id)
    },
    onSuccess: invalidate,
  })
  const skip = useMutation({ mutationFn: (id: string) => api.skipScheduled(id), onSuccess: invalidate })

  const catOpts = useMemo(
    () =>
      (groups ?? [])
        .flatMap((g) => g.categories.map((cv) => ({ id: cv.id, label: `${g.name} › ${cv.name}` })))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [groups],
  )
  const payeeList = useMemo(() => (payees ?? []).map((p) => p.name), [payees])

  const openAdd = () => {
    setForm(EMPTY_FORM)
    setEditingId(null)
    setError(null)
    setOpen(true)
  }
  const openEdit = (s: ScheduledRow) => {
    setForm({
      payee: s.payee ?? '',
      categoryId: s.categoryId ?? '',
      amount: (Math.abs(s.amount) / 1000).toString(),
      frequency: s.frequency,
      startMonth: s.startMonth ? s.startMonth.slice(0, 7) : '',
      endMonth: s.endMonth ? s.endMonth.slice(0, 7) : '',
    })
    setEditingId(s.id)
    setError(null)
    setOpen(true)
  }

  const submit = () => {
    const body: Record<string, unknown> = {
      payeeName: form.payee.trim() || null,
      categoryId: form.categoryId || null,
      amount: -parseAmount(form.amount),
      frequency: form.frequency,
      ...(form.startMonth ? { startMonth: `${form.startMonth}-01` } : {}),
      ...(form.endMonth ? { endMonth: `${form.endMonth}-01` } : {}),
    }
    if (!editingId) {
      const acct = meta.accounts.find((a) => a.onBudget && !a.closed)
      if (!acct) {
        setError('No on-budget account to charge the subscription against.')
        return
      }
      body.accountId = acct.id
    }
    save.mutate(body)
  }

  const input =
    'w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 transition-colors placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/35'
  const label = 'text-xs font-medium text-slate-500'

  return (
    <div className="flex h-full flex-col bg-[#f6f7f9]">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-6">
        <h1 className="text-[15px] font-semibold tracking-tight text-slate-900">Subscriptions</h1>
        <button
          onClick={openAdd}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-emerald-700"
        >
          + Add subscription
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {/* Category filter */}
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-semibold tracking-[0.06em] text-slate-400 uppercase">Category</span>
          <button
            onClick={() => setCatFilter(new Set())}
            className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
              catFilter.size === 0 ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100'
            }`}
          >
            All
          </button>
          {subCats.map(([id, name]) => (
            <button
              key={id}
              onClick={() => toggleCat(id)}
              className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                catFilter.has(id) ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100'
              }`}
            >
              {name}
            </button>
          ))}
        </div>

        <div className="overflow-hidden rounded-[10px] border border-slate-200 bg-white shadow-[var(--elev-subtle)]">
          <div className="grid h-8 grid-cols-[1.5fr_1.2fr_90px_100px_100px_100px_110px_120px_150px] items-center border-b border-slate-200 bg-slate-100 px-3 text-[11px] font-semibold tracking-[0.06em] text-slate-500 uppercase">
            <div className="px-3">Payee</div>
            <div className="px-3">Category</div>
            <div className="px-3 text-right">Fee</div>
            <div className="px-3 text-right">Budgeted</div>
            <div className="px-3">Frequency</div>
            <div className="px-3">Started</div>
            <div className="px-3">Until</div>
            <div className="px-3">Next charge</div>
            <div className="px-3 text-right">Actions</div>
          </div>

          {isLoading || !subs ? (
            <div className="p-6 text-slate-400">Loading…</div>
          ) : subs.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-400">
              No subscriptions yet. Add your first one to start tracking recurring fees.
            </div>
          ) : visible.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-400">No subscriptions match the selected categories.</div>
          ) : (
            <div>
              {visible.map((s) => {
              const ended = s.endMonth != null && `${s.nextDate.slice(0, 7)}-01` > s.endMonth
              const fee = Math.abs(s.amount)
              const isInflow = s.category === 'Ready to Assign' // income, not a budgeted spending category
              const budgeted = !isInflow && s.categoryId ? (assignedByCat.get(s.categoryId) ?? 0) : 0
              const cov = !s.categoryId || isInflow ? 'none' : budgeted <= 0 ? 'unfunded' : budgeted >= fee ? 'covered' : 'partial'
              const covCls =
                cov === 'covered'
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : cov === 'partial'
                    ? 'bg-amber-50 text-amber-700 border-amber-200'
                    : 'bg-red-50 text-red-600 border-red-200'
              return (
                <div
                  key={s.id}
                  className={`grid min-h-[44px] grid-cols-[1.5fr_1.2fr_90px_100px_100px_100px_110px_120px_150px] items-center border-b border-slate-200 px-3 text-[13px] transition-colors hover:bg-slate-50 ${
                    ended ? 'text-slate-400' : ''
                  }`}
                >
                  <div className="truncate px-3 font-medium text-slate-800">{s.payee ?? '(no payee)'}</div>
                  <div className="truncate px-3 text-slate-500">{s.category ?? '—'}</div>
                  <div className="tnum px-3 text-right text-slate-700">{fmt(fee, c)}</div>
                  <div className="px-3">
                    {s.categoryId && cov !== 'none' ? (
                      <div className="flex flex-col items-end gap-0.5">
                        <span className={`tnum text-right ${cov === 'unfunded' ? 'text-red-600' : cov === 'partial' ? 'text-amber-600' : 'text-emerald-700'}`}>
                          {fmt(budgeted, c)}
                        </span>
                        <span className={`rounded border px-1 text-[9px] font-semibold ${covCls}`}>
                          {cov === 'covered' ? 'Covered' : cov === 'partial' ? 'Partial' : 'Unfunded'}
                        </span>
                      </div>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </div>
                  <div className="px-3 text-slate-600">{FREQ_LABEL[s.frequency] ?? s.frequency}</div>
                  <div className="px-3 text-slate-600">{s.startMonth ? shortMonth(s.startMonth) : '—'}</div>
                  <div className="px-3 text-slate-600">
                    {ended ? <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">Ended</span> : s.endMonth ? shortMonth(s.endMonth) : 'Ongoing'}
                  </div>
                  <div className="px-3 text-slate-600">
                    {dateDisplay(s.nextDate)}
                    {s.frequency === 'once' && <span className="ml-1 text-[10px] text-slate-400">once</span>}
                  </div>
                  <div className="flex justify-end gap-1 px-3">
                    <button onClick={() => openEdit(s)} className="rounded px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-100" title="Edit">
                      ✎
                    </button>
                    <button
                      onClick={() => skip.mutate(s.id)}
                      className="rounded px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-100"
                      title="Skip next occurrence"
                    >
                      ⏭
                    </button>
                    <button onClick={() => del.mutate(s.id)} className="rounded px-1.5 py-0.5 text-xs text-red-500 hover:bg-red-50" title="Delete">
                      🗑
                    </button>
                  </div>
                </div>
              )
            })}
              {/* Summary footer — recomputes on the filtered set */}
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-slate-200 bg-slate-50 px-4 py-2 text-[13px]">
                <span className="font-medium text-slate-700">
                  {visible.length} / {subs.length} subscription{visible.length === 1 ? '' : 's'}
                </span>
                <span className="tnum text-slate-700">
                  <b className="font-semibold text-slate-500">Fees / mo</b>&nbsp;{fmt(-feesMonthly, c)}
                </span>
                <span className="tnum text-slate-700">
                  <b className="font-semibold text-slate-500">Income / mo</b>&nbsp;{fmt(incomeMonthly, c)}
                </span>
                <span className={`tnum ${netMonthly < 0 ? 'text-red-600' : 'text-emerald-700'}`}>
                  <b className="font-semibold text-slate-500">Net / mo</b>&nbsp;{fmt(netMonthly, c)}
                </span>
                <span className="tnum text-slate-700">
                  <b className="font-semibold text-slate-500">Fees / yr</b>&nbsp;{fmt(-yearlyFees, c)}
                </span>
                {oneOffTotal !== 0 && (
                  <span className="tnum text-slate-700">
                    <b className="font-semibold text-slate-500">One-off</b>&nbsp;{fmt(oneOffTotal, c)}
                  </span>
                )}
                <span className="tnum text-slate-700">
                  <b className="font-semibold text-slate-500">Budgeted</b>&nbsp;{fmt(budgetedTotal, c)}
                </span>
              </div>
            </div>
          )}
        </div>
        <p className="mt-2 text-[11px] text-slate-400">
          {visible.length} subscription{visible.length === 1 ? '' : 's'}. Recurring fees materialize into the register when due and feed the
          Budget forecast and Cash Flow projection. Set an end date to stop a subscription automatically.
          <b> Budgeted</b> shows what's assigned to the subscription's category this month, with coverage vs the fee.
        </p>
      </div>

      {open && (
        <div className="fixed inset-0 z-30 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
          <div className="relative z-10 flex w-[440px] flex-col gap-3 rounded-xl bg-white p-5 shadow-xl">
            <h2 className="text-[15px] font-semibold text-slate-800">{editingId ? 'Edit subscription' : 'Add subscription'}</h2>
            {error && <div className="rounded bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>}

            <label className="flex flex-col gap-1">
              <span className={label}>Payee</span>
              <input
                list="sub-payees"
                value={form.payee}
                onChange={(e) => setForm({ ...form, payee: e.target.value })}
                placeholder="e.g. Netflix"
                className={input}
              />
              <datalist id="sub-payees">
                {payeeList.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </label>

            <label className="flex flex-col gap-1">
              <span className={label}>Category</span>
              <select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })} className={input}>
                <option value="">—</option>
                {catOpts.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className={label}>Fee (€/period)</span>
                <input
                  inputMode="decimal"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  onBlur={(e) => setForm({ ...form, amount: normalizeAmount(e.target.value) })}
                  placeholder="12,99"
                  className={`${input} tnum text-right`}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className={label}>Frequency</span>
                <select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })} className={input}>
                  {FREQ_KEYS.map((f) => (
                    <option key={f} value={f}>
                      {FREQ_LABEL[f]}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className={label}>Start month</span>
                <input type="month" value={form.startMonth} onChange={(e) => setForm({ ...form, startMonth: e.target.value })} className={input} />
              </label>
              <label className="flex flex-col gap-1">
                <span className={label}>Until (optional)</span>
                <input type="month" value={form.endMonth} onChange={(e) => setForm({ ...form, endMonth: e.target.value })} className={input} />
              </label>
            </div>

            <div className="mt-1 flex justify-end gap-2">
              <button onClick={() => setOpen(false)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100">
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={!form.payee.trim() && !form.categoryId}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
              >
                {editingId ? 'Save' : 'Add'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}