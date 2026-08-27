import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { AccountLite } from '../api'
import { api, errMsg } from '../api'

// Drag & drop CSV import for the bank importer (MainBank/BVR format) or the
// Trade Republic statement format. Backend takes a timestamped DB backup
// before writing, so the merge workflow no longer needs a manual backup step.
export default function ImportCsvModal({
  account,
  accounts,
  onClose,
}: {
  account: AccountLite
  accounts: AccountLite[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [format, setFormat] = useState<'bvr' | 'tr'>('bvr')
  const [accountName, setAccountName] = useState(account.name)
  const [text, setText] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const read = (f: File | undefined) => {
    if (!f) return
    setError(null)
    setResult(null)
    setFileName(f.name)
    const r = new FileReader()
    r.onload = () => setText(String(r.result ?? ''))
    r.readAsText(f)
  }

  const imp = useMutation({
    mutationFn: () =>
      format === 'tr'
        ? api.importTrCsv(text ?? '')
        : api.importCsv(text ?? '', accountName),
    onSuccess: (r) => {
      setResult(
        `Imported ${r.imported} transaction(s) into "${r.account}" (skipped ${r.skipped} summary/empty/duplicate rows).${r.backup ? ` DB snapshot: backups/${r.backup}.` : ''}`,
      )
      qc.invalidateQueries({ queryKey: ['txns'] })
      qc.invalidateQueries({ queryKey: ['budget'] })
      qc.invalidateQueries({ queryKey: ['month'] })
      qc.invalidateQueries({ queryKey: ['ops'] })
      qc.invalidateQueries({ queryKey: ['suggestions'] })
      qc.invalidateQueries({ queryKey: ['duplicates'] })
      setText(null)
      setFileName('')
    },
    onError: (e: Error) => setError(errMsg(e)),
  })

  const preview = text ? text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 3) : []

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative z-10 flex max-h-[80vh] w-[560px] flex-col rounded-xl bg-panel p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-slate-800">Import CSV</h2>
          <button onClick={onClose} className="rounded px-2 py-1 text-slate-400 hover:bg-slate-100">
            ✕
          </button>
        </div>
        <div className="mb-3 text-xs text-slate-400">
          Merges bank movements with the register (dedup by importId + date/amount/payee). A timestamped DB snapshot is
          taken automatically before importing. Formatting rules live in docs/IMPORTING-AND-MERGING.md.
        </div>
        {result && <div className="mb-2 rounded bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{result}</div>}
        {error && <div className="mb-2 rounded bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>}

        <div className="mb-2 flex items-center gap-2">
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value as 'bvr' | 'tr')}
            className="rounded border border-slate-200 px-2 py-1.5 text-sm"
          >
            <option value="bvr">Bank CSV (MainBank / BVR)</option>
            <option value="tr">Trade Republic statement</option>
          </select>
          {format === 'bvr' && (
            <select
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
              className="rounded border border-slate-200 px-2 py-1.5 text-sm"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            read(e.dataTransfer.files?.[0])
          }}
          className={`flex h-32 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed text-sm ${
            dragOver ? 'border-blue-400 bg-blue-50 text-blue-600' : 'border-slate-300 text-slate-400 hover:border-slate-400'
          }`}
        >
          {fileName ? (
            <>
              <div className="font-medium text-slate-600">{fileName}</div>
              <div className="mt-1 text-xs">{text ? `${text.split(/\r?\n/).filter((l) => l.trim()).length} rows parsed` : 'reading…'}</div>
            </>
          ) : (
            <>Drop the CSV here, or click to choose…</>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => read(e.target.files?.[0])}
          />
        </div>

        {preview.length > 0 && (
          <pre className="mt-2 max-h-24 overflow-auto rounded bg-slate-50 px-2 py-1 text-[10px] text-slate-400">{preview.join('\n')}</pre>
        )}

        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} className="rounded border border-slate-200 px-3 py-1.5 text-sm text-slate-600">
            Close
          </button>
          <button
            disabled={!text || imp.isPending}
            onClick={() => imp.mutate()}
            className="rounded bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-40"
          >
            {imp.isPending ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  )
}
