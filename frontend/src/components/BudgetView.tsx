import { useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BudgetMeta, CategoryView } from '../api'
import { api, errMsg } from '../api'
import { fmt, monthLabel, type Currency } from '../format'
import { rtaPill, rtaLabel } from './pills'
import CategoryRow from './CategoryRow'
import Inspector from './Inspector'

export default function BudgetView() {
  const meta = useOutletContext<BudgetMeta>()
  const qc = useQueryClient()
  const [month, setMonth] = useState(meta.currentMonth)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const c: Currency = {
    symbol: meta.budget.currencySymbol,
    digits: meta.budget.decimalDigits,
    locale: meta.budget.locale,
  }

  const { data, isLoading } = useQuery({ queryKey: ['month', month], queryFn: () => api.month(month) })
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['month', month] })
    qc.invalidateQueries({ queryKey: ['budget'] })
    qc.invalidateQueries({ queryKey: ['categories'] })
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

  return (
    <div className="flex h-full flex-col bg-[#eef0f3]">
      {/* Toolbar */}
      <div className="flex h-16 shrink-0 items-center gap-4 border-b border-slate-200 bg-white px-5">
        <div className="flex items-center gap-1">
          <button
            disabled={idx <= 0}
            onClick={() => setMonth(meta.months[idx - 1])}
            className="rounded px-2 py-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30"
          >
            ‹
          </button>
          <div className="w-40 text-center text-[15px] font-semibold text-slate-800">{monthLabel(month)}</div>
          <button
            disabled={idx >= meta.months.length - 1}
            onClick={() => setMonth(meta.months[idx + 1])}
            className="rounded px-2 py-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30"
          >
            ›
          </button>
        </div>

        <div className={`ml-2 flex items-center gap-3 rounded-lg px-4 py-2 ${rtaPill(data?.readyToAssign ?? 0)}`}>
          <span className="tnum text-xl font-bold">{fmt(data?.readyToAssign ?? 0, c)}</span>
          <span className="text-xs leading-tight opacity-90">{rtaLabel(data?.readyToAssign ?? 0)}</span>
        </div>

        <button
          onClick={() => {
            const name = window.prompt('Group name')?.trim()
            if (name) groupOp.mutate(() => api.createGroup(name))
          }}
          className="ml-auto rounded border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
        >
          + Category Group
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Table */}
        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-[28px_1fr_130px_130px_150px] items-center border-b border-slate-200 bg-[#eef0f3] px-2 py-2 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
            <div />
            <div>Category</div>
            <div className="px-2 text-right">Assigned</div>
            <div className="px-2 text-right">Activity</div>
            <div className="px-2 text-right">Available</div>
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
                    <div className="group grid grid-cols-[28px_1fr_130px_130px_150px] items-center border-b border-slate-200 bg-slate-100 px-2 py-1.5 text-[13px] font-semibold text-slate-700">
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
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate">{g.name}</span>
                        {!g.isSystem && (
                          <span className="hidden shrink-0 gap-1 text-xs font-normal text-slate-400 group-hover:flex">
                            <button
                              title="Add category"
                              onClick={() => {
                                const name = window.prompt('Category name')?.trim()
                                if (name) groupOp.mutate(() => api.createCategory(g.id, name))
                              }}
                              className="rounded px-1 hover:bg-slate-200"
                            >
                              +
                            </button>
                            <button
                              title="Rename group"
                              onClick={() => {
                                const name = window.prompt('Group name', g.name)?.trim()
                                if (name && name !== g.name) groupOp.mutate(() => api.patchGroup(g.id, { name }))
                              }}
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
                      <div className="tnum px-2 text-right">{fmt(g.assigned, c)}</div>
                      <div className="tnum px-2 text-right">{fmt(g.activity, c)}</div>
                      <div className="tnum px-2 text-right">{fmt(g.available, c)}</div>
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

        <Inspector month={month} selected={selectedCats} c={c} readyToAssign={data?.readyToAssign ?? 0} />
      </div>
    </div>
  )
}
