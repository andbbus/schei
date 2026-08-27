import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, errMsg } from '../api'

function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export default function HistoryMenu() {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const { data: ops } = useQuery({ queryKey: ['ops'], queryFn: api.ops })
  const undo = useMutation({
    mutationFn: (id: number) => api.undoOp(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ops'] })
      qc.invalidateQueries({ queryKey: ['budget'] })
      qc.invalidateQueries({ queryKey: ['month'] })
      qc.invalidateQueries({ queryKey: ['categories'] })
      qc.invalidateQueries({ queryKey: ['txns'] })
    },
    onError: (e: Error) => alert(errMsg(e)),
  })

  return (
    <div className="fixed top-20 right-4 z-40">
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded-full border border-slate-200 bg-panel px-3 py-1.5 text-sm text-slate-600 shadow-sm hover:bg-slate-50"
        title="Recent actions (undo)"
      >
        🕘{ops && ops.length > 0 ? ` ${ops.length}` : ''}
      </button>
      {open && (
        <>
          <div className="fixed inset-0" onClick={() => setOpen(false)} />
          <div className="absolute top-full right-0 mt-1 w-80 rounded-lg border border-slate-200 bg-panel py-1 shadow-lg">
            <div className="border-b border-slate-100 px-3 py-1.5 text-[11px] tracking-wide text-slate-400 uppercase">
              Recent actions
            </div>
            {ops?.length === 0 && <div className="px-3 py-3 text-sm text-slate-400">Nothing to undo.</div>}
            {ops?.map((o) => (
              <div key={o.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <span className="min-w-0 flex-1 truncate text-slate-700" title={o.summary}>
                  {o.summary}
                </span>
                <span className="shrink-0 text-[11px] text-slate-400">{timeAgo(o.createdAt)}</span>
                <button
                  onClick={() => undo.mutate(o.id)}
                  disabled={undo.isPending}
                  className="shrink-0 rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-200 disabled:opacity-50"
                >
                  Undo
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
