import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ExpectedMonth, ForecastData } from '../api'
import { api } from '../api'
import { fmt, monthLabel, dateDisplay, parseAmount, type Currency } from '../format'
import { rtaLabel } from './pills'

const WINDOWS = [12, 6, 3]

export default function ForecastPanel({
  month,
  c,
  readyToAssign,
  expectedMonth,
  forecast,
  months,
  setMonths,
}: {
  month: string
  c: Currency
  readyToAssign: number
  expectedMonth?: ExpectedMonth
  forecast?: ForecastData
  months: number
  setMonths: (w: number) => void
}) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<{ categoryId: string; value: string } | null>(null)
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['forecast'] })
    qc.invalidateQueries({ queryKey: ['ops'] })
  }

  const setOv = useMutation({
    mutationFn: (b: { categoryId: string; amount: number }) => api.setForecastOverride(b.categoryId, month, b.amount),
    onSuccess: invalidate,
  })
  const delOv = useMutation({
    mutationFn: (categoryId: string) => api.deleteForecastOverride(categoryId, month),
    onSuccess: invalidate,
  })

  const commit = (categoryId: string, raw: string) => {
    const milli = parseAmount(raw)
    if (milli <= 0) delOv.mutate(categoryId) // empty or zero → revert to moving average
    else setOv.mutate({ categoryId, amount: -milli })
    setEditing(null)
  }

  const knownNet = expectedMonth?.net ?? 0
  const projTotal = forecast?.projectedTotal ?? 0
  const net = knownNet - projTotal

  return (
    <aside className="flex h-full w-[328px] shrink-0 flex-col gap-5 overflow-y-auto border-l border-slate-200 bg-white p-5 shadow-[-8px_0_24px_-20px_rgba(16,24,40,0.4)]">
      {/* Ready to Assign */}
      <div>
        <div className="text-[11px] font-semibold tracking-[0.06em] text-slate-400 uppercase">Ready to Assign</div>
        <div className={`tnum mt-1 text-2xl font-semibold ${readyToAssign < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
          {fmt(readyToAssign, c)}
        </div>
        <div className="text-xs text-slate-500">{rtaLabel(readyToAssign)}</div>
      </div>

      {/* Known transactions */}
      <div>
        <div className="mb-1.5 text-[11px] font-semibold tracking-[0.06em] text-slate-400 uppercase">
          Known transactions · {monthLabel(month)}
        </div>
        {!expectedMonth || expectedMonth.items.length === 0 ? (
          <div className="text-[13px] text-slate-400">No scheduled or upcoming transactions this month.</div>
        ) : (
          <>
            <ul className="divide-y divide-slate-100 text-[13px]">
              {expectedMonth.items.map((it, i) => (
                <li key={i} className="flex items-center justify-between py-1">
                  <span className="truncate pr-3 text-slate-600">
                    {dateDisplay(it.date)} · {it.payee || it.category || '(no payee)'}
                    {it.source === 'scheduled' && it.frequency ? ` · ${it.frequency}` : ''}
                    {it.source === 'upcoming' ? ' · upcoming' : ''}
                  </span>
                  <span className={`tnum shrink-0 ${it.amount > 0 ? 'text-emerald-700' : 'text-slate-700'}`}>{fmt(it.amount, c)}</span>
                </li>
              ))}
            </ul>
            <div className="mt-1 flex items-center justify-between border-t border-slate-200 pt-1.5 text-[13px] font-medium">
              <span className="text-slate-500">Known net</span>
              <span className={`tnum ${knownNet < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{fmt(knownNet, c)}</span>
            </div>
          </>
        )}
      </div>

      {/* Projected expenses */}
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <div className="text-[11px] font-semibold tracking-[0.06em] text-slate-400 uppercase">Projected expenses</div>
          <div className="flex shrink-0 overflow-hidden rounded-md border border-slate-200">
            {WINDOWS.map((w) => (
              <button
                key={w}
                onClick={() => setMonths(w)}
                className={`px-2 py-0.5 text-[11px] transition-colors ${
                  months === w ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'
                }`}
              >
                {w}m
              </button>
            ))}
          </div>
        </div>
        {!forecast || forecast.projected.length === 0 ? (
          <div className="text-[13px] text-slate-400">No spending history in the selected window.</div>
        ) : (
          <>
            <ul className="divide-y divide-slate-100 text-[13px]">
              {forecast.projected.map((p) => (
                <li key={p.categoryId} className="flex items-center justify-between py-1">
                  <span className="truncate pr-3 text-slate-600">
                    {p.overridden && <span className="mr-1 text-emerald-600" title="Overridden">•</span>}
                    {p.categoryName}
                  </span>
                  {editing?.categoryId === p.categoryId ? (
                    <input
                      autoFocus
                      inputMode="decimal"
                      value={editing.value}
                      onChange={(e) => setEditing({ categoryId: p.categoryId, value: e.target.value })}
                      onBlur={(e) => commit(p.categoryId, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commit(p.categoryId, (e.currentTarget as HTMLInputElement).value)
                        else if (e.key === 'Escape') setEditing(null)
                      }}
                      className="tnum w-24 rounded border border-blue-400 px-1 py-0.5 text-right text-[13px] focus:outline-none"
                    />
                  ) : (
                    <button
                      onClick={() => setEditing({ categoryId: p.categoryId, value: String(-p.avg / 1000) })}
                      className={`tnum shrink-0 rounded px-1 py-0.5 text-right transition-colors hover:bg-slate-100 ${
                        p.overridden ? 'font-medium text-emerald-700' : 'text-slate-700'
                      }`}
                      title={p.overridden ? 'Overridden for this month — click to edit, clear to revert' : 'Click to edit projected expense'}
                    >
                      {fmt(-p.avg, c)}
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <div className="mt-1 flex items-center justify-between border-t border-slate-200 pt-1.5 text-[13px] font-medium">
              <span className="text-slate-500">Projected total</span>
              <span className="tnum text-slate-700">{fmt(projTotal, c)}</span>
            </div>
          </>
        )}
      </div>

      {/* Net */}
      <div className="mt-auto rounded-[10px] border border-slate-200 bg-slate-50 p-3">
        <div className="text-[11px] font-semibold tracking-[0.06em] text-slate-400 uppercase">Net</div>
        <div className={`tnum mt-1 text-xl font-semibold ${net < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{fmt(net, c)}</div>
        <div className="mt-0.5 text-[11px] text-slate-400">Known net − projected expenses</div>
      </div>
    </aside>
  )
}