import { useId, useMemo, useState } from 'react'
import { useParams, useOutletContext } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AccountLite, BudgetMeta, GroupView, TxnRow } from '../api'
import { api } from '../api'
import { fmt, parseAmount, dateDisplay, todayISO, type Currency } from '../format'

const TRANSFER_PREFIX = 'Transfer : '

export default function AccountView() {
  const { id = '' } = useParams()
  const meta = useOutletContext<BudgetMeta>()
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [reconciling, setReconciling] = useState(false)

  const account = meta.accounts.find((a) => a.id === id)
  const c: Currency = {
    symbol: meta.budget.currencySymbol,
    digits: meta.budget.decimalDigits,
    locale: meta.budget.locale,
  }

  const [search, setSearch] = useState('')
  const { data: txns } = useQuery({ queryKey: ['txns', id], queryFn: () => api.accountTxns(id) })
  const { data: groups } = useQuery({ queryKey: ['categories'], queryFn: api.categories })
  const { data: payees } = useQuery({ queryKey: ['payees'], queryFn: api.payees })
  const otherAccounts = meta.accounts.filter((a) => a.id !== id && !a.closed)

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return txns ?? []
    return (txns ?? []).filter((t) =>
      [t.payee, t.category, t.memo, (t.amount / 1000).toString()].some((s) => s.toLowerCase().includes(q)),
    )
  }, [txns, search])

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['txns', id] })
    qc.invalidateQueries({ queryKey: ['budget'] })
    qc.invalidateQueries({ queryKey: ['month'] })
  }
  const create = useMutation({
    // a "repeat" choice turns the new txn into a schedule instead
    mutationFn: (b: Record<string, unknown>) =>
      b.frequency
        ? api.createScheduled({ ...b, accountId: id, nextDate: b.date })
        : api.createTxn({ ...b, accountId: id }),
    onSuccess: () => {
      invalidate()
      setAdding(false)
    },
  })
  const update = useMutation({
    mutationFn: ({ t, b }: { t: TxnRow; b: Record<string, unknown> }) =>
      t.scheduledId ? api.updateScheduled(t.scheduledId, b) : api.updateTxn(t.id, b),
    onSuccess: () => {
      invalidate()
      setEditingId(null)
    },
  })
  const del = useMutation({
    mutationFn: (t: TxnRow) => (t.scheduledId ? api.deleteScheduled(t.scheduledId) : api.deleteTxn(t.id)),
    onSuccess: invalidate,
  })
  const clearedM = useMutation({
    mutationFn: ({ tid, cleared }: { tid: string; cleared: string }) => api.toggleCleared(tid, cleared),
    onSuccess: invalidate,
  })
  const reconcileM = useMutation({
    mutationFn: (balance: number) => api.reconcile(id, balance),
    onSuccess: () => {
      invalidate()
      setReconciling(false)
    },
  })

  // Reconciled rows are advisory-locked: edits need an explicit confirm.
  const guardReconciled = (t: TxnRow, fn: () => void) => {
    if (t.cleared !== 'reconciled' || window.confirm('This transaction is reconciled. Edit it anyway?')) fn()
  }

  if (!account) return <div className="p-6 text-slate-500">Account not found.</div>

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex items-end justify-between border-b border-slate-200 px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">{account.name}</h1>
          <div className="mt-1 flex gap-4 text-sm">
            <Bal label="Cleared" v={account.cleared} c={c} />
            <span className="text-slate-300">+</span>
            <Bal label="Uncleared" v={account.uncleared} c={c} />
            <span className="text-slate-300">=</span>
            <Bal label="Working Balance" v={account.working} c={c} bold />
            {account.upcoming !== 0 && <Bal label="Upcoming" v={account.upcoming} c={c} />}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-48 rounded border border-slate-200 px-2 py-1.5 text-sm"
          />
          <button
            onClick={() => setReconciling((r) => !r)}
            className="rounded border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
          >
            Reconcile
          </button>
          <button onClick={() => setAdding(true)} className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700">
            + Add Transaction
          </button>
        </div>
      </div>

      {reconciling && (
        <ReconcilePanel
          clearedBalance={account.cleared}
          c={c}
          onFinish={(balance) => reconcileM.mutate(balance)}
          onCancel={() => setReconciling(false)}
        />
      )}

      <div className="grid grid-cols-[36px_110px_1fr_1fr_1fr_120px_120px_36px_120px] border-b border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
        <div />
        <div>Date</div>
        <div>Payee</div>
        <div>Category</div>
        <div>Memo</div>
        <div className="text-right">Outflow</div>
        <div className="text-right">Inflow</div>
        <div className="text-center">C</div>
        <div className="text-right">Balance</div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {adding && (
          <TxnEditor
            groups={groups ?? []}
            payees={payees ?? []}
            accounts={otherAccounts}
            onCancel={() => setAdding(false)}
            onSave={(b) => create.mutate(b)}
          />
        )}
        {visible.map((t) =>
          editingId === t.id ? (
            <TxnEditor
              key={t.id}
              groups={groups ?? []}
              payees={payees ?? []}
              accounts={otherAccounts}
              initial={t}
              onCancel={() => setEditingId(null)}
              onSave={(b) => update.mutate({ t, b })}
              onDelete={() => del.mutate(t)}
            />
          ) : (
            <Row
              key={t.id}
              t={t}
              c={c}
              onEdit={() => guardReconciled(t, () => setEditingId(t.id))}
              onToggleCleared={() => {
                if (t.scheduledId) return // ghost rows aren't real txns yet
                guardReconciled(t, () =>
                  clearedM.mutate({ tid: t.id, cleared: t.cleared === 'uncleared' ? 'cleared' : t.cleared === 'reconciled' ? 'cleared' : 'uncleared' }),
                )
              }}
            />
          ),
        )}
      </div>
    </div>
  )
}

