import { useEffect, useId, useState } from 'react'
import type { AccountLite, GroupView } from '../api'
import { prefillFromRules, type RuleLite } from '../lib/rules'
import { parseAmount, type Currency } from '../format'

// Compact transaction editor for the calendar day rail. Covers the common
// case (plain in/out transaction on one account, transfers via the
// "Transfer : Account" payee convention). Splits and existing transfers are
// edited in the register — the calendar routes there instead.

const TRANSFER_PREFIX = 'Transfer : '

export interface EditorTarget {
  mode: 'create' | 'edit'
  date: string
  id?: string
  accountId?: string
  payee?: string
  categoryId?: string | null
  memo?: string | null
  amount?: number
}

export default function CalendarTxnEditor({
  target,
  accounts,
  groups,
  payees,
  rules,
  c,
  onClose,
  onSaved,
}: {
  target: EditorTarget
  accounts: AccountLite[]
  groups: GroupView[]
  payees: { id: string; name: string }[]
  rules: RuleLite[]
  c: Currency
  onClose: () => void
  onSaved: (msg: string) => void
}) {
  const editing = target.mode === 'edit'
  const listId = useId()
  const [date, setDate] = useState(target.date)
  const [accountId, setAccountId] = useState(target.accountId ?? accounts[0]?.id ?? '')
  const [payee, setPayee] = useState(target.payee?.startsWith(TRANSFER_PREFIX) ? target.payee : target.payee ?? '')
  const [categoryId, setCategoryId] = useState(target.categoryId ?? '')
  const [memo, setMemo] = useState(target.memo ?? '')
  const [outflow, setOutflow] = useState(target.amount && target.amount < 0 ? (-target.amount / 1000).toString() : '')
  const [inflow, setInflow] = useState(target.amount && target.amount > 0 ? (target.amount / 1000).toString() : '')
  const [hint, setHint] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const transferTarget = accounts.find(
    (a) => payee.startsWith(TRANSFER_PREFIX) && a.name === payee.slice(TRANSFER_PREFIX.length),
  )
  const catName = (id: string) => groups.flatMap((g) => g.categories).find((x) => x.id === id)?.name ?? ''

  // Rule prefill on payee blur — mirrors the backend pipeline (lib/rules.ts);
  // the server re-applies authoritatively when no category is sent.
  const applyRule = () => {
    const name = payee.trim()
    if (categoryId || !name || transferTarget || name.startsWith(TRANSFER_PREFIX)) return
    const { patch, sourcePattern } = prefillFromRules({ payeeName: name, memo: null, categoryId: null }, rules)
    if (patch.categoryId && sourcePattern) {
      setCategoryId(patch.categoryId)
      setHint(`${sourcePattern} → ${catName(patch.categoryId)}`)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = async () => {
    setError(null)
    const amount = parseAmount(inflow) - parseAmount(outflow)
    if (amount === 0) {
      setError('Enter an amount (outflow or inflow).')
      return
    }
    if (!date) {
      setError('Pick a date.')
      return
    }
    const base: Record<string, unknown> = { date, memo: memo || null, amount }
    if (transferTarget) {
      // Transfers carry no category between on-budget accounts; a tracking
      // target takes one like normal spending (money leaves the budget).
      base.transferAccountId = transferTarget.id
      base.categoryId = transferTarget.onBudget ? null : categoryId || null
    } else {
      if (!payee.trim()) {
        setError('Payee is required.')
        return
      }
      base.payeeName = payee.trim()
      base.categoryId = categoryId || null
    }
    setSaving(true)
    try {
      const { api } = await import('../api')
      if (editing && target.id) {
        await api.updateTxn(target.id, base)
        onSaved('Transaction updated.')
      } else {
        base.accountId = accountId
        await api.createTxn(base)
        onSaved('Transaction added.')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 grid place-items-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30" />
      <div
        className="relative z-10 w-[420px] rounded-xl border border-slate-200 bg-panel p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[15px] font-semibold text-slate-900">
          {editing ? 'Edit transaction' : 'Add transaction'}
        </h2>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="text-[11px] font-medium text-slate-500">
            Date
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5 text-[13px] text-slate-800"
            />
          </label>
          <label className="text-[11px] font-medium text-slate-500">
            Account
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              disabled={editing}
              className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5 text-[13px] text-slate-800 disabled:bg-slate-100 disabled:text-slate-400"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="mt-2 block text-[11px] font-medium text-slate-500">
          Payee
          <input
            list={listId}
            value={payee}
            onChange={(e) => setPayee(e.target.value)}
            onBlur={applyRule}
            placeholder="Payee or Transfer : Account"
            className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5 text-[13px] text-slate-800"
          />
          <datalist id={listId}>
            {payees.map((p) => (
              <option key={p.id} value={p.name} />
            ))}
            {accounts.map((a) => (
              <option key={a.id} value={TRANSFER_PREFIX + a.name} />
            ))}
          </datalist>
        </label>
        {hint && <div className="mt-0.5 text-[10px] text-emerald-600">rule: {hint}</div>}

        <label className="mt-2 block text-[11px] font-medium text-slate-500">
          Category
          <select
            value={categoryId}
            onChange={(e) => {
              setCategoryId(e.target.value)
              setHint(null)
            }}
            disabled={transferTarget?.onBudget ?? false}
            className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5 text-[13px] text-slate-800 disabled:bg-slate-100 disabled:text-slate-400"
          >
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

        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="text-[11px] font-medium text-slate-500">
            Outflow
            <input
              value={outflow}
              onChange={(e) => setOutflow(e.target.value)}
              placeholder="0,00"
              disabled={!!inflow}
              className="tnum mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5 text-[13px] text-slate-800 disabled:bg-slate-100"
            />
          </label>
          <label className="text-[11px] font-medium text-slate-500">
            Inflow
            <input
              value={inflow}
              onChange={(e) => setInflow(e.target.value)}
              placeholder="0,00"
              disabled={!!outflow}
              className="tnum mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5 text-[13px] text-slate-800 disabled:bg-slate-100"
            />
          </label>
        </div>

        <label className="mt-2 block text-[11px] font-medium text-slate-500">
          Memo
          <input
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5 text-[13px] text-slate-800"
          />
        </label>

        {error && <div className="mt-2 rounded bg-red-50 px-2.5 py-1.5 text-[11px] text-red-600">{error}</div>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded border border-slate-300 px-3 py-1.5 text-[13px] text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="rounded bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:bg-accent-hover disabled:opacity-40"
          >
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Add transaction'}
          </button>
        </div>
        <div className="mt-2 text-center text-[10px] text-slate-400">
          Amounts in {c.symbol} · outflow and inflow are mutually exclusive
        </div>
      </div>
    </div>
  )
}
