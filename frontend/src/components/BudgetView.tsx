import { useMemo, useRef, useState, useEffect, type FormEvent } from 'react'
import { useOutletContext } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BudgetMeta, CategoryView } from '../api'
import { api, errMsg } from '../api'
import { fmt, monthLabel, type Currency } from '../format'
import type { AutoAssignMode } from '../api'
import CategoryRow from './CategoryRow'
import Inspector from './Inspector'
import ForecastPanel from './ForecastPanel'
import Modal, { fieldInput, fieldLabel, ghostBtn, primaryBtn } from './Modal'

type NameModalState =
  | { mode: 'newGroup' }
  | { mode: 'newCategory'; groupId: string; groupName: string }
  | { mode: 'renameGroup'; groupId: string; name: string }

// Toolbar quick-budget actions (Auto-assign dropdown). capRta clamps
// the underfunded plan to Ready-to-Assign, largest shortfall first.
const QUICK_MODES: { mode: AutoAssignMode; capRta?: boolean; label: string; hint: string }[] = [
  { mode: 'underfunded', capRta: true, label: 'Underfunded', hint: 'Fill every target shortfall, capped at Ready to Assign' },
  { mode: 'underfunded', label: 'Underfunded (override RTA)', hint: 'Fill every target shortfall, even beyond Ready to Assign' },
  { mode: 'averageSpent', label: 'Average spent (3m)', hint: 'Assign each category’s average spending of the last 3 months' },
  { mode: 'spentLastMonth', label: 'Spent last month', hint: 'Assign what each category actually spent last month' },
  { mode: 'assignedLastMonth', label: 'Assigned last month', hint: 'Copy last month’s assignments' },
  { mode: 'resetAssigned', label: 'Reset assigned to 0', hint: 'Clear this month’s assignments (money returns to RTA)' },
]

