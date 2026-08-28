// Global keyboard shortcuts: pure definitions + persistence.
// App.tsx runs one central keydown dispatcher; actions either broadcast a
// window CustomEvent (components subscribe) or navigate directly.

export type ActionId =
  | 'palette'
  | 'addTransaction'
  | 'undo'
  | 'shortcuts'
  | 'goto-budget'
  | 'goto-accounts'
  | 'goto-reflect'
  | 'goto-debts'
  | 'goto-goals'
  | 'goto-subscriptions'
  | 'goto-calendar'
  | 'goto-shopping'
  | 'goto-assistant'

export interface ActionDef {
  label: string
  group: 'General' | 'Navigation'
  /** fires even while the focus sits in an input/textarea/select */
  allowInInput?: boolean
  /** navigation actions */
  path?: string
  /** actions that broadcast a window CustomEvent */
  event?: string
}

export const ACTIONS: Record<ActionId, ActionDef> = {
  palette: { label: 'Command palette', group: 'General', allowInInput: true, event: 'schei:palette' },
  addTransaction: { label: 'Add transaction', group: 'General', event: 'schei:add-txn' },
  undo: { label: 'Undo last change', group: 'General' },
  shortcuts: { label: 'Customize shortcuts', group: 'General', event: 'schei:shortcuts' },
  'goto-budget': { label: 'Go to Budget', group: 'Navigation', path: '/' },
  'goto-accounts': { label: 'Go to Accounts', group: 'Navigation', path: '/accounts' },
  'goto-reflect': { label: 'Go to Reflect', group: 'Navigation', path: '/reflect' },
  'goto-debts': { label: 'Go to Debts', group: 'Navigation', path: '/debts' },
  'goto-goals': { label: 'Go to Goals', group: 'Navigation', path: '/goals' },
  'goto-subscriptions': { label: 'Go to Subscriptions', group: 'Navigation', path: '/subscriptions' },
  'goto-calendar': { label: 'Go to Calendar', group: 'Navigation', path: '/calendar' },
  'goto-shopping': { label: 'Go to Shopping', group: 'Navigation', path: '/shopping' },
  'goto-assistant': { label: 'Go to Assistant', group: 'Navigation', path: '/assistant' },
}

export const ACTION_ORDER: ActionId[] = Object.keys(ACTIONS) as ActionId[]

export const DEFAULT_BINDINGS: Partial<Record<ActionId, string>> = {
  palette: 'mod+k',
  addTransaction: 'n',
  undo: 'mod+z',
  shortcuts: '?',
}

const STORAGE_KEY = 'schei.shortcuts.v1'

export type Bindings = Partial<Record<ActionId, string>>

export function loadBindings(): Bindings {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>
    const out: Bindings = { ...DEFAULT_BINDINGS }
    for (const [k, v] of Object.entries(raw)) {
      if (k in ACTIONS && typeof v === 'string' && v) out[k as ActionId] = v
    }
    return out
  } catch {
    return { ...DEFAULT_BINDINGS }
  }
}

export function saveBindings(b: Bindings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(b))
  } catch {
    // storage unavailable (private mode) — shortcuts work for the session only
  }
}

export function resetBindings(): Bindings {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
  return { ...DEFAULT_BINDINGS }
}

export interface KeyEventLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

// Normalizes a keydown to "mod+alt+shift+<key>"; null for bare modifier presses.
// meta and ctrl are treated as the same "mod" so bindings work on both platforms.
export function bindingKey(e: KeyEventLike): string | null {
  const key = e.key
  if (['Meta', 'Control', 'Alt', 'Shift', 'Dead', 'Unidentified'].includes(key)) return null
  const mod = e.metaKey || e.ctrlKey
  const base = key.toLowerCase()
  // punctuation like '?' already encodes shift; only letters/digits keep an
  // explicit shift marker so 'shift+n' ≠ 'n'
  let shift = e.shiftKey
  if (shift && key.length === 1 && !/[a-z0-9]/i.test(key)) shift = false
  const parts: string[] = []
  if (mod) parts.push('mod')
  if (e.altKey) parts.push('alt')
  if (shift) parts.push('shift')
  parts.push(base)
  return parts.join('+')
}

export function matchBinding(e: KeyEventLike, binding: string): boolean {
  return bindingKey(e) === binding
}

const APPLE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

export function isApple(): boolean {
  return APPLE
}

// "mod+k" → "⌘K" (Apple) / "Ctrl+K" elsewhere.
export function formatBinding(b: string, apple = APPLE): string {
  const names: Record<string, string> = {
    mod: apple ? '⌘' : 'Ctrl',
    alt: apple ? '⌥' : 'Alt',
    shift: apple ? '⇧' : 'Shift',
    escape: 'Esc',
    ' ': 'Space',
    arrowup: '↑',
    arrowdown: '↓',
    arrowleft: '←',
    arrowright: '→',
    enter: '↵',
  }
  const parts = b.split('+')
  const key = parts.pop() as string
  const mods = parts.map((p) => names[p] ?? p)
  const keyName = names[key.toLowerCase()] ?? (key.length === 1 ? key.toUpperCase() : key)
  return apple ? `${mods.join('')}${keyName}` : [...mods, keyName].join('+')
}

// Duck-typed so it works without a DOM reference (tests, iframes).
export function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as { tagName?: unknown; isContentEditable?: unknown } | null
  if (!el || typeof el.tagName !== 'string') return false
  return (
    el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable === true
  )
}
