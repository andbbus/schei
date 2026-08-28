import { useEffect, useState } from 'react'
import {
  ACTIONS,
  ACTION_ORDER,
  bindingKey,
  formatBinding,
  isApple,
  loadBindings,
  resetBindings,
  saveBindings,
  type ActionId,
  type Bindings,
} from '../shortcuts'
import Modal, { fieldLabel } from './Modal'

// Rebindable keyboard shortcuts, stored per browser (localStorage).
// Capture happens in a window capture-phase handler so the global bubble
// dispatcher never sees the keys while re-recording.
export default function ShortcutsModal({ onClose }: { onClose: () => void }) {
  const [bindings, setBindings] = useState<Bindings>(loadBindings)
  const [capturing, setCapturing] = useState<ActionId | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)

  useEffect(() => {
    if (!capturing) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopImmediatePropagation()
      const combo = bindingKey(e)
      if (!combo) return // bare modifier press — keep waiting
      if (combo === 'Escape') {
        setCapturing(null)
        setConflict(null)
        return
      }
      const clash = (Object.keys(bindings) as ActionId[]).find((id) => id !== capturing && bindings[id] === combo)
      if (clash) {
        setConflict(`“${formatBinding(combo, isApple())}” is already used by “${ACTIONS[clash].label}”.`)
        return
      }
      const next = { ...bindings, [capturing]: combo }
      setBindings(next)
      saveBindings(next)
      setCapturing(null)
      setConflict(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, bindings])

  const setBinding = (id: ActionId, combo: string | undefined) => {
    const next = { ...bindings }
    if (combo) next[id] = combo
    else delete next[id]
    setBindings(next)
    saveBindings(next)
  }

  const groups = ['General', 'Navigation'] as const
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} width={520}>
      <p className="mb-4 text-[12px] text-slate-500">
        Click a shortcut, then press the new key combination. Esc cancels. Shortcuts are stored per browser.
      </p>
      {conflict && <div className="mb-3 rounded bg-red-50 px-2.5 py-1.5 text-[12px] text-red-600">{conflict}</div>}
      {groups.map((g) => (
        <div key={g} className="mb-4">
          <div className={`mb-1.5 ${fieldLabel}`}>{g}</div>
          <div className="overflow-hidden rounded-lg border border-slate-200">
            {ACTION_ORDER.filter((id) => ACTIONS[id].group === g).map((id) => {
              const b = bindings[id]
              const rec = capturing === id
              return (
                <div key={id} className="flex items-center justify-between gap-3 border-b border-slate-100 px-3 py-2 last:border-0">
                  <span className="min-w-0 truncate text-[13px] text-slate-700">{ACTIONS[id].label}</span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <button
                      onClick={() => {
                        setCapturing(id)
                        setConflict(null)
                      }}
                      className={`tnum min-w-[76px] rounded border px-2 py-1 text-center text-[12px] font-medium transition-colors ${
                        rec
                          ? 'animate-pulse border-blue-300 bg-blue-50 text-blue-600'
                          : b
                            ? 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                            : 'border-dashed border-slate-200 text-slate-400 hover:bg-slate-50'
                      }`}
                      title={rec ? 'Press the new key combination' : 'Click to rebind'}
                    >
                      {rec ? 'Press keys…' : b ? formatBinding(b, isApple()) : '—'}
                    </button>
                    {b && (
                      <button
                        onClick={() => setBinding(id, undefined)}
                        title="Remove shortcut"
                        className="rounded px-1 text-slate-300 transition-colors hover:bg-slate-100 hover:text-slate-600"
                      >
                        ✕
                      </button>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      ))}
      <div className="flex justify-end">
        <button
          onClick={() => {
            setBindings(resetBindings())
            setCapturing(null)
            setConflict(null)
          }}
          className="rounded border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
        >
          Restore defaults
        </button>
      </div>
    </Modal>
  )
}
