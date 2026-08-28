import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import type { BudgetMeta } from '../api'
import { api, errMsg } from '../api'
import { THEMES, setTheme, getTheme } from '../lib/theme'
import { undoLastChange } from '../lib/undo'
import { formatBinding, isApple, loadBindings, type ActionId } from '../shortcuts'

// Cmd+K / Ctrl+K command palette: navigation, theme switching, undo, digest.
// LazyVim-style: keyboard-first, fuzzy-filtered, arrow keys + Enter.

interface Cmd {
  id: string
  label: string
  hint?: string
  keywords?: string
  run: () => void | Promise<void>
}

function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (!q) return 1
  let qi = 0
  let score = 0
  let streak = 0
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      streak++
      score += 1 + streak * 0.5 + (i === 0 ? 1 : 0)
      qi++
    } else streak = 0
  }
  return qi === q.length ? score : 0
}

export default function CommandPalette({ meta }: { meta: BudgetMeta }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Opened by the central shortcut dispatcher (App.tsx) — the palette
  // shortcut itself is rebindable in the ShortcutsModal.
  useEffect(() => {
    const onToggle = () => {
      setOpen((v) => !v)
      setQuery('')
      setCursor(0)
      setError(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('schei:palette', onToggle)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('schei:palette', onToggle)
      document.removeEventListener('keydown', onKey)
    }
  }, [])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const commands = useMemo<Cmd[]>(() => {
    const go = (to: string) => () => {
      navigate(to)
      setOpen(false)
    }
    const dispatch = (event: string) => () => {
      window.dispatchEvent(new CustomEvent(event))
      setOpen(false)
    }
    const bindingHint = (id: ActionId) => {
      const b = loadBindings()[id]
      return b ? formatBinding(b, isApple()) : undefined
    }
    const cmds: Cmd[] = [
      { id: 'add-transaction', label: 'Add transaction', hint: bindingHint('addTransaction'), keywords: 'new expense income quick entry', run: dispatch('schei:add-txn') },
      { id: 'nav-budget', label: 'Go to Budget', keywords: 'home', run: go('/') },
      { id: 'nav-accounts', label: 'Go to Accounts', keywords: 'overview balances', run: go('/accounts') },
      { id: 'nav-reflect', label: 'Go to Reflect', keywords: 'reports charts', run: go('/reflect') },
      { id: 'nav-calendar', label: 'Go to Calendar', keywords: 'scheduled upcoming', run: go('/calendar') },
      { id: 'nav-subscriptions', label: 'Go to Subscriptions', keywords: 'recurring', run: go('/subscriptions') },
      { id: 'nav-debts', label: 'Go to Debts', keywords: 'loans amortization', run: go('/debts') },
      { id: 'nav-goals', label: 'Go to Goals', keywords: 'savings', run: go('/goals') },
      { id: 'nav-shopping', label: 'Go to Shopping', keywords: 'groceries lists', run: go('/shopping') },
      { id: 'nav-assistant', label: 'Go to Assistant', keywords: 'ai chat', run: go('/assistant') },
      { id: 'customize-shortcuts', label: 'Customize shortcuts', hint: bindingHint('shortcuts'), keywords: 'keyboard keys bindings hotkeys settings', run: dispatch('schei:shortcuts') },
    ]
    for (const a of meta.accounts) {
      cmds.push({ id: `acct-${a.id}`, label: `Go to ${a.name}`, hint: a.onBudget ? 'account' : 'tracking', run: go(`/accounts/${a.id}`) })
    }
    for (const t of THEMES) {
      cmds.push({
        id: `theme-${t.id}`,
        label: `Theme: ${t.name}`,
        hint: t.id === getTheme() ? 'current' : undefined,
        keywords: 'appearance color dark light',
        run: () => {
          setTheme(t.id)
          setOpen(false)
        },
      })
    }
    cmds.push({
      id: 'undo',
      label: 'Undo last change',
      hint: bindingHint('undo'),
      keywords: 'history revert',
      run: async () => {
        await undoLastChange(qc)
        setOpen(false)
      },
    })
    cmds.push({
      id: 'digest',
      label: 'Send weekly digest email',
      keywords: 'report mail summary',
      run: async () => {
        try {
          const r = await api.sendDigest()
          setOpen(false)
          alert(`Digest sent via ${r.channel} to ${r.to}`)
        } catch (e) {
          setError(errMsg(e as Error))
        }
      },
    })
    return cmds
  }, [meta, navigate, qc])

  const filtered = useMemo(() => {
    return commands
      .map((c) => ({ c, s: Math.max(fuzzyScore(query, c.label), fuzzyScore(query, c.keywords ?? '') * 0.4) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 9)
      .map((x) => x.c)
  }, [commands, query])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh]" onClick={() => setOpen(false)}>
      <div className="absolute inset-0 bg-black/30" />
      <div
        className="relative z-10 w-[520px] overflow-hidden rounded-xl border border-slate-200 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setCursor(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setCursor((c) => Math.min(c + 1, filtered.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setCursor((c) => Math.max(c - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              filtered[cursor]?.run()
            }
          }}
          placeholder="Type a command…"
          className="w-full border-b border-slate-200 bg-transparent px-4 py-3 text-[14px] text-slate-800 placeholder:text-slate-400 focus:outline-none"
        />
        {error && <div className="mx-3 mt-2 rounded bg-red-50 px-2 py-1.5 text-[11px] text-red-600">{error}</div>}
        <div className="max-h-[320px] overflow-y-auto p-1.5">
          {filtered.length === 0 && <div className="px-3 py-4 text-center text-[13px] text-slate-400">No matching commands.</div>}
          {filtered.map((c, i) => (
            <button
              key={c.id}
              onClick={() => c.run()}
              onMouseEnter={() => setCursor(i)}
              className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-[13px] transition-colors ${
                i === cursor ? 'bg-slate-100 text-slate-900' : 'text-slate-600'
              }`}
            >
              <span className="font-medium">{c.label}</span>
              {c.hint && <span className="text-[11px] text-slate-400">{c.hint}</span>}
            </button>
          ))}
        </div>
        <div className="border-t border-slate-200 px-3 py-1.5 text-[10px] text-slate-400">↑↓ navigate · ↵ run · esc close</div>
      </div>
    </div>
  )
}
