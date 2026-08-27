import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { GroupView } from '../api'
import { api, errMsg } from '../api'
import { fmt, parseAmount, normalizeAmount, dateDisplay, type Currency } from '../format'

export interface Suggestion {
  payeeId: string
  payee: string
  accountId: string
  categoryId: string | null
  amount: number
  frequency: string
  anchorDay: number | null
  nextDate: string
  occurrences: number
  confidence: number
  varies: boolean
  recentDates: string[]
}

const FREQS = ['once', 'weekly', 'everyOtherWeek', 'monthly', 'yearly']

export default function SuggestionsModal({
  accountId,
  c,
  groups,
  onClose,
}: {
  accountId: string
  c: Currency
  groups: GroupView[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const { data: suggestions } = useQuery({
    queryKey: ['suggestions', accountId],
    queryFn: () => api.suggestions(accountId),
  })
  const { data: dismissed } = useQuery({ queryKey: ['suggestions-dismissed'], queryFn: api.dismissedSuggestions })
  const [editing, setEditing] = useState<Suggestion | null>(null)
  const [amount, setAmount] = useState('')
  const [frequency, setFrequency] = useState('monthly')
  const [nextDate, setNextDate] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [showDismissed, setShowDismissed] = useState(false)

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['suggestions', accountId] })
    qc.invalidateQueries({ queryKey: ['suggestions-dismissed'] })
    qc.invalidateQueries({ queryKey: ['txns', accountId] })
    qc.invalidateQueries({ queryKey: ['budget'] })
  }
  const dismiss = useMutation({
    mutationFn: (s: Suggestion) => api.dismissSuggestion(s.payeeId, s.accountId),
    onSuccess: refresh,
    onError: (e: Error) => setError(errMsg(e)),
  })
  const restore = useMutation({
    mutationFn: (d: { payeeId: string; accountId: string }) => api.restoreSuggestion(d.payeeId, d.accountId),
    onSuccess: refresh,
    onError: (e: Error) => setError(errMsg(e)),
  })
  const add = useMutation({
    mutationFn: (s: Suggestion) =>
      api.createScheduled({
        accountId: s.accountId,
        payeeId: s.payeeId,
        categoryId: categoryId || s.categoryId || null,
        amount: parseAmount(amount),
        frequency,
        nextDate,
        anchorDay: frequency === 'monthly' ? s.anchorDay : null,
      }),
    onSuccess: () => {
      refresh()
      setEditing(null)
      setError(null)
    },
    onError: (e: Error) => setError(errMsg(e)),
  })

  const startEdit = (s: Suggestion) => {
    setEditing(s)
    setAmount((s.amount / 1000).toString())
    setFrequency(s.frequency)
    setNextDate(s.nextDate)
    setCategoryId(s.categoryId ?? '')
    setError(null)
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative z-10 flex max-h-[80vh] w-[680px] flex-col rounded-xl bg-panel p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-slate-800">Schedule Suggestions</h2>
          <button onClick={onClose} className="rounded px-2 py-1 text-slate-400 hover:bg-slate-100">
            ✕
          </button>
        </div>
        <div className="mb-3 text-xs text-slate-400">
          Detected recurring patterns in your register. Adding one creates a scheduled transaction that materializes
          automatically when due.
        </div>
        {error && <div className="mb-2 rounded bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>}
        <div className="flex-1 overflow-y-auto">
          {editing && (
            <div className="mb-4 rounded border border-blue-200 bg-blue-50 p-3">
              <div className="mb-2 text-sm font-semibold text-slate-700">{editing.payee}</div>
              <div className="flex flex-wrap gap-2">
                <label className="flex flex-col text-[11px] text-slate-500">
                  Amount
                  <input value={amount} onChange={(e) => setAmount(e.target.value)} onBlur={(e) => setAmount(normalizeAmount(e.target.value))} className="tnum mt-0.5 w-24 rounded border border-slate-300 px-1 py-0.5 text-right text-sm" />
                </label>
                <label className="flex flex-col text-[11px] text-slate-500">
                  Frequency
                  <select value={frequency} onChange={(e) => setFrequency(e.target.value)} className="mt-0.5 rounded border border-slate-300 px-1 py-0.5 text-sm">
                    {FREQS.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col text-[11px] text-slate-500">
                  Next date
                  <input type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} className="mt-0.5 rounded border border-slate-300 px-1 py-0.5 text-sm" />
                </label>
                <label className="flex flex-col text-[11px] text-slate-500">
                  Category
                  <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="mt-0.5 rounded border border-slate-300 px-1 py-0.5 text-sm">
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
              </div>
              <div className="mt-2 flex gap-1.5">
                <button
                  onClick={() => add.mutate(editing)}
                  className="rounded bg-positive px-3 py-1 text-sm text-white"
                >
                  Add schedule
                </button>
                <button onClick={() => setEditing(null)} className="rounded border border-slate-300 px-3 py-1 text-sm text-slate-600">
                  Cancel
                </button>
              </div>
            </div>
          )}
          <div className="divide-y divide-slate-100">
            {suggestions?.map((s) => (
              <div key={s.payeeId + s.accountId} className="flex items-center gap-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-slate-700">
                    {s.payee}
                    {s.varies && <span className="ml-1 text-[11px] text-amber-600">amount varies</span>}
                  </div>
                  <div className="text-[11px] text-slate-400">
                    {s.frequency} · next {dateDisplay(s.nextDate)} · {s.occurrences} occurrences ·{' '}
                    {s.recentDates.slice(-3).map(dateDisplay).join(', ')}
                  </div>
                </div>
                <div className="tnum text-right text-slate-700">{fmt(s.amount, c)}</div>
                <div
                  className="w-16 text-right text-[11px] text-slate-400"
                  title={`confidence ${Math.round(s.confidence * 100)}%`}
                >
                  {Math.round(s.confidence * 100)}%
                </div>
                <button
                  onClick={() => startEdit(s)}
                  className="shrink-0 rounded bg-accent px-2.5 py-1 text-xs text-white hover:bg-accent-hover"
                >
                  Add
                </button>
                <button
                  onClick={() => dismiss.mutate(s)}
                  className="shrink-0 rounded px-1.5 py-1 text-xs text-slate-300 hover:bg-slate-100 hover:text-slate-500"
                  title="Dismiss this suggestion"
                >
                  ✕
                </button>
              </div>
            ))}
            {suggestions?.length === 0 && !showDismissed && (
              <div className="py-4 text-center text-sm text-slate-400">No recurring patterns found.</div>
            )}
          </div>

          {(dismissed?.length ?? 0) > 0 && (
            <div className="mt-2">
              <button
                onClick={() => setShowDismissed((s) => !s)}
                className="text-[11px] text-slate-400 hover:text-blue-600"
              >
                {showDismissed ? 'Hide' : 'Restore'} dismissed ({dismissed?.length ?? 0})
              </button>
              {showDismissed && (
                <div className="mt-1 divide-y divide-slate-100">
                  {dismissed?.map((d) => (
                    <div key={d.payeeId + d.accountId} className="flex items-center gap-2 py-1.5 text-sm text-slate-500">
                      <span className="min-w-0 flex-1 truncate">{d.payee || '(deleted payee)'}</span>
                      <button
                        onClick={() => restore.mutate(d)}
                        className="rounded bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 hover:bg-emerald-100"
                      >
                        Restore
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
