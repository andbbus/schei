import { useState } from 'react'
import { THEMES, getTheme, setTheme, type ThemeId } from '../lib/theme'

export default function OptionsModal({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState<ThemeId>(() => getTheme())

  const pick = (id: ThemeId) => {
    setTheme(id)
    setCurrent(id)
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative z-10 flex max-h-[85vh] w-[520px] flex-col rounded-lg border border-slate-200 bg-panel p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-slate-800">Options</h2>
          <button onClick={onClose} className="rounded px-2 py-1 text-slate-400 hover:bg-slate-100">
            ✕
          </button>
        </div>

        <div className="mb-2 text-xs font-semibold tracking-[0.06em] text-slate-500 uppercase">Theme</div>
        <div className="grid grid-cols-2 gap-2">
          {THEMES.map((t) => {
            const active = t.id === current
            return (
              <button
                key={t.id}
                onClick={() => pick(t.id)}
                aria-pressed={active}
                data-theme={t.id}
                className={`flex items-center gap-3 rounded-md border p-2.5 text-left transition-colors ${
                  active ? 'border-accent ring-1 ring-blue-400' : 'border-slate-200 hover:bg-slate-100'
                }`}
              >
                {/* swatch strip drawn with the theme's own tokens */}
                <span data-theme={t.id} className="flex h-9 shrink-0 items-center gap-1 rounded border border-slate-300 bg-slate-50 px-1.5">
                  <span className="h-4 w-4 rounded-sm border border-slate-300" style={{ background: 'var(--acc-mid)' }} />
                  <span className="h-4 w-4 rounded-sm" style={{ background: 'var(--pos-solid)' }} />
                  <span className="h-4 w-4 rounded-sm" style={{ background: 'var(--neg-solid)' }} />
                  <span className="tnum text-[10px]" style={{ color: 'var(--t800)' }}>
                    €1k
                  </span>
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium text-slate-700">{t.name}</span>
                  <span className="block text-[11px] text-slate-500">{t.note}</span>
                </span>
                {active && <span className="ml-auto text-blue-600">●</span>}
              </button>
            )
          })}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          The theme applies instantly and is remembered for this browser (localStorage). Printing always uses a light ink
          layout regardless of the active theme.
        </p>
      </div>
    </div>
  )
}