// YNAB-style reconcile: confirm the cleared balance, or enter the real bank
// balance and let the backend write the adjustment.
function ReconcilePanel({
  clearedBalance,
  c,
  onFinish,
  onCancel,
}: {
  clearedBalance: number
  c: Currency
  onFinish: (balance: number) => void
  onCancel: () => void
}) {
  const [entering, setEntering] = useState(false)
  const [balance, setBalance] = useState('')
  const diff = parseAmount(balance) - clearedBalance
  return (
    <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-6 py-3 text-sm text-slate-700">
      {!entering ? (
        <>
          <span>
            Is your current bank balance <b className="tnum">{fmt(clearedBalance, c)}</b>?
          </span>
          <button onClick={() => onFinish(clearedBalance)} className="rounded bg-emerald-500 px-3 py-1 text-white">
            Yes, finish
          </button>
          <button onClick={() => setEntering(true)} className="rounded border border-slate-300 px-3 py-1">
            No
          </button>
        </>
      ) : (
        <>
          <span>Enter your bank balance:</span>
          <input
            autoFocus
            placeholder="0"
            value={balance}
            onChange={(e) => setBalance(e.target.value)}
            className="tnum w-32 rounded border border-slate-300 px-2 py-1 text-right"
          />
          {balance && (
            <span className={diff === 0 ? 'text-emerald-700' : 'text-amber-700'}>
              {diff === 0 ? 'Matches cleared balance.' : `Adjustment of ${fmt(diff, c)} will be created.`}
            </span>
          )}
          <button onClick={() => onFinish(parseAmount(balance))} className="rounded bg-emerald-500 px-3 py-1 text-white">
            Finish reconciliation
          </button>
        </>
      )}
      <button onClick={onCancel} className="ml-auto rounded px-2 py-1 text-slate-500 hover:bg-amber-100">
        ✕
      </button>
    </div>
  )
}

function Bal({ label, v, c, bold }: { label: string; v: number; c: Currency; bold?: boolean }) {
  return (
    <div>
      <span className="mr-1 text-slate-400">{label}</span>
      <span className={`tnum ${bold ? 'font-semibold' : ''} ${v < 0 ? 'text-red-600' : 'text-slate-800'}`}>{fmt(v, c)}</span>
    </div>
  )
}

