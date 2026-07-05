import { useState } from 'react'
import type { CategoryView, GroupView } from '../api'
import { fmt, parseAmount, type Currency } from '../format'

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
    const milli = parseAmount(amount)
    if (milli !== 0) onMove(toId, milli)
    onClose()
  }

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="absolute top-7 right-0 z-10 w-64 rounded-lg border border-slate-200 bg-white p-3 text-left shadow-lg"
    >
      <div className="mb-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">
        Move money — {fmt(cat.available, c)} available
      </div>
      <input
        autoFocus
        placeholder="Amount"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') onClose()
        }}
        className="tnum mb-2 w-full rounded border border-slate-300 px-2 py-1 text-sm"
      />
      <select
        value={toId}
        onChange={(e) => setToId(e.target.value)}
        className="mb-2 w-full rounded border border-slate-300 px-2 py-1 text-sm"
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
