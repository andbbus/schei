import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  ACTIONS,
  DEFAULT_BINDINGS,
  bindingKey,
  formatBinding,
  isEditableTarget,
  loadBindings,
  matchBinding,
  resetBindings,
  saveBindings,
  type ActionId,
} from './shortcuts'

// node-env friendly localStorage shim (shortcuts.ts touches it lazily)
const store = new Map<string, string>()
beforeAll(() => {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
})

const ev = (key: string, m: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key,
  metaKey: m.metaKey ?? false,
  ctrlKey: m.ctrlKey ?? false,
  altKey: m.altKey ?? false,
  shiftKey: m.shiftKey ?? false,
})

describe('bindingKey', () => {
  it('normalizes plain keys lowercased', () => {
    expect(bindingKey(ev('n'))).toBe('n')
    expect(bindingKey(ev('N', { shiftKey: true }))).toBe('shift+n')
    expect(bindingKey(ev('?'))).toBe('?')
    expect(bindingKey(ev('?', { shiftKey: true }))).toBe('?')
  })
  it('treats meta and ctrl as mod', () => {
    expect(bindingKey(ev('k', { metaKey: true }))).toBe('mod+k')
    expect(bindingKey(ev('k', { ctrlKey: true }))).toBe('mod+k')
    expect(bindingKey(ev('z', { ctrlKey: true }))).toBe('mod+z')
    expect(bindingKey(ev('N', { ctrlKey: true, shiftKey: true }))).toBe('mod+shift+n')
  })
  it('includes alt and orders modifiers', () => {
    expect(bindingKey(ev('t', { metaKey: true, altKey: true }))).toBe('mod+alt+t')
    expect(bindingKey(ev('a', { altKey: true }))).toBe('alt+a')
  })
  it('returns null for bare modifier presses and junk', () => {
    expect(bindingKey(ev('Meta'))).toBeNull()
    expect(bindingKey(ev('Control'))).toBeNull()
    expect(bindingKey(ev('Shift'))).toBeNull()
    expect(bindingKey(ev('Alt'))).toBeNull()
    expect(bindingKey(ev('Dead'))).toBeNull()
  })
  it('keeps named keys lowercased', () => {
    expect(bindingKey(ev('Escape'))).toBe('escape')
    expect(bindingKey(ev('ArrowDown'))).toBe('arrowdown')
  })
})

describe('matchBinding', () => {
  it('matches defaults against synthetic events', () => {
    expect(matchBinding(ev('k', { metaKey: true }), DEFAULT_BINDINGS.palette!)).toBe(true)
    expect(matchBinding(ev('n'), DEFAULT_BINDINGS.addTransaction!)).toBe(true)
    expect(matchBinding(ev('n', { metaKey: true }), DEFAULT_BINDINGS.addTransaction!)).toBe(false)
    expect(matchBinding(ev('/', { shiftKey: true }), '?')).toBe(false) // '?' ≠ shift+/
  })
})

describe('formatBinding', () => {
  it('renders apple and pc styles', () => {
    expect(formatBinding('mod+k', true)).toBe('⌘K')
    expect(formatBinding('mod+k', false)).toBe('Ctrl+K')
    expect(formatBinding('n', true)).toBe('N')
    expect(formatBinding('shift+n', false)).toBe('Shift+N')
    expect(formatBinding('?', true)).toBe('?')
    expect(formatBinding('mod+alt+t', true)).toBe('⌘⌥T')
    expect(formatBinding('Escape', false)).toBe('Esc')
  })
})

describe('binding persistence', () => {
  it('defaults, overrides, validation and reset round-trip', () => {
    localStorage.removeItem('schei.shortcuts.v1')
    expect(loadBindings()).toMatchObject(DEFAULT_BINDINGS)

    saveBindings({ ...loadBindings(), addTransaction: 't' })
    expect(loadBindings().addTransaction).toBe('t')
    expect(loadBindings().palette).toBe(DEFAULT_BINDINGS.palette)

    // unknown actions and junk entries are dropped
    localStorage.setItem('schei.shortcuts.v1', JSON.stringify({ bogus: 'x', palette: 42, addTransaction: 'y' }))
    expect(loadBindings()).toMatchObject({ palette: DEFAULT_BINDINGS.palette, addTransaction: 'y' })

    localStorage.setItem('schei.shortcuts.v1', 'not json')
    expect(loadBindings()).toMatchObject(DEFAULT_BINDINGS)

    saveBindings({ ...loadBindings(), addTransaction: 'e' })
    expect(resetBindings().addTransaction).toBe(DEFAULT_BINDINGS.addTransaction)
    expect(loadBindings().addTransaction).toBe(DEFAULT_BINDINGS.addTransaction)
  })
})

describe('action catalog', () => {
  it('every action is labelled and in a known group; nav actions navigate', () => {
    for (const id of Object.keys(ACTIONS) as ActionId[]) {
      const def = ACTIONS[id]
      expect(def.label.length).toBeGreaterThan(0)
      expect(['General', 'Navigation']).toContain(def.group)
      if (def.group === 'Navigation') {
        expect(def.path).toBeTruthy()
        expect(id.startsWith('goto-')).toBe(true)
      }
    }
  })
})

describe('isEditableTarget', () => {
  it('detects editable elements', () => {
    expect(isEditableTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true)
    expect(isEditableTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true)
    expect(isEditableTarget({ tagName: 'SELECT' } as unknown as EventTarget)).toBe(true)
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true)
    expect(isEditableTarget({ tagName: 'DIV' } as unknown as EventTarget)).toBe(false)
    expect(isEditableTarget({ tagName: 42 } as unknown as EventTarget)).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})