function Row({
  t,
  c,
  onEdit,
  onToggleCleared,
}: {
  t: TxnRow
  c: Currency
  onEdit: () => void
  onToggleCleared: () => void
}) {
  return (
    <div
      onClick={onEdit}
      className={`grid grid-cols-[36px_110px_1fr_1fr_1fr_120px_120px_36px_120px] items-center border-b border-slate-100 px-3 py-1.5 text-[13px] hover:bg-blue-50 ${
        t.upcoming ? 'text-slate-400 italic' : 'text-slate-700'
      }`}
    >
      <div className="text-center">{t.flagColor ? <span style={{ color: flagHex(t.flagColor) }}>⚑</span> : ''}</div>
      <div>
        {t.scheduledId ? <span title={`repeats ${t.frequency}`}>🔁 </span> : ''}
        {dateDisplay(t.date)}
      </div>
      <div className="truncate pr-2">{t.payee}</div>
      <div className="truncate pr-2 text-slate-500">{t.category}</div>
      <div className="truncate pr-2 text-slate-400">{t.memo}</div>
      <div className="tnum text-right">{t.amount < 0 ? fmt(-t.amount, c) : ''}</div>
      <div className="tnum text-right text-emerald-700">{t.amount > 0 ? fmt(t.amount, c) : ''}</div>
      <div className="text-center" onClick={(e) => { e.stopPropagation(); onToggleCleared() }}>
        <span
          className={`inline-block h-4 w-4 rounded-full text-[10px] leading-4 ${
            t.cleared === 'uncleared' ? 'bg-slate-200 text-slate-400' : t.cleared === 'reconciled' ? 'bg-blue-500 text-white' : 'bg-emerald-500 text-white'
          }`}
          title={t.cleared}
        >
          {t.cleared === 'uncleared' ? '' : 'C'}
        </span>
      </div>
      <div className={`tnum text-right ${t.runningBalance < 0 ? 'text-red-600' : 'text-slate-600'}`}>{fmt(t.runningBalance, c)}</div>
    </div>
  )
}

const FLAG_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple']

