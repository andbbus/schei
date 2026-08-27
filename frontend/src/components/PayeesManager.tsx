import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, errMsg } from '../api'

export default function PayeesManager({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const { data: payees } = useQuery({ queryKey: ['payees-manage'], queryFn: api.payeeManager })
  const { data: similar } = useQuery({ queryKey: ['payees-similar'], queryFn: api.payeesSimilar })
  const { data: meta } = useQuery({ queryKey: ['budget'], queryFn: api.budget })
  const [q, setQ] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [priorName, setPriorName] = useState('')
  const [merging, setMerging] = useState<string | null>(null)
  const [targetId, setTargetId] = useState('')
  // rename-learning offer shown after a successful rename
  const [learnOffer, setLearnOffer] = useState<{ oldName: string; newName: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['payees-manage'] })
    qc.invalidateQueries({ queryKey: ['payees'] })
    qc.invalidateQueries({ queryKey: ['payees-similar'] })
    qc.invalidateQueries({ queryKey: ['txns'] })
    qc.invalidateQueries({ queryKey: ['suggestions'] })
    qc.invalidateQueries({ queryKey: ['ops'] })
    qc.invalidateQueries({ queryKey: ['payee-rules'] })
  }
  const rename = useMutation({
    mutationFn: () => api.renamePayee(editingId!, name.trim()),
    onSuccess: () => {
      refresh()
      const newName = name.trim()
      if (priorName && priorName !== newName) setLearnOffer({ oldName: priorName, newName })
      setEditingId(null)
      setNotice('Payee renamed.')
      setError(null)
    },
    onError: (e: Error) => setError(errMsg(e)),
  })
  const createRenameRule = useMutation({
    mutationFn: (pair: { oldName: string; newName: string }) => api.autoRenameRule(pair.oldName, pair.newName),
    onSuccess: () => {
      refresh()
      setNotice(`Future imports matching “${learnOffer?.oldName}” will be renamed automatically.`)
      setLearnOffer(null)
      setError(null)
    },
    onError: (e: Error) => setError(errMsg(e)),
  })
  const learnToggle = useMutation({
    mutationFn: (p: { id: string; disabled: boolean }) => api.learnToggle(p.id, p.disabled),
    onSuccess: refresh,
    onError: (e: Error) => setError(errMsg(e)),
  })
  const globalLearning = useMutation({
    mutationFn: (enabled: boolean) => api.setCategoryLearning(enabled),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['budget'] })
      setError(null)
    },
    onError: (e: Error) => setError(errMsg(e)),
  })
  const merge = useMutation({
    mutationFn: (pair: { fromId: string; toId: string }) => api.mergePayees(pair.fromId, pair.toId),
    onSuccess: (r, pair) => {
      refresh()
      setNotice(`Merged — ${r.moved} transaction(s) moved. Undoable from the history menu.`)
      setMerging(null)
      setTargetId('')
      setError(null)
      void pair
    },
    onError: (e: Error) => setError(errMsg(e)),
  })

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = payees ?? []
    if (!needle) return list
    return list.filter((p) => p.name.toLowerCase().includes(needle))
  }, [payees, q])

  const others = (id: string) => visible.filter((p) => p.id !== id && !p.isTransfer)

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative z-10 flex max-h-[80vh] w-[640px] flex-col rounded-xl bg-white p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-slate-800">Payees</h2>
          <button onClick={onClose} className="rounded px-2 py-1 text-slate-400 hover:bg-slate-100">
            ✕
          </button>
        </div>
        <div className="mb-3 text-xs text-slate-400">
          Rename or merge payees to repair history (pattern detection and rules follow the merged name). Merging is
          undoable from the 🕘 history menu.
        </div>
        {notice && <div className="mb-2 rounded bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{notice}</div>}
        {error && <div className="mb-2 rounded bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>}
        {learnOffer && (
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-slate-700">
            <span className="flex-1">
              Create a rule so future imports containing “{learnOffer.oldName}” become “{learnOffer.newName}”?
            </span>
            <button
              onClick={() => createRenameRule.mutate(learnOffer)}
              disabled={createRenameRule.isPending}
              className="rounded bg-blue-600 px-2 py-1 text-white disabled:opacity-40"
            >
              Yes, always
            </button>
            <button onClick={() => setLearnOffer(null)} className="rounded px-2 py-1 text-slate-500 hover:bg-white">
              No
            </button>
          </div>
        )}
        {similar && similar.length > 0 && (
          <div className="mb-3 rounded border border-amber-200 bg-amber-50 p-2">
            <div className="mb-1 text-xs font-semibold text-amber-700">Similar names — likely the same payee</div>
            <div className="divide-y divide-amber-100">
              {similar.map((p) => (
                <div key={p.fromId} className="flex items-center gap-2 py-1 text-xs text-slate-600">
                  <span className="min-w-0 flex-1 truncate">
                    <b>{p.fromName}</b> → {p.toName}
                  </span>
                  <span className="shrink-0 text-[10px] text-amber-600">{Math.round(p.similarity * 100)}%</span>
                  <button
                    onClick={() => merge.mutate({ fromId: p.fromId, toId: p.toId })}
                    disabled={merge.isPending}
                    className="shrink-0 rounded bg-amber-600 px-2 py-0.5 text-white disabled:opacity-40"
                  >
                    Merge
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        <input
          placeholder="Search payees…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="mb-3 rounded border border-slate-200 px-2 py-1.5 text-sm"
        />
        <div className="flex-1 overflow-y-auto">
          <div className="divide-y divide-slate-100">
            {visible.map((p) => (
              <div key={p.id} className="py-2 text-sm">
                <div className="flex items-center gap-2">
                  {editingId === p.id ? (
                    <>
                      <input
                        autoFocus
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') rename.mutate()
                          if (e.key === 'Escape') setEditingId(null)
                        }}
                        className="min-w-0 flex-1 rounded border border-blue-300 px-2 py-1"
                      />
                      <button onClick={() => rename.mutate()} className="rounded bg-emerald-500 px-2 py-1 text-xs text-white">
                        Save
                      </button>
                      <button onClick={() => setEditingId(null)} className="rounded border border-slate-200 px-2 py-1 text-xs">
                        ✕
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate text-slate-700">{p.name}</span>
                      <span className="shrink-0 text-xs text-slate-400">{p.txnCount} tx</span>
                      {p.categories.slice(0, 2).map((c) => (
                        <span key={c.categoryId} className="hidden shrink-0 rounded bg-slate-100 px-1.5 text-[11px] text-slate-500 md:inline">
                          {c.name}
                        </span>
                      ))}
                      <button
                        onClick={() => { setEditingId(p.id); setName(p.name); setPriorName(p.name) }}
                        className="shrink-0 rounded px-2 py-0.5 text-xs text-slate-500 hover:bg-slate-100"
                        title="Rename"
                      >
                        ✎
                      </button>
                      {!p.isTransfer && (
                        <button
                          onClick={() => learnToggle.mutate({ id: p.id, disabled: !p.learnDisabled })}
                          className="shrink-0 rounded px-2 py-0.5 text-xs hover:bg-slate-100"
                          title={p.learnDisabled ? 'Learning disabled — click to re-enable category-learning prompts' : 'Disable category auto-learning for this payee'}
                        >
                          {p.learnDisabled ? '🎓✕' : '🎓'}
                        </button>
                      )}
                      <button
                        onClick={() => { setMerging(p.id); setTargetId('') }}
                        disabled={p.isTransfer || others(p.id).length === 0}
                        className="shrink-0 rounded px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-50 disabled:text-slate-300"
                        title="Merge into another payee"
                      >
                        Merge…
                      </button>
                    </>
                  )}
                </div>
                {merging === p.id && (
                  <div className="mt-1.5 flex items-center gap-2 pl-1">
                    <span className="text-xs text-slate-500">Merge "{p.name}" into:</span>
                    <select value={targetId} onChange={(e) => setTargetId(e.target.value)} className="min-w-0 flex-1 rounded border border-slate-200 px-2 py-1 text-sm">
                      <option value="">Choose…</option>
                      {others(p.id).map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                    <button
                      disabled={!targetId || merge.isPending}
                      onClick={() => merge.mutate({ fromId: merging!, toId: targetId })}
                      className="rounded bg-red-500 px-2 py-1 text-xs text-white disabled:opacity-40"
                    >
                      Merge
                    </button>
                    <button onClick={() => setMerging(null)} className="rounded px-2 py-1 text-xs text-slate-500">
                      ✕
                    </button>
                  </div>
                )}
              </div>
            ))}
            {visible.length === 0 && <div className="py-4 text-center text-sm text-slate-400">No payees match.</div>}
          </div>
        </div>
        <label className="mt-2 flex items-center gap-1.5 border-t border-slate-100 pt-2 text-xs text-slate-500" title="When on, the app may suggest creating auto-categorization rules as you fix transactions">
          <input
            type="checkbox"
            checked={meta?.budget.categoryLearning ?? true}
            onChange={(e) => globalLearning.mutate(e.target.checked)}
          />
          Category auto-learning (offers rules when you categorize)
        </label>
      </div>
    </div>
  )
}
