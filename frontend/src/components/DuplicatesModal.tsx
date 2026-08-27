import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, errMsg } from '../api'
import { fmt, dateDisplay, type Currency } from '../format'

// Groups of transactions that share the same account, date, |amount| and
// payee — likely double imports. Deleting goes through the bulk endpoint, so
// every row is undoable from the history menu.
export default function DuplicatesModal({
  accountId,
  c,
  onClose,
}: {
  accountId: string
  c: Currency
  onClose: () => void
}) {
  const qc = useQueryClient()
  const { data: groups, isFetching } = useQuery({
    queryKey: ['duplicates', accountId],
    queryFn: () => api.duplicates(accountId),
  })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const toggleGroup = (ids: string[]) =>
    setSelected((prev) => {
      const n = new Set(prev)
      const allIn = ids.every((x) => n.has(x))
      for (const x of ids) allIn ? n.delete(x) : n.add(x)
      return n
    })

  const del = useMutation({
    mutationFn: (ids: string[]) => api.bulkTxns(ids, {}, true),
    onSuccess: () => {
      setSelected(new Set())
      setError(null)
      qc.invalidateQueries({ queryKey: ['duplicates', accountId] })
      qc.invalidateQueries({ queryKey: ['txns', accountId] })
      qc.invalidateQueries({ queryKey: ['budget'] })
      qc.invalidateQueries({ queryKey: ['month'] })
      qc.invalidateQueries({ queryKey: ['ops'] })
    },
    onError: (e: Error) => setError(errMsg(e)),
  })

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative z-10 flex max-h-[80vh] w-[620px] flex-col rounded-xl bg-white p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-slate-800">Possible Duplicates</h2>
          <button onClick={onClose} className="rounded px-2 py-1 text-slate-400 hover:bg-slate-100">
            ✕
          </button>
        </div>
        <div className="mb-3 text-xs text-slate-400">
          Rows sharing the same account, date, amount and payee. Review each group — two identical purchases can be
          legitimate. Deletion is undoable.
        </div>
        {error && <div className="mb-2 rounded bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>}
        <div className="flex-1 overflow-y-auto">
          {isFetching && !groups && <div className="py-4 text-center text-sm text-slate-400">Scanning…</div>}
          {groups?.length === 0 && <div className="py-4 text-center text-sm text-slate-400">No duplicates found.</div>}
          <div className="divide-y divide-slate-100">
            {groups?.map((g, gi) => (
              <div key={gi} className="py-2 text-sm">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={g.txnIds.every((x) => selected.has(x))}
                    onChange={() => toggleGroup(g.txnIds)}
                    className="accent-blue-600"
                    title="Select this group"
                  />
                  <div className="min-w-0 flex-1">
                    <span className="text-slate-700">{g.payee || '(no payee)'}</span>
                    <span className="ml-2 text-xs text-slate-400">{dateDisplay(g.date)}</span>
                  </div>
                  <span className="tnum text-right text-slate-600">{fmt(Math.abs(g.amount), c)}</span>
                  <span className="w-8 text-right text-xs text-slate-400">×{g.txnIds.length}</span>
                  <button
                    onClick={() => toggleGroup(g.txnIds)}
                    className="rounded px-2 py-0.5 text-[11px] text-slate-400 hover:bg-slate-100"
                    title="Toggle group"
                  >
                    ☑
                  </button>
                </div>
                {g.txnIds.length > 2 && (
                  <div className="mt-0.5 pl-6 text-[11px] text-amber-600">3+ identical rows — verify against the bank statement.</div>
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="mt-3 flex items-center justify-end gap-2">
          {selected.size > 0 && <span className="mr-auto text-xs text-slate-500">{selected.size} selected</span>}
          <button
            disabled={selected.size === 0 || del.isPending}
            onClick={() => {
              if (window.confirm(`Delete ${selected.size} selected transaction(s)?`)) del.mutate([...selected])
            }}
            className="rounded bg-red-500 px-3 py-1.5 text-sm text-white disabled:opacity-40"
          >
            {del.isPending ? 'Deleting…' : `Delete selected (${selected.size})`}
          </button>
          <button onClick={onClose} className="rounded border border-slate-200 px-3 py-1.5 text-sm text-slate-600">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
