import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { GroupView } from '../api'
import { api, errMsg, isCategoryRule } from '../api'

type Rule = Awaited<ReturnType<typeof api.payeeRules>>[number]

const OP_LABELS = ['contains', 'is', 'oneOf', 'regex'] as const
const FIELDS = [
  { id: 'payeeName', label: 'Payee' },
  { id: 'memo', label: 'Memo' },
  { id: 'account', label: 'Account ID' },
] as const
const ACTIONS = [
  { id: 'category', label: 'Set category' },
  { id: 'payeeName', label: 'Rename payee to…' },
  { id: 'prependNotes', label: 'Prepend memo' },
  { id: 'appendNotes', label: 'Append memo' },
] as const

type ActionId = (typeof ACTIONS)[number]['id']

export default function RulesManager({ groups, onClose }: { groups: GroupView[]; onClose: () => void }) {
  const qc = useQueryClient()
  const { data: rules } = useQuery({ queryKey: ['payee-rules'], queryFn: api.payeeRules })
  const { data: payees } = useQuery({ queryKey: ['payees'], queryFn: api.payees })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [pattern, setPattern] = useState('')
  const [field, setField] = useState<string>('payeeName')
  const [op, setOp] = useState<string>('contains')
  const [stage, setStage] = useState<string>('default')
  const [action, setAction] = useState<ActionId>('category')
  const [categoryId, setCategoryId] = useState('')
  const [actionText, setActionText] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [advanced, setAdvanced] = useState(false)
  const [overwrite, setOverwrite] = useState(false)
  const [includeReconciled, setIncludeReconciled] = useState(false)
  const [search, setSearch] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // live preview of the condition being edited (debounced)
  const previewInput = useMemo(
    () => ({ pattern, field, op }),
    [pattern, field, op],
  )
  const canPreview = pattern.trim().length > 0 && !editingId // saved rows already show their own count
  const [preview, setPreview] = useState<{ count: number; sample: { id: string; date: string; payee: string; memo: string | null; categoryName: string | null }[] } | null>(null)
  useEffect(() => {
    if (!canPreview) {
      setPreview(null)
      return
    }
    const t = setTimeout(() => {
      api
        .previewPayeeRule(previewInput as { pattern: string; field?: string; op?: string })
        .then((r) => setPreview(r))
        .catch(() => setPreview(null))
    }, 300)
    return () => clearTimeout(t)
  }, [previewInput, canPreview])

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['payee-rules'] })
    qc.invalidateQueries({ queryKey: ['payees'] })
    qc.invalidateQueries({ queryKey: ['txns'] })
  }

  const resetForm = () => {
    setEditingId(null)
    setPattern('')
    setField('payeeName')
    setOp('contains')
    setStage('default')
    setAction('category')
    setCategoryId('')
    setActionText('')
    setEnabled(true)
    setAdvanced(false)
  }

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        pattern,
        ...(editingId === null || advanced ? { field } : {}),
        ...(editingId === null || advanced ? { op } : {}),
        ...(editingId === null || advanced ? { stage } : {}),
        action,
        enabled,
        ...(action === 'category'
          ? { categoryId }
          : { actionText, categoryId: null }),
      }
      return editingId ? api.updatePayeeRule(editingId, payload) : api.createPayeeRule(payload)
    },
    onSuccess: () => {
      refresh()
      resetForm()
      setNotice(editingId ? 'Rule updated.' : 'Rule created.')
      setError(null)
    },
    onError: (e: Error) => setError(errMsg(e)),
  })

  const toggleEnabled = useMutation({
    mutationFn: (r: Rule) => api.updatePayeeRule(r.id, { enabled: !r.enabled }),
    onSuccess: refresh,
    onError: (e: Error) => setError(errMsg(e)),
  })

  const del = useMutation({
    mutationFn: (id: string) => api.deletePayeeRule(id),
    onSuccess: refresh,
    onError: (e: Error) => setError(errMsg(e)),
  })

  const apply = useMutation({
    mutationFn: (b: { ruleId?: string }) => api.applyPayeeRules({ ...b, overwrite, includeReconciled }),
    onSuccess: (r) => {
      refresh()
      setNotice(`Applied to ${r.applied} transaction(s). Skipped: ${r.skipped.reconciled} reconciled, ${r.skipped.transfers} transfers, ${r.skipped.splits} splits. Undoable from the history menu.`)
      setError(null)
    },
    onError: (e: Error) => setError(errMsg(e)),
  })

  const startEdit = (r: Rule) => {
    setEditingId(r.id)
    setPattern(r.pattern)
    setField(r.field ?? 'payeeName')
    setOp(r.op ?? (r.pattern.startsWith('=') ? 'is' : 'contains'))
    setStage(r.stage ?? 'default')
    setAction((r.action ?? 'category') as ActionId)
    setCategoryId(r.categoryId ?? '')
    setActionText(r.actionText ?? '')
    setEnabled(r.enabled ?? true)
    setAdvanced(true)
    setError(null)
    setNotice(null)
  }

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const list = rules ?? []
    if (!needle) return list
    return list.filter(
      (r) =>
        r.pattern.toLowerCase().includes(needle) ||
        (r.actionText ?? '').toLowerCase().includes(needle) ||
        r.categoryName.toLowerCase().includes(needle),
    )
  }, [rules, search])

  const catLabel =
    action === 'category'
      ? groups.flatMap((g) => g.categories).find((c) => c.id === categoryId)?.name
      : actionText

  const canSave =
    (action === 'category' ? !!categoryId : !!actionText.trim()) &&
    !!pattern.trim() &&
    pattern.trim() !== '=' &&
    pattern.trim() !== '=='

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative z-10 flex max-h-[85vh] w-[680px] flex-col rounded-xl bg-panel p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-slate-800">Transaction Rules</h2>
          <button onClick={onClose} className="rounded px-2 py-1 text-slate-400 hover:bg-slate-100">
            ✕
          </button>
        </div>

        {notice && <div className="mb-2 rounded bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{notice}</div>}
        {error && <div className="mb-2 rounded bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>}

        {/* ---- editor ---- */}
        <div className="mb-3 rounded-lg border border-slate-200 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {field === 'account' ? (
              <input
                placeholder="Account matches nothing from this editor — edit the pattern manually"
                disabled
                className="w-48 rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm"
              />
            ) : (
              <>
                <input
                  autoFocus={!editingId}
                  list="rules-payee-datalist"
                  placeholder={field === 'memo' ? 'Memo contains… e.g. AMZN.COM*' : 'Pattern… e.g. AMZN.COM*'}
                  value={pattern}
                  onChange={(e) => setPattern(e.target.value)}
                  className="min-w-56 flex-1 rounded border border-slate-200 px-2 py-1.5 text-sm"
                />
                <datalist id="rules-payee-datalist">
                  {(payees ?? []).map((p) => (
                    <option key={p.id} value={p.name} />
                  ))}
                </datalist>
              </>
            )}
            <select value={field} onChange={(e) => setField(e.target.value)} className="rounded border border-slate-200 px-2 py-1.5 text-sm" title="Condition field">
              {FIELDS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
            <select value={op} onChange={(e) => setOp(e.target.value)} className="rounded border border-slate-200 px-2 py-1.5 text-sm" title="Match operator">
              {OP_LABELS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>

          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <select value={action} onChange={(e) => setAction(e.target.value as ActionId)} className="w-44 rounded border border-slate-200 px-2 py-1.5 text-sm">
              {ACTIONS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
            {action === 'category' ? (
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="flex-1 rounded border border-slate-200 px-2 py-1.5 text-sm">
                <option value="">Category…</option>
                {groups.map((g) => (
                  <optgroup key={g.id} label={g.name}>
                    {g.categories.map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        {cat.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            ) : (
              <input
                placeholder={action === 'payeeName' ? 'Canonical payee name…' : 'Note text…'}
                value={actionText}
                onChange={(e) => setActionText(e.target.value)}
                className="flex-1 rounded border border-slate-200 px-2 py-1.5 text-sm"
              />
            )}
            <label className="flex items-center gap-1 text-xs text-slate-500" title="Disabled rules never run">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              enabled
            </label>
            <button
              disabled={!canSave}
              onClick={() => save.mutate()}
              className="rounded bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-40"
            >
              {editingId ? 'Update' : 'Add rule'}
            </button>
            {editingId && (
              <button onClick={resetForm} className="rounded border border-slate-200 px-3 py-1.5 text-sm text-slate-600">
                Cancel
              </button>
            )}
          </div>

          {/* advanced: stage + ranking explanation */}
          <button onClick={() => setAdvanced((a) => !a)} className="text-[11px] text-slate-400 hover:text-slate-600">
            {advanced ? '▾' : '▸'} Advanced (stage &amp; ordering)
          </button>
          {advanced && (
            <div className="mt-1.5 flex items-center gap-2 rounded bg-slate-50 p-2 text-xs text-slate-500">
              <span title="pre runs before categorization rules; post runs after everything">
                Stage
                <select value={stage} onChange={(e) => setStage(e.target.value)} className="ml-1 rounded border border-slate-200 px-1 py-0.5">
                  <option value="pre">pre</option>
                  <option value="default">default</option>
                  <option value="post">post</option>
                </select>
              </span>
              <span className="text-slate-400">Within a stage, rules run least-specific first — exact beats oneOf beats contains/regex, so specific rules overwrite broad ones.</span>
            </div>
          )}

          {/* live preview */}
          {!editingId && preview && (
            <div className="mt-2 rounded bg-blue-50 p-2 text-xs text-slate-600">
              <b>{preview.count}</b> existing transaction(s) match this condition.
              {preview.sample.length > 0 && (
                <ul className="mt-1 max-h-24 space-y-0.5 overflow-y-auto">
                  {preview.sample.slice(0, 8).map((s) => (
                    <li key={s.id} className="truncate">
                      <span className="text-slate-400">{s.date}</span> {s.payee}
                      {s.categoryName ? <span className="text-slate-400"> · {s.categoryName}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* ---- apply scope options ---- */}
        <div className="mb-2 flex flex-col gap-1">
          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
            Also update transactions already categorized by this rule
          </label>
          <label className="mb-1 flex items-center gap-1.5 text-xs text-slate-500">
            <input type="checkbox" checked={includeReconciled} onChange={(e) => setIncludeReconciled(e.target.checked)} />
            Include reconciled transactions
          </label>
        </div>

        {/* ---- list ---- */}
        <input
          placeholder="Search rules…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="mb-2 rounded border border-slate-200 px-2 py-1.5 text-sm"
        />
        <div className="flex-1 overflow-y-auto">
          <div className="divide-y divide-slate-100">
            {filtered.map((r) => (
              <div key={r.id} className={`flex items-center gap-2 py-2 text-sm ${r.enabled === false ? 'opacity-50' : ''}`}>
                <input
                  type="checkbox"
                  checked={r.enabled ?? true}
                  onChange={() => toggleEnabled.mutate(r)}
                  title="Enable / disable this rule"
                  className="accent-emerald-600"
                />
                <code className="max-w-[220px] truncate text-slate-700" title={`${r.field ?? 'payeeName'} ${r.op ?? 'contains'} "${r.pattern}"`}>
                  {r.pattern}
                </code>
                {(r.stage ?? 'default') !== 'default' && (
                  <span className="shrink-0 rounded bg-purple-100 px-1 text-[10px] text-purple-700">{r.stage}</span>
                )}
                <span className="min-w-0 flex-1 truncate text-slate-500">
                  →{' '}
                  {isCategoryRule(r) ? (
                    <>
                      {r.categoryName || '(no category)'}
                      {r.categoryDeleted && <span className="ml-1 text-amber-600">⚠ deleted</span>}
                    </>
                  ) : r.action === 'payeeName' ? (
                    <>rename to “{r.actionText}”</>
                  ) : (
                    <>({r.action === 'prependNotes' ? 'prepend' : 'append'} memo “{r.actionText}”)</>
                  )}
                </span>
                <span className="w-14 shrink-0 text-right text-xs text-slate-400">{r.matchCount} match</span>
                <button
                  onClick={() => apply.mutate({ ruleId: r.id })}
                  className="shrink-0 rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-700 hover:bg-emerald-100"
                  title={`Runs the pipeline for ${r.matchCount} matching transaction(s)`}
                >
                  Apply
                </button>
                <button onClick={() => startEdit(r)} className="shrink-0 rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-100" title={catLabel}>
                  ✎
                </button>
                <button onClick={() => del.mutate(r.id)} className="shrink-0 rounded px-2 py-1 text-xs text-red-500 hover:bg-red-50">
                  🗑
                </button>
              </div>
            ))}
            {filtered.length === 0 && <div className="py-4 text-center text-sm text-slate-400">No rules match.</div>}
          </div>
        </div>
      </div>
    </div>
  )
}
