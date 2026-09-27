import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  buildPickerOptions,
  filterPickerOptions,
  matchTransferName,
  transferLabel,
  type PickerAccount,
  type PickerPayee,
} from '../lib/payeePicker'

// Typeahead for the register's payee field. Unlike a bare <datalist> this
// shows a real menu grouped into "Transfer to / from" (the user's other
// accounts) and "Payees", filters as you type, and survives a typed transfer
// name — picking an account is what turns the entry into a mirrored transfer.
//
// It is fully controlled: `value` is the displayed text, `transferAccountId`
// is the resolved counterparty (null for a plain payee). Both are reported
// together through `onChange`.

export interface PayeeSelection {
  payee: string
  transferAccountId: string | null
}

export default function PayeeInput({
  value,
  transferAccountId,
  onChange,
  payees,
  accounts,
  excludeAccountId,
  disabled = false,
  autoFocus = false,
  placeholder = 'Payee or account…',
  inputClassName = '',
  onBlur,
  onEnter,
}: {
  value: string
  transferAccountId: string | null
  onChange: (next: PayeeSelection) => void
  payees: PickerPayee[]
  accounts: PickerAccount[]
  excludeAccountId?: string
  disabled?: boolean
  autoFocus?: boolean
  placeholder?: string
  inputClassName?: string
  onBlur?: () => void
  onEnter?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const options = useMemo(
    () => buildPickerOptions(payees, accounts, { excludeAccountId }),
    [payees, accounts, excludeAccountId],
  )
  const selected = transferAccountId ? accounts.find((a) => a.id === transferAccountId) : undefined
  // While a chosen transfer is displayed, don't filter the menu down to its own
  // name — show the full list again so switching is one click away.
  const query = selected && value === transferLabel(selected) ? '' : value
  const filtered = useMemo(() => filterPickerOptions(options, query), [options, query])

  const reposition = () => {
    const r = inputRef.current?.getBoundingClientRect()
    if (r) setRect({ left: r.left, top: r.bottom + 4, width: r.width })
  }

  const openMenu = () => {
    if (disabled) return
    setHighlight(-1)
    setOpen(true)
  }

  // Measure after commit: with autoFocus, onFocus fires before inputRef is
  // attached, so measuring in openMenu left the menu unpositioned.
  useLayoutEffect(() => {
    if (open) reposition()
  }, [open])

  // Keep the fixed menu glued to the input while the dialog scrolls/resizes.
  useEffect(() => {
    if (!open) return
    const update = () => reposition()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDocDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close(false)
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, value, transferAccountId])

  useEffect(() => {
    if (!open) return
    rootRef.current
      ?.querySelector(`[data-idx="${highlight}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [highlight, open])

  // A hand-typed "Transfer : <account>" should behave like picking it: resolve
  // to the account on blur/Enter so the mirror is still created.
  const commit = () => {
    const acc = matchTransferName(value, accounts, { excludeAccountId })
    if (acc && transferAccountId !== acc.id) onChange({ payee: transferLabel(acc), transferAccountId: acc.id })
  }

  const close = (runBlur: boolean) => {
    setOpen(false)
    commit()
    if (runBlur) onBlur?.()
  }

  const select = (idx: number) => {
    const o = filtered[idx]
    if (!o) return
    onChange(o.kind === 'account' ? { payee: o.value, transferAccountId: o.id } : { payee: o.name, transferAccountId: null })
    setOpen(false)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) return openMenu()
      setHighlight((h) => Math.min(h + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) return openMenu()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      if (open && highlight >= 0 && filtered[highlight]) {
        e.preventDefault()
        select(highlight)
      } else if (open) {
        // nothing highlighted → don't hijack Enter; close and let it fall
        // through (submit the dialog form, or run onEnter)
        close(false)
        if (onEnter) {
          e.preventDefault()
          onEnter()
          inputRef.current?.blur()
        }
      } else if (onEnter) {
        e.preventDefault()
        onEnter()
        inputRef.current?.blur()
      }
      // menu closed without onEnter → let Enter fall through (form submit)
    } else if (e.key === 'Escape' && open) {
      e.stopPropagation()
      e.preventDefault()
      setOpen(false)
    } else if (e.key === 'Tab' && open) {
      setOpen(false)
    }
  }

  const menu = open && (
    <div
      role="listbox"
      className="fixed z-[80] max-h-64 min-w-56 overflow-y-auto rounded-lg border border-slate-200 bg-panel py-1 shadow-2xl"
      style={{ left: rect?.left, top: rect?.top, width: rect?.width }}
    >
      {filtered.length === 0 && (
        <div className="px-3 py-2 text-[12px] text-slate-400">No matches — type to create a new payee.</div>
      )}
      {filtered.map((o, i) => (
        <div key={`${o.kind}:${o.id}`}>
          {(i === 0 || filtered[i - 1].kind !== o.kind) && (
            <div className="px-3 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-slate-400">
              {o.kind === 'account' ? 'Transfer to / from' : 'Payees'}
            </div>
          )}
          <button
            type="button"
            data-idx={i}
            role="option"
            aria-selected={i === highlight}
            onMouseDown={(e) => {
              e.preventDefault()
              select(i)
            }}
            onMouseEnter={() => setHighlight(i)}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] ${
              i === highlight ? 'bg-blue-50 text-slate-900' : 'text-slate-700'
            }`}
          >
            {o.kind === 'account' ? (
              <>
                <span className="text-slate-400">⇄</span>
                <span className="truncate">{o.name}</span>
                <span className="ml-auto text-[10px] uppercase tracking-wide text-slate-400">transfer</span>
              </>
            ) : (
              <span className="truncate">{o.label}</span>
            )}
          </button>
        </div>
      ))}
    </div>
  )

  return (
    <div ref={rootRef} className="relative">
      <input
        ref={inputRef}
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder}
        className={inputClassName}
        onChange={(e) => {
          onChange({ payee: e.target.value, transferAccountId: null })
          if (!open) openMenu()
          else setHighlight(0)
        }}
        onFocus={(e) => {
          e.target.select()
          openMenu()
        }}
        onBlur={() => close(true)}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
      />
      {menu}
    </div>
  )
}
