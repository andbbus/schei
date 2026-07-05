import { useState } from 'react'
import type { CategoryView, GroupView } from '../api'
import { fmt, parseAmount, type Currency } from '../format'
import { availablePill } from './pills'
import MoveMoneyPopover from './MoveMoneyPopover'

function focusNextAssign(el: HTMLInputElement) {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input.assign-input'))
  const i = inputs.indexOf(el)
  if (i >= 0 && i < inputs.length - 1) {
    inputs[i + 1].focus()
    inputs[i + 1].select()
  } else {
    el.blur()
  }
}

export default function CategoryRow({
  cat,
  c,
  groups,
  selected,
  onSelect,
  onAssign,
  onMove,
}: {
  cat: CategoryView
  c: Currency
  groups: GroupView[]
  selected: boolean
  onSelect: (id: string, additive: boolean) => void
  onAssign: (id: string, milli: number) => void
  onMove: (fromId: string, toId: string, amount: number) => void
}) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState('')
  const [moving, setMoving] = useState(false)

  const startEdit = () => {
    setVal((cat.assigned / 1000).toLocaleString(c.locale, { useGrouping: false, maximumFractionDigits: c.digits }))
    setEditing(true)
  }
  const commit = () => {
    const milli = parseAmount(val)
    if (milli !== cat.assigned) onAssign(cat.id, milli)
    setEditing(false)
  }

  const t = cat.target
  return (
    <div
      data-cat-row
      onClick={() => onSelect(cat.id, false)}
      className={`grid grid-cols-[28px_1fr_130px_130px_150px] items-center border-b border-slate-100 px-2 text-[13px] hover:bg-slate-50 ${
        selected ? 'bg-blue-50' : ''
      }`}
    >
      <div className="flex justify-center" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={selected} onChange={() => onSelect(cat.id, true)} className="accent-blue-600" />
      </div>

      <div className="min-w-0 py-1.5">
        <div className={`truncate ${cat.hidden ? 'text-slate-400 italic' : 'text-slate-800'}`}>
          {cat.name}
          {cat.hidden ? ' (hidden)' : ''}
        </div>
        {t?.hasTarget && (
          <div className="mt-0.5 h-1 w-40 max-w-full overflow-hidden rounded-full bg-slate-200">
            <div
              className={`h-full ${t.state === 'underfunded' ? 'bg-amber-400' : 'bg-emerald-500'}`}
              style={{ width: `${Math.round(t.progress * 100)}%` }}
            />
          </div>
        )}
      </div>

      <div className="px-2 text-right" onClick={(e) => e.stopPropagation()}>
        {editing ? (
          <input
            autoFocus
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
                focusNextAssign(e.currentTarget)
              } else if (e.key === 'Escape') {
                setEditing(false)
              }
            }}
            className="assign-input tnum w-24 rounded border border-blue-400 px-1 py-0.5"
          />
        ) : (
          <button onClick={startEdit} className="tnum w-24 rounded px-1 py-0.5 text-right hover:bg-slate-200">
            {fmt(cat.assigned, c)}
          </button>
        )}
      </div>

      <div className={`tnum px-2 text-right ${cat.activity < 0 ? 'text-slate-600' : 'text-emerald-700'}`}>
        {fmt(cat.activity, c)}
      </div>

      <div className="relative flex justify-end px-2" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={() => setMoving((m) => !m)}
          className={`tnum rounded-full px-2 py-0.5 text-[12px] font-medium ${availablePill(cat.available, t, cat.overspendType)}`}
          title="Move money"
        >
          {fmt(cat.available, c)}
        </button>
        {moving && (
          <MoveMoneyPopover
            cat={cat}
            groups={groups}
            c={c}
            onMove={(toId, amount) => onMove(cat.id, toId, amount)}
            onClose={() => setMoving(false)}
          />
        )}
      </div>
    </div>
  )
}