function TxnEditor({
  groups,
  payees,
  accounts,
  initial,
  onSave,
  onCancel,
  onDelete,
}: {
  groups: GroupView[]
  payees: { id: string; name: string }[]
  accounts: AccountLite[]
  initial?: TxnRow
  onSave: (b: Record<string, unknown>) => void
  onCancel: () => void
  onDelete?: () => void
}) {
  const listId = useId()
  const [date, setDate] = useState(initial?.date ?? todayISO())
  const [payee, setPayee] = useState(initial?.payee ?? '')
  const [categoryId, setCategoryId] = useState(initial?.categoryId ?? '')
  const [memo, setMemo] = useState(initial?.memo ?? '')
  const [flag, setFlag] = useState(initial?.flagColor ?? '')
  const [pickingFlag, setPickingFlag] = useState(false)
  const [outflow, setOutflow] = useState(initial && initial.amount < 0 ? (-initial.amount / 1000).toString() : '')
  const [inflow, setInflow] = useState(initial && initial.amount > 0 ? (initial.amount / 1000).toString() : '')
  const [repeat, setRepeat] = useState(initial?.frequency ?? '')

  // PATCH can't convert a normal txn ↔ transfer, so an existing transfer's
  // payee is read-only. ponytail: convert = delete + recreate; add if it hurts.
  const isExistingTransfer = !!initial?.transferAccountId
  const transferTarget = accounts.find((a) => a.name === payee.slice(TRANSFER_PREFIX.length) && payee.startsWith(TRANSFER_PREFIX))
  // Repeat only for new txns or existing schedules — a real txn can't convert.
  const canRepeat = !initial || !!initial.scheduledId

  const submit = () => {
    const base = {
      date,
      memo,
      flagColor: flag || null,
      amount: parseAmount(inflow) - parseAmount(outflow),
      ...(canRepeat && repeat ? { frequency: repeat } : {}),
    }
    if (isExistingTransfer) {
      onSave(base) // payee/category locked on a transfer leg
    } else if (transferTarget) {
      // category only budgets when the money leaves the budget (tracking target)
      onSave({ ...base, transferAccountId: transferTarget.id, categoryId: transferTarget.onBudget ? null : categoryId || null })
    } else {
      onSave({ ...base, payeeName: payee, categoryId: categoryId || null })
    }
  }

  const categoryLocked = isExistingTransfer || (transferTarget?.onBudget ?? false)

  return (
    <div className="grid grid-cols-[36px_110px_1fr_1fr_1fr_120px_120px_36px_120px] items-center gap-1 border-b border-blue-200 bg-blue-50 px-3 py-1.5 text-[13px]">
      <div className="relative text-center">
        <button onClick={() => setPickingFlag((p) => !p)} title="Flag" style={{ color: flag ? flagHex(flag) : '#cbd5e1' }}>
          ⚑
        </button>
        {pickingFlag && (
          <div className="absolute top-6 left-0 z-10 flex gap-1 rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
            <button
              onClick={() => { setFlag(''); setPickingFlag(false) }}
              className="h-4 w-4 rounded-full border border-slate-300 bg-white"
              title="No flag"
            />
            {FLAG_COLORS.map((f) => (
              <button
                key={f}
                onClick={() => { setFlag(f); setPickingFlag(false) }}
                className="h-4 w-4 rounded-full"
                style={{ backgroundColor: flagHex(f) }}
                title={f}
              />
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-0.5">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded border border-slate-300 px-1 py-0.5" />
        {canRepeat && (
          <select
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
            title="Repeat"
            className="rounded border border-slate-300 px-1 py-0.5 text-[11px] text-slate-500"
          >
            <option value="">No repeat</option>
            <option value="once">Once</option>
            <option value="weekly">Weekly</option>
            <option value="everyOtherWeek">Every other week</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
          </select>
        )}
      </div>
      <input
        placeholder="Payee"
        list={listId}
        value={payee}
        onChange={(e) => setPayee(e.target.value)}
        disabled={isExistingTransfer}
        className="mr-1 rounded border border-slate-300 px-1 py-0.5 disabled:bg-slate-100 disabled:text-slate-400"
      />
      <datalist id={listId}>
        {payees.map((p) => (
          <option key={p.id} value={p.name} />
        ))}
        {accounts.map((a) => (
          <option key={a.id} value={TRANSFER_PREFIX + a.name} />
        ))}
      </datalist>
      <select
        value={categoryLocked ? '' : categoryId}
        onChange={(e) => setCategoryId(e.target.value)}
        disabled={categoryLocked}
        className="mr-1 rounded border border-slate-300 px-1 py-0.5 disabled:bg-slate-100 disabled:text-slate-400"
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
      <input placeholder="Memo" value={memo} onChange={(e) => setMemo(e.target.value)} className="mr-1 rounded border border-slate-300 px-1 py-0.5" />
      <input placeholder="0" value={outflow} onChange={(e) => setOutflow(e.target.value)} className="tnum rounded border border-slate-300 px-1 py-0.5 text-right" />
      <input placeholder="0" value={inflow} onChange={(e) => setInflow(e.target.value)} className="tnum rounded border border-slate-300 px-1 py-0.5 text-right" />
      <div />
      <div className="flex justify-end gap-1">
        <button onClick={submit} className="rounded bg-emerald-500 px-2 py-0.5 text-xs text-white">Save</button>
        <button onClick={onCancel} className="rounded bg-slate-200 px-2 py-0.5 text-xs">✕</button>
        {onDelete && (
          <button onClick={onDelete} className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-600">🗑</button>
        )}
      </div>
    </div>
  )
}

function flagHex(color: string): string {
  const m: Record<string, string> = {
    red: '#ef4444', orange: '#f97316', yellow: '#eab308', green: '#22c55e', blue: '#3b82f6', purple: '#a855f7',
  }
  return m[color] ?? '#94a3b8'
}
