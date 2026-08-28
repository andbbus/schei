import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BudgetMeta } from '../api'
import { api, errMsg } from '../api'
import { normalizeAmount, parseAmount, todayISO, type Currency } from '../format'
import Modal, { fieldInput, fieldLabel, ghostBtn, primaryBtn } from './Modal'

// Centered "Add transaction" dialog. Global (sidebar / shortcut — with an
// account picker) or scoped to one account when `accountId` is set.
export default function TransactionModal({
  meta,
  accountId,
  onSaved,
  onClose,
}: {
  meta: BudgetMeta
  accountId?: string
  onSaved?: (payload: Record<string, unknown>) => void
  onClose: () => void
}) {
  const qc = useQueryClient()
  const openAccounts = meta.accounts.filter((a) => !a.closed)
  const [acctId, setAcctId] = useState(accountId ?? openAccounts[0]?.id ?? '')
  const [date, setDate] = useState(todayISO())
  const [payee, setPayee] = useState('')
  const [outflow, setOutflow] = useState('')
  const [inflow, setInflow] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [memo, setMemo] = useState('')
  const [repeat, setRepeat] = useState('')
  const [error, setError] = useState<string | null>(null)

  const { data: groups } = useQuery({ queryKey: ['categories'], queryFn: api.categories })
  const { data: payees } = useQuery({ queryKey: ['payees'], queryFn: api.payees })
  const c: Currency = {
    symbol: meta.budget.currencySymbol,
    digits: meta.budget.decimalDigits,
    locale: meta.budget.locale,
  }
  const payeeListId = 'txn-modal-payees'

  const create = useMutation({
    // a "repeat" choice turns the entry into a scheduled transaction instead
    mutationFn: (b: Record<string, unknown>) => (b.frequency ? api.createScheduled(b) : api.createTxn(b)),
    onSuccess: (_r, vars) => {
      qc.invalidateQueries({ queryKey: ['txns', acctId] })
      qc.invalidateQueries({ queryKey: ['budget'] })
      qc.invalidateQueries({ queryKey: ['month'] })
      qc.invalidateQueries({ queryKey: ['ops'] })
      qc.invalidateQueries({ queryKey: ['categories'] })
      qc.invalidateQueries({ queryKey: ['calendar'] })
      onSaved?.(vars)
      onClose()
    },
    onError: (e: Error) => setError(errMsg(e)),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!acctId) return setError('Choose an account.')
    if (!date) return setError('Choose a date.')
    const amount = parseAmount(inflow) - parseAmount(outflow)
    if (amount === 0) return setError(`Enter an outflow or inflow amount (in ${c.symbol}).`)
    setError(null)
    const payload: Record<string, unknown> = {
      accountId: acctId,
      date,
      payeeName: payee.trim() || undefined,
      categoryId: categoryId || null,
      memo: memo.trim() || null,
      amount,
      cleared: 'uncleared',
    }
    if (repeat) {
      payload.frequency = repeat
      payload.nextDate = date
    }
    create.mutate(payload)
  }

  return (
    <Modal title="Add transaction" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        <div className="grid grid-cols-2 gap-3">
          <label className={`block ${accountId ? 'hidden' : ''}`}>
            <span className={fieldLabel}>Account</span>
            <select value={acctId} onChange={(e) => setAcctId(e.target.value)} className={fieldInput}>
              {openAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={fieldLabel}>Date</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={fieldInput} />
          </label>
          <label className="block">
            <span className={fieldLabel}>Outflow</span>
            <input
              value={outflow}
              onChange={(e) => setOutflow(e.target.value)}
              onBlur={(e) => setOutflow(normalizeAmount(e.target.value))}
              placeholder="0"
              inputMode="decimal"
              className={`${fieldInput} tnum`}
            />
          </label>
          <label className="block">
            <span className={fieldLabel}>Inflow</span>
            <input
              value={inflow}
              onChange={(e) => setInflow(e.target.value)}
              onBlur={(e) => setInflow(normalizeAmount(e.target.value))}
              inputMode="decimal"
              className={`${fieldInput} tnum`}
            />
          </label>
        </div>
        <label className="block">
          <span className={fieldLabel}>Payee</span>
          <input
            autoFocus
            value={payee}
            onChange={(e) => setPayee(e.target.value)}
            list={payeeListId}
            placeholder="Someone…"
            className={fieldInput}
          />
          <datalist id={payeeListId}>
            {payees?.map((p) => (
              <option key={p.id} value={p.name} />
            ))}
          </datalist>
        </label>
        <label className="block">
          <span className={fieldLabel}>Category</span>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={fieldInput}>
            <option value="">— none —</option>
            {meta.budget.inflowCategoryId && <option value={meta.budget.inflowCategoryId}>Inflow: Ready to Assign</option>}
            {groups?.map((g) =>
              g.categories.length > 0 ? (
                <optgroup key={g.id} label={g.name}>
                  {g.categories
                    .filter((cat) => !cat.paymentAccountId)
                    .map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        {cat.name}
                      </option>
                    ))}
                </optgroup>
              ) : null,
            )}
          </select>
        </label>
        <label className="block">
          <span className={fieldLabel}>Memo</span>
          <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Optional note" className={fieldInput} />
        </label>
        <label className="block">
          <span className={fieldLabel}>Repeat</span>
          <select value={repeat} onChange={(e) => setRepeat(e.target.value)} className={fieldInput}>
            <option value="">No repeat</option>
            <option value="once">Once</option>
            <option value="weekly">Weekly</option>
            <option value="everyOtherWeek">Every other week</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
          </select>
          <span className="mt-1 block text-[11px] text-slate-400">A repeat creates a scheduled transaction instead.</span>
        </label>
        {error && <div className="rounded bg-red-50 px-2.5 py-1.5 text-[12px] text-red-600">{error}</div>}
        <div className="mt-1 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={ghostBtn}>
            Cancel
          </button>
          <button type="submit" disabled={create.isPending} className={primaryBtn}>
            {repeat ? 'Schedule' : 'Add transaction'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
