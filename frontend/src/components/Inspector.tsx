import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { CategoryView, AutoAssignMode } from '../api'
import { api, errMsg } from '../api'
import { fmt, parseAmount, normalizeAmount, type Currency } from '../format'

const AUTO: { label: string; mode: AutoAssignMode }[] = [
  { label: 'Underfunded', mode: 'underfunded' },
  { label: 'Assigned Last Month', mode: 'assignedLastMonth' },
  { label: 'Spent Last Month', mode: 'spentLastMonth' },
  { label: 'Average Assigned', mode: 'averageAssigned' },
  { label: 'Average Spent', mode: 'averageSpent' },
  { label: 'Reset Available', mode: 'resetAvailable' },
  { label: 'Reset Assigned', mode: 'resetAssigned' },
]

export default function Inspector({
  month,
  selected,
  c,
  readyToAssign,
}: {
  month: string
  selected: CategoryView[]
  c: Currency
  readyToAssign: number
}) {
  const qc = useQueryClient()
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['month', month] })
    qc.invalidateQueries({ queryKey: ['budget'] })
    qc.invalidateQueries({ queryKey: ['ops'] })
  }
  const auto = useMutation({
    mutationFn: ({ ids, mode }: { ids: string[]; mode: AutoAssignMode }) => api.autoAssign(month, ids, mode),
    onSuccess: refresh,
  })

  if (selected.length === 0) {
    return (
      <div className="flex h-full w-[328px] shrink-0 flex-col gap-5 overflow-y-auto border-l border-slate-200 bg-panel p-5 shadow-[-8px_0_24px_-20px_rgba(16,24,40,0.4)]">
        <div className="text-[11px] font-semibold tracking-[0.06em] text-slate-400 uppercase">Ready to Assign</div>
        <div className={`tnum mt-1 text-2xl font-semibold ${readyToAssign < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
          {fmt(readyToAssign, c)}
        </div>
        <p className="mt-4 text-sm text-slate-500">
          Select a category to set a target, auto-assign, or add notes. Click the checkbox on multiple rows to
          auto-assign several at once.
        </p>
      </div>
    )
  }

  const ids = selected.map((s) => s.id)
  const single = selected.length === 1 ? selected[0] : null

  return (
    <div className="flex h-full w-[328px] shrink-0 flex-col gap-5 overflow-y-auto border-l border-slate-200 bg-panel p-5 shadow-[-8px_0_24px_-20px_rgba(16,24,40,0.4)]">
      {single ? (
        <div>
          <div className="text-[15px] font-semibold text-slate-800">{single.name}</div>
          <div className="mt-2 text-[11px] font-semibold tracking-[0.06em] text-slate-400 uppercase">Available</div>
          <div className={`tnum text-2xl font-semibold ${single.available < 0 ? 'text-red-600' : 'text-slate-800'}`}>
            {fmt(single.available, c)}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {fmt(single.assigned, c)} assigned · {fmt(single.activity, c)} activity
          </div>
        </div>
      ) : (
        <div className="text-[15px] font-semibold text-slate-800">{selected.length} categories selected</div>
      )}

      {single && <TargetEditor cat={single} c={c} onSaved={refresh} />}

      <div>
        <div className="mb-2 text-[11px] font-semibold tracking-[0.06em] text-slate-400 uppercase">Auto-Assign</div>
        <div className="grid grid-cols-2 gap-1.5">
          {AUTO.map((a) => (
            <button
              key={a.mode}
              onClick={() => auto.mutate({ ids, mode: a.mode })}
              className="rounded-md border border-slate-300 bg-panel px-2 py-1.5 text-[12px] text-slate-700 transition-colors hover:bg-slate-100"
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>

      {single && <Notes cat={single} onSaved={refresh} />}
      {single && <CategoryActions cat={single} onSaved={refresh} />}
    </div>
  )
}

function CategoryActions({ cat, onSaved }: { cat: CategoryView; onSaved: () => void }) {
  const qc = useQueryClient()
  const done = () => {
    qc.invalidateQueries({ queryKey: ['categories'] })
    onSaved()
  }
  const patch = useMutation({
    mutationFn: (b: Record<string, unknown>) => api.patchCategory(cat.id, b),
    onSuccess: done,
  })
  const del = useMutation({
    mutationFn: () => api.deleteCategory(cat.id),
    onSuccess: done,
    onError: (e: Error) => alert(errMsg(e)),
  })
  return (
    <div>
      <div className="mb-1 text-xs tracking-wide text-slate-400 uppercase">Category</div>
      <input
        key={cat.id}
        defaultValue={cat.name}
        onBlur={(e) => {
          const name = e.target.value.trim()
          if (name && name !== cat.name) patch.mutate({ name })
        }}
        className="mb-2 w-full rounded border border-slate-200 px-2 py-1 text-sm"
      />
      <div className="flex gap-1">
        <button
          onClick={() => patch.mutate({ hidden: !cat.hidden })}
          className="flex-1 rounded bg-slate-100 px-2 py-1 text-sm text-slate-600"
        >
          {cat.hidden ? 'Unhide' : 'Hide'}
        </button>
        <button onClick={() => del.mutate()} className="rounded bg-red-100 px-2 py-1 text-sm text-red-600">
          Delete
        </button>
      </div>
    </div>
  )
}

function TargetEditor({ cat, c, onSaved }: { cat: CategoryView; c: Currency; onSaved: () => void }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [type, setType] = useState(cat.goalType ?? 'MF')
  const [amount, setAmount] = useState(cat.goalTarget ? (cat.goalTarget / 1000).toString() : '')
  const [targetMonth, setTargetMonth] = useState(cat.goalTargetMonth ?? '')

  const save = useMutation({
    mutationFn: (b: Record<string, unknown>) => api.patchCategory(cat.id, b),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['budget'] })
      onSaved()
      setEditing(false)
    },
  })

  const t = cat.target
  if (!editing) {
    return (
      <div className="rounded border border-slate-200 p-3">
        <div className="mb-1 text-xs tracking-wide text-slate-400 uppercase">Target</div>
        {t.hasTarget ? (
          <>
            <div className="text-sm text-slate-700">
              {t.state === 'underfunded' ? (
                <span className="text-amber-700">Underfunded by {fmt(t.underfunded, c)}</span>
              ) : (
                <span className="text-emerald-700">Funded ✓</span>
              )}
            </div>
            <div className="mt-1 text-xs text-slate-500">Needs {fmt(t.neededThisMonth, c)} this month</div>
          </>
        ) : (
          <div className="text-sm text-slate-500">No target</div>
        )}
        <button onClick={() => setEditing(true)} className="mt-2 text-xs text-blue-600 hover:underline">
          {t.hasTarget ? 'Edit Target' : 'Create Target'}
        </button>
      </div>
    )
  }

  return (
    <div className="rounded border border-blue-300 p-3">
      <div className="mb-2 text-xs tracking-wide text-slate-400 uppercase">Target</div>
      <select value={type} onChange={(e) => setType(e.target.value)} className="mb-2 w-full rounded border border-slate-300 px-2 py-1 text-sm">
        <option value="MF">Monthly — refill up to</option>
        <option value="NEED">Needed for spending (monthly)</option>
        <option value="TB">Have a balance of</option>
        <option value="TBD">Have a balance by date</option>
      </select>
      <input
        placeholder="Amount"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        onBlur={(e) => setAmount(normalizeAmount(e.target.value))}
        className="mb-2 w-full rounded border border-slate-300 px-2 py-1 text-sm"
      />
      {type === 'TBD' && (
        <input
          type="month"
          value={targetMonth ? targetMonth.slice(0, 7) : ''}
          onChange={(e) => setTargetMonth(`${e.target.value}-01`)}
          className="mb-2 w-full rounded border border-slate-300 px-2 py-1 text-sm"
        />
      )}
      <div className="flex gap-1">
        <button
          onClick={() =>
            save.mutate({
              goalType: type,
              goalTarget: parseAmount(amount),
              goalCadence: type === 'MF' ? 'monthly' : type === 'NEED' ? 'monthly' : type === 'TBD' ? 'byDate' : null,
              goalTargetMonth: type === 'TBD' ? targetMonth : null,
              goalNeedsWholeAmount: true,
            })
          }
          className="flex-1 rounded bg-positive px-2 py-1 text-sm text-white"
        >
          Save
        </button>
        {cat.target.hasTarget && (
          <button
            onClick={() => save.mutate({ goalType: null, goalTarget: null, goalCadence: null, goalTargetMonth: null })}
            className="rounded bg-slate-100 px-2 py-1 text-sm text-slate-600"
          >
            Delete
          </button>
        )}
        <button onClick={() => setEditing(false)} className="rounded bg-slate-100 px-2 py-1 text-sm text-slate-600">
          Cancel
        </button>
      </div>
    </div>
  )
}

function Notes({ cat, onSaved }: { cat: CategoryView; onSaved: () => void }) {
  const [note, setNote] = useState(cat.note ?? '')
  const save = useMutation({
    mutationFn: () => api.patchCategory(cat.id, { note }),
    onSuccess: onSaved,
  })
  return (
    <div>
      <div className="mb-1 text-xs tracking-wide text-slate-400 uppercase">Notes</div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => note !== (cat.note ?? '') && save.mutate()}
        rows={3}
        className="w-full rounded border border-slate-200 p-2 text-sm"
        placeholder="Add a note…"
      />
    </div>
  )
}
