import { useState } from 'react'
import type { CategoryView, GroupView } from '../api'
import { fmt, parseAmount, normalizeAmount, type Currency } from '../format'

// Small popover under the available pill: move money from this category to
// another one (or back to Ready to Assign).
export default function MoveMoneyPopover({
  cat,
  groups,
  c,
  onMove,
  onClose,
}: {
  cat: CategoryView
  groups: GroupView[]
  c: Currency
  onMove: (toId: string, amount: number) => void
  onClose: () => void
}) {
  const [amount, setAmount] = useState(cat.available > 0 ? (cat.available / 1000).toString() : '')
  const [toId, setToId] = useState('rta')

  const submit = () => {
    const milli = parseAmount(normalizeAmount(amount))
    if (milli !== 0) onMove(toId, milli)
    onClose()
  }

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="absolute top-7 right-0 z-10 flex w-[296px] flex-col gap-3 rounded-[10px] border border-slate-200 bg-white p-4 text-left shadow-[var(--elev-popover)] animate-[pop-in_180ms_cubic-bezier(0.2,0,0,1)]"
    >
      <div className="mb-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">
        Move money — {fmt(cat.available, c)} available
      </div>
      <input
        autoFocus
        placeholder="Amount"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        onBlur={(e) => setAmount(normalizeAmount(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') onClose()
        }}
        className="tnum mb-2 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 transition-colors placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/35"
      />
      <select
        value={toId}
        onChange={(e) => setToId(e.target.value)}
        className="mb-2 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 transition-colors focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/35"
      >
        <option value="rta">Ready to Assign</option>
        {groups.map((g) => (
          <optgroup key={g.id} label={g.name}>
            {g.categories
              .filter((x) => x.id !== cat.id)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      <div className="flex gap-1">
        <button onClick={submit} className="flex-1 rounded bg-emerald-500 px-2 py-1 text-sm text-white">
          Move
        </button>
        <button onClick={onClose} className="rounded bg-slate-100 px-2 py-1 text-sm text-slate-600">
          Cancel
        </button>
      </div>
    </div>
  )
}