export default function BudgetView() {
  const meta = useOutletContext<BudgetMeta>()
  const qc = useQueryClient()
  const [month, setMonth] = useState(meta.currentMonth)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [months, setMonths] = useState(6)

  const c: Currency = {
    symbol: meta.budget.currencySymbol,
    digits: meta.budget.decimalDigits,
    locale: meta.budget.locale,
  }

  const { data, isLoading } = useQuery({ queryKey: ['month', month], queryFn: () => api.month(month) })
  const { data: expected } = useQuery({ queryKey: ['expected'], queryFn: () => api.expected(24) })
  const { data: forecast } = useQuery({ queryKey: ['forecast', month, months], queryFn: () => api.forecast(month, months) })
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['month', month] })
    qc.invalidateQueries({ queryKey: ['budget'] })
    qc.invalidateQueries({ queryKey: ['categories'] })
    qc.invalidateQueries({ queryKey: ['ops'] })
    qc.invalidateQueries({ queryKey: ['expected'] })
    qc.invalidateQueries({ queryKey: ['forecast'] })
  }
  const assign = useMutation({
    mutationFn: ({ id, milli }: { id: string; milli: number }) => api.assign(month, id, milli),
    onSuccess: refresh,
  })
  const move = useMutation({
    mutationFn: ({ fromId, toId, amount }: { fromId: string; toId: string; amount: number }) =>
      api.move(month, fromId, toId, amount),
    onSuccess: refresh,
  })
  const groupOp = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: refresh,
    onError: (e: Error) => alert(errMsg(e)),
  })

  const idx = meta.months.indexOf(month)
  const [autoMenu, setAutoMenu] = useState(false)
  const [autoConfirm, setAutoConfirm] = useState<(typeof QUICK_MODES)[number] | null>(null)
  const [nameModal, setNameModal] = useState<NameModalState | null>(null)
  const autoRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!autoMenu) return
    const close = (e: MouseEvent) => {
      if (!autoRef.current?.contains(e.target as Node)) setAutoMenu(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [autoMenu])
  const quickBudget = useMutation({
    mutationFn: (m: { mode: AutoAssignMode; capRta?: boolean }) => api.quickBudget(month, m.mode, m.capRta),
    onSuccess: (res) => {
      refresh()
      setAutoConfirm(null)
      alert(`Auto-assign: ${res.summary.changed} categories changed (${fmt(res.summary.totalDelta, c)}).`)
    },
    onError: (e: Error) => alert(errMsg(e)),
  })
  const totalUnderfunded = useMemo(
    () => (data ? data.groups.reduce((s, g) => s + g.categories.reduce((s2, cv) => s2 + cv.target.underfunded, 0), 0) : 0),
    [data],
  )
  const onSelect = (id: string, additive: boolean) =>
    setSelected((prev) => {
      if (additive) {
        const next = new Set(prev)
        next.has(id) ? next.delete(id) : next.add(id)
        return next
      }
      return prev.size === 1 && prev.has(id) ? new Set() : new Set([id])
    })

  const flatCats = useMemo(() => (data ? data.groups.flatMap((g) => g.categories) : []), [data])
  const selectedCats: CategoryView[] = flatCats.filter((cv) => selected.has(cv.id))

  const expectedMonth = expected?.months.find((m) => m.month === month)

  return (
    <div className="flex h-full flex-col bg-slate-50">
      {/* Toolbar */}
      <div className="flex h-14 shrink-0 items-center gap-4 border-b border-slate-200 bg-panel px-6">
        <div className="flex items-center gap-1">
          <button
            disabled={idx <= 0}
            onClick={() => setMonth(meta.months[idx - 1])}
            className="grid h-6 w-6 place-items-center rounded text-slate-500 transition-colors hover:bg-slate-100 disabled:opacity-30"
          >
            ‹
          </button>
          <div className="w-40 text-center text-[14px] font-semibold tracking-tight text-slate-900">{monthLabel(month)}</div>
          <button
            disabled={idx >= meta.months.length - 1}
            onClick={() => setMonth(meta.months[idx + 1])}
            className="grid h-6 w-6 place-items-center rounded text-slate-500 transition-colors hover:bg-slate-100 disabled:opacity-30"
          >
            ›
          </button>
        </div>

        <div ref={autoRef} className="relative ml-auto">
          <button
            onClick={() => setAutoMenu((v) => !v)}
            className="rounded border border-slate-300 bg-panel px-3 py-1.5 text-[13px] text-slate-600 transition-colors hover:bg-slate-100"
          >
            ⚡ Auto-assign
            {totalUnderfunded > 0 && (
              <span className="ml-1.5 text-[11px] font-semibold text-amber-600">{fmt(-totalUnderfunded, c)}</span>
            )}
          </button>
          {autoMenu && (
            <div className="absolute right-0 z-20 mt-1 w-72 overflow-hidden rounded-md border border-slate-200 bg-panel py-1 shadow-[var(--elev-popover)]">
              {QUICK_MODES.map((m, i) => (
                <button
                  key={i}
                  onClick={() => {
                    setAutoMenu(false)
                    setAutoConfirm(m)
                  }}
                  className="block w-full px-3 py-2 text-left transition-colors hover:bg-slate-100"
                >
                  <div className="text-[13px] font-medium text-slate-700">
                    {m.label}
                    {m.mode === 'underfunded' && m.capRta && totalUnderfunded > 0 && (
                      <span className="ml-1 text-[11px] font-semibold text-amber-600">{fmt(-totalUnderfunded, c)}</span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-400">{m.hint}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        <button onClick={() => setNameModal({ mode: 'newGroup' })} className="rounded border border-slate-300 bg-panel px-3 py-1.5 text-[13px] text-slate-600 transition-colors hover:bg-slate-100">
          + Category Group
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Table */}
        <div className="flex flex-1 flex-col overflow-y-auto p-6">
          <div className="shrink-0 overflow-visible rounded-[10px] border border-slate-200 bg-panel shadow-[var(--elev-subtle)]">
            <div className="grid grid-cols-[36px_minmax(240px,1fr)_136px_136px_152px] h-8 shrink-0 items-center rounded-t-[10px] border-b border-slate-200 bg-slate-100 px-2 text-[11px] font-semibold tracking-[0.06em] text-slate-500 uppercase">
              <div />
              <div className="px-3">Category</div>
              <div className="px-3 text-right">Assigned</div>
              <div className="px-3 text-right">Activity</div>
              <div className="px-3 text-right">Available</div>
            </div>

            {isLoading || !data ? (
              <div className="p-6 text-slate-400">Loading…</div>
            ) : (
              data.groups
                // Inflow group serializes with no categories and stays hidden;
                // "Credit Card Payments" (system) must show.
                .filter((g) => g.categories.length > 0)
                .map((g) => {
                  const isCollapsed = collapsed.has(g.id)
                  return (
                    <div key={g.id}>
                      <div className="group grid grid-cols-[36px_minmax(240px,1fr)_136px_136px_152px] min-h-[38px] items-center border-b border-slate-200 bg-slate-100 px-2 text-[13px] font-semibold text-slate-700">
                        <button
                          onClick={() =>
                            setCollapsed((p) => {
                              const n = new Set(p)
                              n.has(g.id) ? n.delete(g.id) : n.add(g.id)
                              return n
                            })
                          }
                          className="text-slate-400"
                        >
                          {isCollapsed ? '▸' : '▾'}
                        </button>
                        <div className="flex min-w-0 items-center gap-1.5 px-3">
                          <span className="truncate">{g.name}</span>
                          {!g.isSystem && (
                            <span className="hidden shrink-0 gap-1 text-xs font-normal text-slate-400 group-hover:flex">
                              <button
                                title="Add category"
                                onClick={() => setNameModal({ mode: 'newCategory', groupId: g.id, groupName: g.name })}
                                className="rounded px-1 hover:bg-slate-200"
                              >
                                +
                              </button>
                              <button
                                title="Rename group"
                                onClick={() => setNameModal({ mode: 'renameGroup', groupId: g.id, name: g.name })}
                                className="rounded px-1 hover:bg-slate-200"
                              >
                                ✎
                              </button>
                              {g.categories.length === 0 && (
                                <button
                                  title="Delete group"
                                  onClick={() => groupOp.mutate(() => api.deleteGroup(g.id))}
                                  className="rounded px-1 text-red-500 hover:bg-slate-200"
                                >
                                  🗑
                                </button>
                              )}
                            </span>
                          )}
                        </div>
                        <div className="tnum px-3 text-right">{fmt(g.assigned, c)}</div>
                        <div className="tnum px-3 text-right">{fmt(g.activity, c)}</div>
                        <div className="tnum px-3 text-right">{fmt(g.available, c)}</div>
                      </div>
                      {!isCollapsed &&
                        g.categories.map((cat) => (
                          <CategoryRow
                            key={cat.id}
                            cat={cat}
                            c={c}
                            groups={data.groups}
                            selected={selected.has(cat.id)}
                            onSelect={onSelect}
                            onAssign={(id, milli) => assign.mutate({ id, milli })}
                            onMove={(fromId, toId, amount) => move.mutate({ fromId, toId, amount })}
                          />
                        ))}
                    </div>
                  )
                })
            )}
          </div>
        </div>

        {selectedCats.length > 0 ? (
          <Inspector month={month} selected={selectedCats} c={c} readyToAssign={data?.readyToAssign ?? 0} />
        ) : (
          <ForecastPanel
            month={month}
            c={c}
            readyToAssign={data?.readyToAssign ?? 0}
            expectedMonth={expectedMonth}
            forecast={forecast}
            months={months}
            setMonths={setMonths}
          />
        )}
      </div>

      {nameModal && (
        <NameDialog
          title={
            nameModal.mode === 'newCategory'
              ? `New category in “${nameModal.groupName}”`
              : nameModal.mode === 'newGroup'
                ? 'New category group'
                : 'Rename group'
          }
          label={nameModal.mode === 'newCategory' ? 'Category name' : 'Group name'}
          initial={nameModal.mode === 'renameGroup' ? nameModal.name : ''}
          onClose={() => setNameModal(null)}
          onCommit={(name) => {
            if (nameModal.mode === 'newGroup') groupOp.mutate(() => api.createGroup(name))
            else if (nameModal.mode === 'newCategory') groupOp.mutate(() => api.createCategory(nameModal.groupId, name))
            else if (name !== nameModal.name) groupOp.mutate(() => api.patchGroup(nameModal.groupId, { name }))
            setNameModal(null)
          }}
        />
      )}
      {autoConfirm && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/30" onClick={() => setAutoConfirm(null)}>
          <div
            className="w-96 rounded-lg border border-slate-200 bg-panel p-5 shadow-[var(--elev-popover)]"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-[15px] font-semibold text-slate-900">Auto-assign — {autoConfirm.label}</h2>
            <p className="mt-1 text-[13px] text-slate-500">{autoConfirm.hint}.</p>
            {autoConfirm.mode === 'underfunded' && (
              <p className="mt-2 text-[13px] text-slate-600">
                Total shortfall:{' '}
                <span className="font-semibold text-amber-600">{fmt(-totalUnderfunded, c)}</span>
                {autoConfirm.capRta && (
                  <> · Ready to Assign: <span className="font-semibold">{fmt(data?.readyToAssign ?? 0, c)}</span></>
                )}
              </p>
            )}
            {autoConfirm.mode !== 'underfunded' && autoConfirm.mode !== 'resetAssigned' && (
              <p className="mt-2 text-[12px] text-slate-400">Applies to every visible category in {monthLabel(month)}.</p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setAutoConfirm(null)}
                className="rounded border border-slate-300 px-3 py-1.5 text-[13px] text-slate-600 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                onClick={() => quickBudget.mutate({ mode: autoConfirm.mode, capRta: autoConfirm.capRta })}
                disabled={quickBudget.isPending}
                className="rounded bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:bg-accent-hover disabled:opacity-40"
              >
                {quickBudget.isPending ? 'Assigning…' : 'Assign'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Centered name prompt for group/category create + group rename
// (replaces the old window.prompt flow).
function NameDialog({
  title,
  label,
  initial,
  onClose,
  onCommit,
}: {
  title: string
  label: string
  initial: string
  onClose: () => void
  onCommit: (name: string) => void
}) {
  const [name, setName] = useState(initial)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (trimmed) onCommit(trimmed)
  }
  return (
    <Modal title={title} onClose={onClose} width={420}>
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        <label className="block">
          <span className={fieldLabel}>{label}</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className={fieldInput} />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={ghostBtn}>
            Cancel
          </button>
          <button type="submit" disabled={!name.trim()} className={primaryBtn}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  )
}
