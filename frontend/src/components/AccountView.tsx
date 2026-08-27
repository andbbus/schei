import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useParams, useOutletContext, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AccountLite, BudgetMeta, GroupView, TxnRow } from '../api'
import { api, errMsg } from '../api'
import { fmt, parseAmount, normalizeAmount, dateDisplay, todayISO, type Currency } from '../format'
import { EMPTY_FILTERS, activeCount, applyFilters, filtersFromQuery, filtersToQuery, type Filters } from '../filters'
import { csvAmount, downloadFile, toCsv } from '../csv'
import { nextDates } from '../lib/dates'
import { prefillFromRules, type RuleLite } from '../lib/rules'
import RulesManager from './RulesManager'
import SuggestionsModal from './SuggestionsModal'
import PayeesManager from './PayeesManager'
import ImportCsvModal from './ImportCsvModal'
import DuplicatesModal from './DuplicatesModal'

const TRANSFER_PREFIX = 'Transfer : '

export default function AccountView() {
  const { id = '' } = useParams()
  const meta = useOutletContext<BudgetMeta>()
  const qc = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [reconciling, setReconciling] = useState(false)

  const account = meta.accounts.find((a) => a.id === id)
  const c: Currency = {
    symbol: meta.budget.currencySymbol,
    digits: meta.budget.decimalDigits,
    locale: meta.budget.locale,
  }

  const [filters, setFilters] = useState<Filters>(() => filtersFromQuery(searchParams))
  const [showRules, setShowRules] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [showDuplicates, setShowDuplicates] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const selectAllRef = useRef<HTMLInputElement>(null)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [showPayees, setShowPayees] = useState(false)
  // category auto-learning offer after a hand-categorized create
  const [learnAsk, setLearnAsk] = useState<{ payee: string; categoryId: string } | null>(null)
  const [learnDismissed, setLearnDismissed] = useState(false)
  const learnOfferQ = useQuery({
    queryKey: ['learning-offer', learnAsk?.payee ?? ''],
    queryFn: () => api.learningOffer(learnAsk!.payee),
    enabled: !!learnAsk && !learnDismissed,
  })
  const learnOffer = learnOfferQ.data ?? null
  const { data: txns } = useQuery({ queryKey: ['txns', id], queryFn: () => api.accountTxns(id) })
  const { data: groups } = useQuery({ queryKey: ['categories'], queryFn: api.categories })
  const { data: payees } = useQuery({ queryKey: ['payees'], queryFn: api.payees })
  const { data: rules } = useQuery({ queryKey: ['payee-rules'], queryFn: api.payeeRules })
  const { data: suggestions } = useQuery({ queryKey: ['suggestions', id], queryFn: () => api.suggestions(id) })
  const { data: dupGroups } = useQuery({ queryKey: ['duplicates', id], queryFn: () => api.duplicates(id) })
  const otherAccounts = meta.accounts.filter((a) => a.id !== id && !a.closed)

  // URL persistence: filters live in the query string (?q=&cat=&payee=&flag=…)
  useEffect(() => {
    const next = new URLSearchParams(searchParams)
    for (const k of ['q', 'from', 'to', 'cat', 'payee', 'min', 'max', 'cleared', 'flag']) next.delete(k)
    for (const [k, v] of Object.entries(filtersToQuery(filters))) next.set(k, v)
    setSearchParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters])

  const visible = useMemo(() => applyFilters(txns ?? [], filters), [txns, filters])
  const editingRow = txns?.find((t) => t.id === editingId) ?? null

  // Filter options: existing queries + distinct values actually present in the
  // loaded rows (transfer payees and soft-deleted categories aren't in the
  // query results, so only the rows know about them).
  const payeeOpts = useMemo(() => {
    const seen = new Map<string, string>()
    for (const t of txns ?? []) if (t.payeeId && !seen.has(t.payeeId)) seen.set(t.payeeId, t.payee)
    for (const p of payees ?? []) if (!seen.has(p.id)) seen.set(p.id, p.name)
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [txns, payees])

  const catOpts = useMemo(() => {
    const seen = new Map<string, string>()
    for (const g of groups ?? []) for (const cat of g.categories) if (!seen.has(cat.id)) seen.set(cat.id, cat.name)
    for (const t of txns ?? []) if (t.categoryId && !seen.has(t.categoryId)) seen.set(t.categoryId, t.category)
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [txns, groups])

  const setF = (k: keyof Filters, v: string) => setFilters((f) => ({ ...f, [k]: v }))

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const n = new Set(prev)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  const bulkIds = [...selected].filter((id) => !id.startsWith('sched:'))
  const allVisibleSelected = visible.length > 0 && visible.every((t) => selected.has(t.id))
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = selected.size > 0 && !allVisibleSelected
  }, [selected, allVisibleSelected])
  const bulk = useMutation({
    mutationFn: ({ ids, data, del }: { ids: string[]; data?: Record<string, unknown>; del?: boolean }) =>
      api.bulkTxns(ids, data ?? {}, del ?? false),
    onSuccess: (r) => {
      invalidate()
      setSelected(new Set())
      if (r.skipped > 0) alert(`${r.skipped} row(s) skipped (transfers / split transactions).`)
    },
    onError: (e: Error) => alert(errMsg(e)),
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['txns', id] })
    qc.invalidateQueries({ queryKey: ['budget'] })
    qc.invalidateQueries({ queryKey: ['month'] })
    qc.invalidateQueries({ queryKey: ['ops'] })
    qc.invalidateQueries({ queryKey: ['duplicates', id] })
  }
  const create = useMutation({
    // a "repeat" choice turns the new txn into a schedule instead
    mutationFn: (b: Record<string, unknown>) =>
      b.frequency
        ? api.createScheduled({ ...b, accountId: id, nextDate: b.date })
        : api.createTxn({ ...b, accountId: id }),
    onSuccess: (_r, vars) => {
      invalidate()
      setAdding(false)
      // category-learning hook: a hand-categorized plain txn with a typed
      // payee may deserve an "always like this" rule (server does the gating)
      const payeeName = typeof vars.payeeName === 'string' ? vars.payeeName.trim() : ''
      const catId = typeof vars.categoryId === 'string' && vars.categoryId ? vars.categoryId : null
      if (!vars.frequency && !vars.transferAccountId && payeeName && catId) {
        setLearnAsk({ payee: payeeName, categoryId: catId })
        setLearnDismissed(false)
      } else {
        setLearnAsk(null)
      }
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
  const skip = useMutation({
    mutationFn: (t: TxnRow) => api.skipScheduled(t.scheduledId!),
    onSuccess: () => {
      invalidate()
      setEditingId(null)
    },
  })
  const del = useMutation({
    mutationFn: (t: TxnRow) => (t.scheduledId ? api.deleteScheduled(t.scheduledId) : api.deleteTxn(t.id)),
    onSuccess: invalidate,
  })
  // learning-offer actions
  const createRuleM = useMutation({
    mutationFn: (payload: Parameters<typeof api.createPayeeRule>[0]) => api.createPayeeRule(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payee-rules'] })
      setLearnDismissed(true)
    },
  })
  const learnOffM = useMutation({
    mutationFn: (payeeId: string) => api.learnToggle(payeeId, true),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['payees-manage'] }),
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
    <div className="flex h-full flex-col bg-slate-50">
      <div className="flex items-end justify-between border-b border-slate-200 bg-panel px-6 py-4">
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
        <div className="print-hide flex items-center gap-2">
          <button
            onClick={() => setReconciling((r) => !r)}
            className="rounded border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
          >
            Reconcile
          </button>
          <button onClick={() => setAdding(true)} className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover">
            + Add Transaction
          </button>
          <HeaderMenu
            canExport={visible.length > 0}
            exportCsv={() => {
              const rows: (string | number | null)[][] = [
                ['Flag', 'Date', 'Payee', 'Category', 'Memo', 'Outflow', 'Inflow', 'Cleared', 'Scheduled', 'Balance'],
                ...visible.map((t) => [
                  t.flagColor ?? '',
                  t.date,
                  t.payee,
                  t.category,
                  t.memo,
                  t.amount < 0 ? csvAmount(-t.amount, c) : '',
                  t.amount > 0 ? csvAmount(t.amount, c) : '',
                  t.cleared,
                  t.frequency ?? '',
                  t.scheduledId ? '' : csvAmount(t.runningBalance, c),
                ]),
              ]
              downloadFile(`${todayISO()} ${account.name} register.csv`, toCsv(rows, c.locale))
            }}
            items={[
              { label: 'Import CSV…', onClick: () => setShowImport(true) },
              {
                label: 'Possible duplicates',
                onClick: () => setShowDuplicates(true),
                badge: dupGroups?.length ?? 0,
              },
              { label: 'Payee Rules', onClick: () => setShowRules(true) },
              { label: 'Payees (rename / merge)', onClick: () => setShowPayees(true) },
              { label: 'Schedule Suggestions', onClick: () => setShowSuggestions(true), badge: suggestions?.length ?? 0 },
            ]}
          />
        </div>
      </div>

      {showRules && <RulesManager groups={groups ?? []} onClose={() => setShowRules(false)} />}
      {showSuggestions && <SuggestionsModal accountId={id} c={c} groups={groups ?? []} onClose={() => setShowSuggestions(false)} />}
      {showPayees && <PayeesManager onClose={() => setShowPayees(false)} />}
      {showImport && <ImportCsvModal account={account} accounts={meta.accounts} onClose={() => setShowImport(false)} />}
      {showDuplicates && <DuplicatesModal accountId={id} c={c} onClose={() => setShowDuplicates(false)} />}

      <FilterBar
        filters={filters}
        setF={setF}
        setFilters={setFilters}
        payeeOpts={payeeOpts}
        catOpts={catOpts}
        onClear={() => setFilters(EMPTY_FILTERS)}
      />

      {selected.size > 0 && (
        <div className="mx-6 mt-3 flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-4 py-2 text-sm">
          <span className="font-semibold text-slate-700">{selected.size} selected</span>
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) {
                bulk.mutate({ ids: bulkIds, data: { categoryId: e.target.value === '__none__' ? null : e.target.value } })
              }
            }}
            className="rounded border border-slate-300 px-1 py-1 text-sm"
            title="Reassign category"
          >
            <option value="">Category…</option>
            <option value="__none__">— (no category)</option>
            {catOpts.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) {
                bulk.mutate({ ids: bulkIds, data: { flagColor: e.target.value === '__none__' ? null : e.target.value } })
              }
            }}
            className="rounded border border-slate-300 px-1 py-1 text-sm"
            title="Reassign flag"
          >
            <option value="">Flag…</option>
            <option value="__none__">No flag</option>
            {FLAG_COLORS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <button
            onClick={() => {
              if (window.confirm(`Delete ${bulkIds.length} selected transaction(s)?`)) bulk.mutate({ ids: bulkIds, del: true })
            }}
            disabled={bulkIds.length === 0}
            className="rounded bg-red-100 px-2 py-1 text-sm text-red-600 disabled:opacity-40"
          >
            Delete
          </button>
          {bulkIds.length < selected.size && (
            <span className="text-xs text-slate-400">{selected.size - bulkIds.length} scheduled row(s) excluded</span>
          )}
          <button onClick={() => setSelected(new Set())} className="ml-auto rounded px-2 py-1 text-slate-500 hover:bg-slate-100">
            ✕
          </button>
        </div>
      )}

      {reconciling && (
        <ReconcilePanel
          clearedBalance={account.cleared}
          c={c}
          onFinish={(balance) => reconcileM.mutate(balance)}
          onCancel={() => setReconciling(false)}
        />
      )}

      {learnAsk && !learnDismissed && learnOffer && learnOffer.categoryId === learnAsk.categoryId && (
        <div className="mx-6 mt-3 flex flex-wrap items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-4 py-2 text-sm">
          <span className="text-slate-700">
            Always categorize <b>{learnAsk.payee}</b> as{' '}
            <b>
              {groups
                ?.flatMap((g) => g.categories)
                .find((cat) => cat.id === learnOffer.categoryId)?.name ?? 'this category'}
            </b>
            ?
            <span className="ml-1 text-xs text-slate-400">
              ({learnOffer.count}/{learnOffer.total} so far)
            </span>
          </span>
          <button
            onClick={() =>
              createRuleM.mutate({
                pattern: learnOffer.pattern,
                op: 'is',
                stage: 'default',
                action: 'category',
                categoryId: learnOffer.categoryId,
              })
            }
            disabled={createRuleM.isPending}
            className="rounded bg-accent px-2 py-1 text-xs text-white disabled:opacity-40"
          >
            Always
          </button>
          <button onClick={() => setLearnDismissed(true)} className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-panel">
            No thanks
          </button>
          {learnOffer.payeeId && (
            <button
              onClick={() => {
                learnOffM.mutate(learnOffer.payeeId)
                setLearnDismissed(true)
              }}
              className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-panel"
              title="Stop offering rules for this payee"
            >
              Never for this payee
            </button>
          )}
        </div>
      )}

      <div className="mx-6 mb-6 mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-slate-200 bg-panel shadow-[var(--elev-subtle)]">
        <div className="grid grid-cols-[28px_36px_110px_1fr_1fr_1fr_120px_120px_36px_120px] h-8 shrink-0 items-center border-b border-slate-200 bg-slate-100 px-3 text-[11px] font-semibold tracking-[0.06em] text-slate-500 uppercase">
          <input
            ref={selectAllRef}
            type="checkbox"
            checked={allVisibleSelected}
            onChange={() =>
              setSelected(allVisibleSelected ? new Set() : new Set(visible.map((t) => t.id)))
            }
            className="accent-blue-500"
            title="Select all filtered rows"
          />
          <div>Flag</div>
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
            rules={rules ?? []}
            c={c}
            onCancel={() => setAdding(false)}
            onSave={(b) => create.mutate(b)}
          />
        )}
        {editingRow && (
          <TxnEditor
            key={editingRow.id}
            groups={groups ?? []}
            payees={payees ?? []}
            accounts={otherAccounts}
            rules={rules ?? []}
            c={c}
            initial={editingRow}
            onCancel={() => setEditingId(null)}
            onSave={(b) => update.mutate({ t: editingRow, b })}
            onDelete={() => del.mutate(editingRow)}
            onSkip={editingRow.scheduledId ? () => skip.mutate(editingRow) : undefined}
          />
        )}
        {visible.map((t) =>
          t.id === editingId ? null : (
            <Row
              key={t.id}
              t={t}
              c={c}
              selected={selected.has(t.id)}
              onToggleSelect={toggleSelect}
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
        {txns && txns.length > 0 && visible.length === 0 && (
          <div className="p-6 text-center text-sm text-slate-400">No transactions match the filters.</div>
        )}
      </div>
      </div>

      {/* Print / Save-as-PDF table (hidden on screen, shown on paper) */}
      <table className="hidden print:block print:text-[10px]">
        <caption className="pb-2 text-left text-sm font-semibold">
          {account.name} — {visible.length} transactions
        </caption>
        <thead>
          <tr className="border-b border-black text-left">
            <th className="pr-2">Date</th>
            <th className="pr-2">Payee</th>
            <th className="pr-2">Category</th>
            <th className="pr-2">Memo</th>
            <th className="pr-2 text-right">Outflow</th>
            <th className="pr-2 text-right">Inflow</th>
            <th className="pr-2">Cleared</th>
            <th className="pr-2">Flag</th>
            <th className="text-right">Balance</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((t) => (
            <tr key={t.id} className="border-b border-slate-300">
              <td className="pr-2">{dateDisplay(t.date)}</td>
              <td className="pr-2">{t.payee}</td>
              <td className="pr-2">{t.category}</td>
              <td className="pr-2">{t.memo}</td>
              <td className="pr-2 text-right">{t.amount < 0 ? fmt(-t.amount, c) : ''}</td>
              <td className="pr-2 text-right">{t.amount > 0 ? fmt(t.amount, c) : ''}</td>
              <td className="pr-2">{t.cleared}</td>
              <td className="pr-2">{t.flagColor ?? ''}</td>
              <td className="text-right">{t.scheduledId ? '' : fmt(t.runningBalance, c)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Overflow menu in the register header: CSV export, Print/PDF, Import,
// Duplicates, Payee Rules + Schedule Suggestions.
function HeaderMenu({
  canExport,
  exportCsv,
  onPrint = () => window.print(),
  items = [],
}: {
  canExport: boolean
  exportCsv: () => void
  onPrint?: () => void
  items?: { label: string; onClick: () => void; danger?: boolean; badge?: number }[]
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
        title="More actions"
      >
        ⋯
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute top-full right-0 z-20 mt-1 w-52 rounded-lg border border-slate-200 bg-panel py-1 shadow-lg">
            <button
              disabled={!canExport}
              onClick={() => {
                exportCsv()
                setOpen(false)
              }}
              className="block w-full px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:text-slate-300"
              title={canExport ? 'Export the filtered rows' : 'Nothing to export'}
            >
              Export CSV
            </button>
            <button
              onClick={() => {
                onPrint()
                setOpen(false)
              }}
              className="block w-full px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50"
            >
              Print / Save PDF
            </button>
            {items.map((it) => (
              <button
                key={it.label}
                onClick={() => {
                  it.onClick()
                  setOpen(false)
                }}
                className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-slate-50 ${it.danger ? 'text-red-600' : 'text-slate-700'}`}
              >
                {it.label}
                {it.badge ? <span className="ml-1 text-xs text-slate-400">({it.badge})</span> : null}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function FilterBar({
  filters,
  setF,
  setFilters,
  payeeOpts,
  catOpts,
  onClear,
}: {
  filters: Filters
  setF: (k: keyof Filters, v: string) => void
  setFilters: React.Dispatch<React.SetStateAction<Filters>>
  payeeOpts: [string, string][]
  catOpts: [string, string][]
  onClear: () => void
}) {
  const n = activeCount(filters)
  const input =
    'rounded-md border border-slate-300 bg-panel px-2.5 py-1.5 text-[13px] text-slate-800 transition-colors placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/35'
  const CLEARED: { value: Filters['cleared']; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'uncleared', label: 'Uncleared' },
    { value: 'cleared', label: 'Cleared' },
    { value: 'reconciled', label: 'Reconciled' },
  ]
  const toggle = (key: 'categories' | 'payees' | 'flags', value: string) =>
    setFilters((f) => {
      const cur = f[key]
      const next = cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value]
      return { ...f, [key]: next }
    })
  return (
    <div className="print-hide mx-6 mt-4 flex flex-wrap items-end gap-3 rounded-[10px] border border-slate-200 bg-panel p-4 shadow-[var(--elev-subtle)]">
      <input
        placeholder="Search…"
        value={filters.q}
        onChange={(e) => setF('q', e.target.value)}
        className={`${input} w-40`}
      />
      <input type="date" value={filters.from} onChange={(e) => setF('from', e.target.value)} className={input} title="From" />
      <input type="date" value={filters.to} onChange={(e) => setF('to', e.target.value)} className={input} title="To" />
      <MultiSelect
        label="Category"
        options={[['__none__', '— (no category)'], ...catOpts]}
        selected={filters.categories}
        onToggle={(v) => toggle('categories', v)}
      />
      <MultiSelect
        label="Payee"
        options={[['__none__', '(no payee)'], ...payeeOpts]}
        selected={filters.payees}
        onToggle={(v) => toggle('payees', v)}
      />
      <input
        placeholder="Min €"
        value={filters.min}
        onChange={(e) => setF('min', e.target.value)}
        onBlur={(e) => setF('min', normalizeAmount(e.target.value))}
        inputMode="decimal"
        className={`${input} tnum w-20 text-right`}
        title="Minimum amount (negative = outflow)"
      />
      <input
        placeholder="Max €"
        value={filters.max}
        onChange={(e) => setF('max', e.target.value)}
        onBlur={(e) => setF('max', normalizeAmount(e.target.value))}
        inputMode="decimal"
        className={`${input} tnum w-20 text-right`}
        title="Maximum amount (negative = outflow)"
      />
      <div className="flex overflow-hidden rounded border border-slate-200">
        {CLEARED.map((p) => (
          <button
            key={p.value}
            onClick={() => setF('cleared', p.value)}
            className={`px-2 py-1 text-[12px] ${filters.cleared === p.value ? 'bg-accent text-white' : 'bg-panel text-slate-600 hover:bg-slate-100'}`}
          >
            {p.label}
          </button>
        ))}
      </div>
      <MultiSelect
        label="Flag"
        options={[['__none__', 'No flag'], ...FLAG_COLORS.map((f) => [f, f] as [string, string])]}
        selected={filters.flags}
        onToggle={(v) => toggle('flags', v)}
      />
      {n > 0 && (
        <button onClick={onClear} className="rounded px-2 py-1 text-[12px] text-blue-600 hover:bg-blue-50">
          Clear filters ({n})
        </button>
      )}
    </div>
  )
}

// Dropdown with checkboxes — the multi-select filter control.
function MultiSelect({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string
  options: [string, string][]
  selected: string[]
  onToggle: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const visible = needle ? options.filter(([, l]) => l.toLowerCase().includes(needle)) : options
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`${selected.length > 0 ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-slate-200 bg-panel text-slate-600'} rounded border px-2 py-1 text-[12px] hover:bg-slate-100`}
      >
        {label}
        {selected.length > 0 && <span className="ml-1 font-semibold">{selected.length}</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 z-20 mt-1 w-56 rounded-lg border border-slate-200 bg-panel p-1.5 shadow-lg">
            <input
              autoFocus
              placeholder={`Filter ${label.toLowerCase()}s…`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="mb-1 w-full rounded border border-slate-200 px-2 py-1 text-[12px]"
            />
            <div className="max-h-56 overflow-y-auto">
              {visible.map(([v, l]) => (
                <label key={v} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[12px] text-slate-700 hover:bg-slate-50">
                  <input type="checkbox" checked={selected.includes(v)} onChange={() => onToggle(v)} className="accent-blue-600" />
                  <span className="truncate">{l}</span>
                </label>
              ))}
              {visible.length === 0 && <div className="px-2 py-2 text-[11px] text-slate-400">No options.</div>}
            </div>
            {selected.length > 0 && (
              <button onClick={() => selected.forEach(onToggle)} className="mt-1 w-full rounded px-2 py-1 text-[11px] text-blue-600 hover:bg-blue-50">
                Clear selection
              </button>
            )}
          </div>
        </>
      )}
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
    <div className="print-hide flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-6 py-3 text-sm text-slate-700">
      {!entering ? (
        <>
          <span>
            Is your current bank balance <b className="tnum">{fmt(clearedBalance, c)}</b>?
          </span>
          <button onClick={() => onFinish(clearedBalance)} className="rounded bg-positive px-3 py-1 text-white">
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
            onBlur={(e) => setBalance(normalizeAmount(e.target.value))}
            className="tnum w-32 rounded border border-slate-300 px-2 py-1 text-right"
          />
          {balance && (
            <span className={diff === 0 ? 'text-emerald-700' : 'text-amber-700'}>
              {diff === 0 ? 'Matches cleared balance.' : `Adjustment of ${fmt(diff, c)} will be created.`}
            </span>
          )}
          <button onClick={() => onFinish(parseAmount(balance))} className="rounded bg-positive px-3 py-1 text-white">
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
  selected,
  onToggleSelect,
  onEdit,
  onToggleCleared,
}: {
  t: TxnRow
  c: Currency
  selected: boolean
  onToggleSelect: (id: string) => void
  onEdit: () => void
  onToggleCleared: () => void
}) {
  return (
    <div
      onClick={onEdit}
      className={`group grid grid-cols-[28px_36px_110px_1fr_1fr_1fr_120px_120px_36px_120px] min-h-[34px] items-center border-b border-slate-200 px-3 text-[13px] transition-colors duration-100 hover:bg-slate-50 ${
        t.upcoming ? 'text-slate-400 italic' : 'text-slate-700'
      } ${selected ? 'bg-blue-50 shadow-[inset_2px_0_0_#7aa2f7] hover:bg-blue-100' : ''}`}
    >
      <div className="flex justify-center" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={selected} onChange={() => onToggleSelect(t.id)} className="h-[15px] w-[15px] accent-blue-500" />
      </div>
      <div className="text-center">{t.flagColor ? <span style={{ color: flagHex(t.flagColor) }}>⚑</span> : ''}</div>
      <div>
        {t.scheduledId ? <span title={`repeats ${t.frequency}`}>🔁 </span> : ''}
        {dateDisplay(t.date)}
      </div>
      <div className="truncate pr-2 font-medium text-slate-800">{t.payee}</div>
      <div className="truncate pr-2 text-slate-500">{t.category}</div>
      <div className="truncate pr-2 text-slate-400">{t.memo}</div>
      <div className="tnum text-right">{t.amount < 0 ? fmt(-t.amount, c) : ''}</div>
      <div className="tnum text-right font-medium text-emerald-700">{t.amount > 0 ? fmt(t.amount, c) : ''}</div>
      <div className="flex justify-center" onClick={(e) => { e.stopPropagation(); onToggleCleared() }}>
        <span
          className={`inline-grid h-4 w-4 place-items-center rounded-full border text-[9px] font-bold ${
            t.cleared === 'uncleared'
              ? 'border-slate-300 bg-panel text-slate-400'
              : t.cleared === 'reconciled'
                ? 'border-emerald-600 bg-positive text-white'
                : 'border-emerald-200 bg-emerald-50 text-emerald-700'
          }`}
          title={t.cleared}
        >
          {t.cleared === 'uncleared' ? '' : t.cleared === 'reconciled' ? '✓' : 'C'}
        </span>
      </div>
      <div className={`tnum text-right ${t.runningBalance < 0 ? 'font-medium text-red-600' : 'text-slate-600'}`}>{fmt(t.runningBalance, c)}</div>
    </div>
  )
}

const FLAG_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple']

interface SubDraft {
  amount: string
  categoryId: string
  payeeName: string
  memo: string
}

function TxnEditor({
  groups,
  payees,
  accounts,
  rules,
  c,
  initial,
  onSave,
  onCancel,
  onDelete,
  onSkip,
}: {
  groups: GroupView[]
  payees: { id: string; name: string }[]
  accounts: AccountLite[]
  rules?: RuleLite[]
  c: Currency
  initial?: TxnRow
  onSave: (b: Record<string, unknown>) => void
  onCancel: () => void
  onDelete?: () => void
  onSkip?: () => void
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
  const [hint, setHint] = useState<string | null>(null)
  const [split, setSplit] = useState((initial?.subtransactions.length ?? 0) > 0)
  const [subs, setSubs] = useState<SubDraft[]>(
    initial?.subtransactions.map((s) => ({
      amount: (s.amount / 1000).toString(),
      categoryId: s.categoryId ?? '',
      payeeName: '',
      memo: s.memo,
    })) ?? [],
  )
  const [subError, setSubError] = useState<string | null>(null)

  const catName = (catId: string) => groups.flatMap((g) => g.categories).find((c) => c.id === catId)?.name ?? ''

  // Auto-fill the category from a payee rule when the field is still empty.
  // Mirrors the backend pipeline (ranked last-wins) via lib/rules.ts — the
  // server re-applies authoritatively on save when no category is sent.
  const applyRule = () => {
    const name = payee.trim()
    if (categoryId || !name || isExistingTransfer || transferTarget || name.startsWith(TRANSFER_PREFIX)) return
    const { patch, sourcePattern } = prefillFromRules({ payeeName: name, memo: null, categoryId: null }, rules ?? [])
    if (patch.categoryId && sourcePattern) {
      setCategoryId(patch.categoryId)
      setHint(`${sourcePattern} → ${catName(patch.categoryId)}`)
    }
  }

  // PATCH can't convert a normal txn ↔ transfer, so an existing transfer's
  // payee is read-only. ponytail: convert = delete + recreate; add if it hurts.
  const isExistingTransfer = !!initial?.transferAccountId
  const transferTarget = accounts.find((a) => a.name === payee.slice(TRANSFER_PREFIX.length) && payee.startsWith(TRANSFER_PREFIX))
  // Repeat only for new txns or existing schedules — a real txn can't convert.
  const canRepeat = !initial || !!initial.scheduledId
  // Splits only on plain transactions (not transfers, not schedules).
  const canSplit = !isExistingTransfer && !initial?.scheduledId

  const subAmount = (i: number) => parseAmount(subs[i]?.amount ?? '')
  const splitTotal = subs.reduce((s, _, i) => s + subAmount(i), 0)

  const submit = () => {
    const base = {
      date,
      memo,
      flagColor: flag || null,
      ...(canRepeat && repeat ? { frequency: repeat } : {}),
    }
    if (split && canSplit) {
      // parent amount = sum of the rows; each row needs a category
      if (subs.length < 2) {
        setSubError('A split needs at least 2 rows.')
        return
      }
      if (subs.some((s) => !s.categoryId)) {
        setSubError('Every split row needs a category.')
        return
      }
      setSubError(null)
      onSave({
        ...base,
        amount: splitTotal,
        subtransactions: subs.map((s) => ({
          amount: parseAmount(s.amount),
          categoryId: s.categoryId,
          payeeName: s.payeeName.trim() || null,
          memo: s.memo.trim() || null,
        })),
      })
      return
    }
    if (isExistingTransfer) {
      onSave({ ...base, amount: parseAmount(inflow) - parseAmount(outflow) }) // payee/category locked on a transfer leg
    } else if (transferTarget) {
      // category only budgets when the money leaves the budget (tracking target)
      onSave({ ...base, transferAccountId: transferTarget.id, categoryId: transferTarget.onBudget ? null : categoryId || null, amount: parseAmount(inflow) - parseAmount(outflow) })
    } else {
      onSave({ ...base, payeeName: payee, categoryId: categoryId || null, amount: parseAmount(inflow) - parseAmount(outflow) })
    }
  }

  const categoryLocked = isExistingTransfer || (transferTarget?.onBudget ?? false)
  const schedulePreview = initial?.scheduledId
    ? nextDates(initial.frequency ?? 'monthly', initial.date, 4, initial.anchorDay ?? undefined)
    : []

  const setSub = (i: number, patch: Partial<SubDraft>) =>
    setSubs((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)))

  return (
    <div className="print-hide border-b border-blue-200 bg-blue-50 px-3 py-2 text-[13px] shadow-[inset_2px_0_0_#7aa2f7]">
      <div className="grid grid-cols-[28px_36px_110px_1fr_1fr_1fr_120px_120px_36px_120px] items-center gap-1">
        <div />
        <div className="relative text-center">
          <button onClick={() => setPickingFlag((p) => !p)} title="Flag" style={{ color: flag ? flagHex(flag) : '#cbd5e1' }}>
            ⚑
          </button>
          {pickingFlag && (
            <div className="absolute top-6 left-0 z-10 flex gap-1 rounded-lg border border-slate-200 bg-panel p-2 shadow-lg">
              <button
                onClick={() => { setFlag(''); setPickingFlag(false) }}
                className="h-4 w-4 rounded-full border border-slate-300 bg-panel"
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
          {schedulePreview.length > 0 && (
            <div className="text-[10px] text-slate-400" title="Next occurrences">
              {schedulePreview.map(dateDisplay).join(' · ')}
            </div>
          )}
        </div>
        <input
          placeholder="Payee"
          list={listId}
          value={payee}
          onChange={(e) => setPayee(e.target.value)}
          onBlur={applyRule}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              applyRule()
              ;(e.currentTarget as HTMLInputElement).blur()
            }
          }}
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
        <div className="mr-1 flex flex-col">
          <select
            value={split ? '' : categoryId}
            onChange={(e) => {
              setCategoryId(e.target.value)
              setHint(null)
            }}
            disabled={categoryLocked || split}
            className="rounded border border-slate-300 px-1 py-0.5 disabled:bg-slate-100 disabled:text-slate-400"
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
          {hint && (
            <span className="mt-0.5 truncate text-[10px] text-emerald-600" title="Auto-categorized via rule">
              rule: {hint}
            </span>
          )}
          {canSplit && (
            <label className="mt-0.5 flex items-center gap-1 text-[10px] text-slate-500">
              <input type="checkbox" checked={split} onChange={(e) => { setSplit(e.target.checked); setSubError(null) }} className="accent-blue-600" />
              Split
            </label>
          )}
        </div>
        <input placeholder="Memo" value={memo} onChange={(e) => setMemo(e.target.value)} className="mr-1 rounded border border-slate-300 px-1 py-0.5" />
        <input
          placeholder="0"
          value={split ? (splitTotal / 1000).toString() : outflow}
          onChange={(e) => !split && setOutflow(e.target.value)}
          onBlur={(e) => !split && setOutflow(normalizeAmount(e.target.value))}
          disabled={split}
          className="tnum rounded border border-slate-300 px-1 py-0.5 text-right disabled:bg-slate-100"
          title={split ? 'Total of the split rows' : 'Outflow'}
        />
        <input
          placeholder="0"
          value={split ? '' : inflow}
          onChange={(e) => !split && setInflow(e.target.value)}
          onBlur={(e) => !split && setInflow(normalizeAmount(e.target.value))}
          disabled={split}
          className="tnum rounded border border-slate-300 px-1 py-0.5 text-right disabled:bg-slate-100"
        />
        <div />
        <div className="flex justify-end gap-1">
          {onSkip && (
            <button onClick={onSkip} title="Skip the next occurrence (no transaction is created)" className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-700 hover:bg-amber-200">
              Skip next
            </button>
          )}
          <button onClick={submit} className="rounded bg-positive px-2 py-0.5 text-xs text-white">Save</button>
          <button onClick={onCancel} className="rounded bg-slate-200 px-2 py-0.5 text-xs">✕</button>
          {onDelete && (
            <button onClick={onDelete} className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-600">🗑</button>
          )}
        </div>
      </div>

      {split && canSplit && (
        <div className="mt-1.5 rounded border border-blue-200 bg-panel p-2">
          <div className="mb-1.5 text-[11px] font-semibold text-slate-500">Split rows (total {fmt(splitTotal, c)})</div>
          {subs.map((s, i) => (
            <div key={i} className="mb-1 flex items-center gap-1.5">
              <select
                value={s.categoryId}
                onChange={(e) => setSub(i, { categoryId: e.target.value })}
                className="w-44 rounded border border-slate-300 px-1 py-0.5 text-[12px]"
              >
                <option value="">Category…</option>
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
              <input
                placeholder="0"
                value={s.amount}
                onChange={(e) => setSub(i, { amount: e.target.value })}
                onBlur={(e) => setSub(i, { amount: normalizeAmount(e.target.value) })}
                inputMode="decimal"
                className="tnum w-24 rounded border border-slate-300 px-1 py-0.5 text-right text-[12px]"
              />
              <input
                placeholder="Payee"
                list={listId + '-sub'}
                value={s.payeeName}
                onChange={(e) => setSub(i, { payeeName: e.target.value })}
                className="w-32 rounded border border-slate-300 px-1 py-0.5 text-[12px]"
              />
              <input
                placeholder="Memo"
                value={s.memo}
                onChange={(e) => setSub(i, { memo: e.target.value })}
                className="min-w-0 flex-1 rounded border border-slate-300 px-1 py-0.5 text-[12px]"
              />
              <button
                onClick={() => {
                  setSubs((prev) => prev.filter((_, j) => j !== i))
                  setSubError(null)
                }}
                className="rounded px-1.5 py-0.5 text-xs text-red-500 hover:bg-red-50"
                title="Remove row"
              >
                ✕
              </button>
            </div>
          ))}
          <datalist id={listId + '-sub'}>
            {payees.map((p) => (
              <option key={p.id} value={p.name} />
            ))}
          </datalist>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSubs((prev) => [...prev, { amount: '0', categoryId: '', payeeName: '', memo: '' }])}
              className="rounded border border-blue-300 px-2 py-0.5 text-[11px] text-blue-600 hover:bg-blue-50"
            >
              + Add row
            </button>
            {subError && <span className="text-[11px] text-red-600">{subError}</span>}
          </div>
        </div>
      )}
    </div>
  )
}

function flagHex(color: string): string {
  const m: Record<string, string> = {
    red: '#f7768e', orange: '#ff9e64', yellow: '#e0af68', green: '#9ece6a', blue: '#7aa2f7', purple: '#bb9af7',
  }
  return m[color] ?? '#94a3b8'
}
