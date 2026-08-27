import { useMemo, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BudgetMeta } from '../api'
import { api, errMsg } from '../api'
import { fmt, monthLabel, dateDisplay, type Currency } from '../format'
import CalendarTxnEditor, { type EditorTarget } from './CalendarTxnEditor'

// Calendar — a month grid of everything happening per day: scheduled
// occurrences (expanded from the schedules) and real transactions, including
// future-dated "upcoming" ones. Click a day to see its items in detail.

type CalItem = {
  id: string
  date: string
  payee: string
  amount: number
  category: string | null
  categoryId: string | null
  memo: string | null
  account: string | null
  accountId: string | null
  transfer: boolean
  split: boolean
  source: 'scheduled' | 'txn'
  frequency: string | null
  scheduledId: string | null
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export default function CalendarView() {
  const meta = useOutletContext<BudgetMeta>()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const c: Currency = {
    symbol: meta.budget.currencySymbol,
    digits: meta.budget.decimalDigits,
    locale: meta.budget.locale,
  }
  const [month, setMonth] = useState(meta.currentMonth)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorTarget | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const { data, isLoading } = useQuery({ queryKey: ['calendar', month], queryFn: () => api.calendar(month) })
  const { data: groups } = useQuery({ queryKey: ['categories'], queryFn: api.categories })
  const { data: payees } = useQuery({ queryKey: ['payees'], queryFn: api.payees })
  const { data: rules } = useQuery({ queryKey: ['payee-rules'], queryFn: api.payeeRules })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['calendar', month] })
    qc.invalidateQueries({ queryKey: ['budget'] })
    qc.invalidateQueries({ queryKey: ['month'] })
    qc.invalidateQueries({ queryKey: ['txns'] })
    qc.invalidateQueries({ queryKey: ['ops'] })
    qc.invalidateQueries({ queryKey: ['suggestions'] })
  }

  const del = useMutation({
    mutationFn: (id: string) => api.deleteTxn(id),
    onSuccess: () => refresh(),
    onError: (e: Error) => alert(errMsg(e)),
  })

  const idx = meta.months.indexOf(month)
  const canPrev = idx > 0
  const canNext = idx >= 0 && idx < meta.months.length - 1
  // the grid can still peek beyond the budget's month range for context
  const step = (n: number) => {
    const target = meta.months[Math.min(Math.max(0, (idx < 0 ? meta.months.length - 1 : idx) + n), meta.months.length - 1)]
    if (target !== month) {
      setMonth(target)
      setSelectedDay(null)
    }
  }

  const byDay = useMemo(() => {
    const map = new Map<string, CalItem[]>()
    for (const item of data?.items ?? []) {
      const arr = map.get(item.date) ?? []
      arr.push(item)
      map.set(item.date, arr)
    }
    return map
  }, [data])

  // grid: Monday-first, covering the whole month with leading/trailing days
  const cells = useMemo(() => {
    const [y, m] = month.split('-').map(Number)
    const first = new Date(Date.UTC(y, m - 1, 1))
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
    const lead = (first.getUTCDay() + 6) % 7
    const out: { date: string | null; day: number | null }[] = []
    for (let i = 0; i < lead; i++) out.push({ date: null, day: null })
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${month.slice(0, 7)}-${String(d).padStart(2, '0')}`
      out.push({ date, day: d })
    }
    while (out.length % 7 !== 0) out.push({ date: null, day: null })
    return out
  }, [month])

  const monthNet = (data?.items ?? []).reduce((s, i) => s + i.amount, 0)
  const selected = selectedDay ? (byDay.get(selectedDay) ?? []) : []

  return (
    <div className="flex h-full flex-col bg-slate-50">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-panel px-6">
        <div className="flex items-center gap-1">
          <button
            disabled={!canPrev}
            onClick={() => step(-1)}
            className="grid h-6 w-6 place-items-center rounded text-slate-500 transition-colors hover:bg-slate-100 disabled:opacity-30"
          >
            ‹
          </button>
          <div className="w-40 text-center text-[14px] font-semibold tracking-tight text-slate-900">{monthLabel(month)}</div>
          <button
            disabled={!canNext}
            onClick={() => step(1)}
            className="grid h-6 w-6 place-items-center rounded text-slate-500 transition-colors hover:bg-slate-100 disabled:opacity-30"
          >
            ›
          </button>
        </div>
        <div className="flex items-center gap-3 text-[12px] text-slate-500">
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-blue-400" /> scheduled
          </span>
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-500" /> actual
          </span>
          <span className="tnum font-medium">net {fmt(monthNet, c)}</span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex-1 overflow-auto p-6">
          <div className="grid grid-cols-7 gap-1">
            {WEEKDAYS.map((d) => (
              <div key={d} className="pb-1 text-center text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-400">
                {d}
              </div>
            ))}
            {cells.map((cell, i) => {
              if (!cell.date) return <div key={i} className="min-h-[92px] rounded-lg bg-slate-100/40" />
              const items = byDay.get(cell.date) ?? []
              const isToday = cell.date === new Date().toISOString().slice(0, 10)
              return (
                <button
                  key={cell.date}
                  onClick={() => setSelectedDay(cell.date)}
                  className={`min-h-[92px] rounded-lg border p-1.5 text-left transition-colors ${
                    selectedDay === cell.date
                      ? 'border-blue-400 bg-blue-50'
                      : isToday
                        ? 'border-slate-300 bg-panel ring-1 ring-blue-300'
                        : 'border-slate-200 bg-panel hover:bg-slate-100'
                  }`}
                >
                  <div className={`text-[11px] font-semibold ${isToday ? 'text-blue-600' : 'text-slate-400'}`}>{cell.day}</div>
                  <div className="mt-1 space-y-0.5">
                    {items.slice(0, 3).map((item) => (
                      <div key={item.id} className="flex items-center gap-1 text-[10px] leading-tight">
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${item.source === 'scheduled' ? 'bg-blue-400' : 'bg-emerald-500'}`}
                        />
                        <span className="truncate text-slate-600">{item.payee}</span>
                        <span className={`tnum ml-auto shrink-0 font-medium ${item.amount < 0 ? 'text-red-500' : 'text-emerald-600'}`}>
                          {fmt(item.amount, { ...c, symbol: '' })}
                        </span>
                      </div>
                    ))}
                    {items.length > 3 && <div className="text-[10px] text-slate-400">+{items.length - 3} more</div>}
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* day detail rail */}
        <div className="w-80 shrink-0 overflow-y-auto border-l border-slate-200 bg-panel p-4">
          {selectedDay ? (
            <>
              <div className="flex items-center justify-between">
                <div className="text-[14px] font-semibold text-slate-800">{dateDisplay(selectedDay)}</div>
                <button
                  onClick={() => setEditor({ mode: 'create', date: selectedDay })}
                  className="rounded bg-accent px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-accent-hover"
                >
                  + Add
                </button>
              </div>
              {selected.length === 0 ? (
                <div className="mt-2 text-[12px] text-slate-400">Nothing scheduled or recorded.</div>
              ) : (
                <div className="mt-2 space-y-1.5">
                  {selected.map((item) => (
                    <div key={item.id} className="group rounded-md border border-slate-200 px-2.5 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[13px] font-medium text-slate-700">{item.payee}</span>
                        <span className={`tnum shrink-0 text-[13px] font-semibold ${item.amount < 0 ? 'text-red-500' : 'text-emerald-600'}`}>
                          {fmt(item.amount, c)}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-400">
                        <span className={`rounded-full px-1.5 py-0.5 ${item.source === 'scheduled' ? 'bg-blue-50 text-blue-600' : 'bg-emerald-50 text-emerald-600'}`}>
                          {item.source === 'scheduled' ? 'scheduled' : 'actual'}
                        </span>
                        {item.category && <span className="truncate">{item.category}</span>}
                        {item.account && <span className="truncate">· {item.account}</span>}
                        {item.source === 'txn' && (
                          <span className="ml-auto flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                            {(item.transfer || item.split) && item.accountId ? (
                              <button
                                title="Transfers and splits are edited in the register"
                                onClick={() => navigate(`/accounts/${item.accountId}`)}
                                className="rounded px-1 hover:bg-slate-100"
                              >
                                ↗
                              </button>
                            ) : (
                              <button
                                title="Edit"
                                onClick={() =>
                                  setEditor({
                                    mode: 'edit',
                                    id: item.id,
                                    date: item.date,
                                    accountId: item.accountId ?? undefined,
                                    payee: item.payee,
                                    categoryId: item.categoryId,
                                    memo: item.memo,
                                    amount: item.amount,
                                  })
                                }
                                className="rounded px-1 hover:bg-slate-100"
                              >
                                ✎
                              </button>
                            )}
                            <button
                              title="Delete (undoable from the History menu)"
                              onClick={() => {
                                if (window.confirm(`Delete "${item.payee}" (${fmt(item.amount, c)})?`)) del.mutate(item.id)
                              }}
                              className="rounded px-1 text-red-500 hover:bg-red-50"
                            >
                              🗑
                            </button>
                          </span>
                        )}
                        {item.source === 'scheduled' && (
                          <button
                            title="Scheduled transactions are managed in Subscriptions"
                            onClick={() => navigate('/subscriptions')}
                            className="ml-auto shrink-0 rounded px-1 text-slate-300 opacity-0 transition-opacity hover:bg-slate-100 group-hover:opacity-100"
                          >
                            ↗
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="mt-6 text-center text-[12px] text-slate-400">Click a day to see or add what happens on it.</div>
          )}
          {isLoading && <div className="mt-4 text-[12px] text-slate-400">Loading…</div>}
        </div>
      </div>

      {editor && (
        <CalendarTxnEditor
          target={editor}
          accounts={meta.accounts}
          groups={groups ?? []}
          payees={payees ?? []}
          rules={rules ?? []}
          c={c}
          onClose={() => setEditor(null)}
          onSaved={(msg) => {
            setEditor(null)
            setNotice(msg)
            refresh()
            setTimeout(() => setNotice(null), 2500)
          }}
        />
      )}
      {notice && (
        <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-full bg-emerald-600 px-4 py-1.5 text-[12px] font-medium text-white shadow-lg">
          {notice}
        </div>
      )}
    </div>
  )
}
