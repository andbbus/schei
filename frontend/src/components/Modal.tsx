import { useEffect, type ReactNode } from 'react'

// Centered dialog shell — backdrop click / Esc to close. Used by every
// creation flow (transaction, account, category/group, shortcuts).
export default function Modal({
  title,
  onClose,
  width = 480,
  children,
}: {
  title: string
  onClose: () => void
  width?: number
  children: ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div
        className="relative z-10 flex max-h-[85vh] w-full flex-col rounded-xl border border-slate-200 bg-panel shadow-2xl"
        style={{ maxWidth: width }}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <h2 className="text-[15px] font-semibold text-slate-800">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded px-2 py-1 text-slate-400 hover:bg-slate-100">
            ✕
          </button>
        </div>
        <div className="overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  )
}

export const fieldLabel = 'text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-500'
export const fieldInput =
  'mt-1 w-full rounded border border-slate-200 bg-panel px-2.5 py-1.5 text-[13px] text-slate-800 placeholder:text-slate-400 focus:border-blue-300 focus:outline-none'
export const primaryBtn = 'rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50'
export const ghostBtn = 'rounded border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50'
