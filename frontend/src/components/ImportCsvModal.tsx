import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { AccountLite, CsvSpec } from '../api'
import { api, errMsg } from '../api'
import { fmt, type Currency } from '../format'

// Drag & drop CSV import: bank importer (BVR), Trade Republic
// statement, or fully auto-detected dialect (sniffed server-side, with
// editable column mapping before commit). The backend takes a timestamped DB
// backup before writing.

type Preview = {
  spec: CsvSpec
  count: number
  net: number
  preview: { date: string; payee: string; amount: number; memo: string }[]
}

export default function ImportCsvModal({
  account,
  accounts,
  c,
  onClose,
}: {
  account: AccountLite
  accounts: AccountLite[]
  c: Currency
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [format, setFormat] = useState<'bvr' | 'tr' | 'auto'>('bvr')
  const [accountName, setAccountName] = useState(account.name)
  const [text, setText] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [auto, setAuto] = useState<Preview | null>(null)
  const [override, setOverride] = useState<Partial<CsvSpec>>({})
  const fileRef = useRef<HTMLInputElement>(null)

  const read = (f: File | undefined) => {
    if (!f) return
    setError(null)
    setResult(null)
    setAuto(null)
    setOverride({})
    setFileName(f.name)
    const r = new FileReader()
    r.onload = () => {
      setText(String(r.result ?? ''))
      // auto mode: sniff + preview as soon as the file lands
      if (format === 'auto') previewAuto.mutate({ csv: String(r.result ?? ''), spec: {} })
    }
    r.readAsText(f)
  }

  const refreshInvalidate = () => {
    qc.invalidateQueries({ queryKey: ['txns'] })
    qc.invalidateQueries({ queryKey: ['budget'] })
    qc.invalidateQueries({ queryKey: ['month'] })
    qc.invalidateQueries({ queryKey: ['ops'] })
    qc.invalidateQueries({ queryKey: ['suggestions'] })
    qc.invalidateQueries({ queryKey: ['duplicates'] })
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
      refreshInvalidate()
      setText(null)
      setFileName('')
    },
    onError: (e: Error) => setError(errMsg(e)),
  })

  const previewAuto = useMutation({
    mutationFn: (b: { csv: string; spec: Record<string, unknown> }) =>
      api.importAuto({ csv: b.csv, mode: 'preview', spec: b.spec }) as Promise<Preview>,
    onSuccess: (r) => {
      setAuto(r)
      setError(null)
    },
    onError: (e: Error) => setError(errMsg(e)),
  })

  const commitAuto = useMutation({
    mutationFn: () =>
      api.importAuto({ csv: text ?? '', mode: 'commit', accountName, spec: override as Record<string, unknown> }),
    onSuccess: (r) => {
      const res = r as { imported: number; skipped: number; account: string; backup: string | null }
      setResult(
        `Imported ${res.imported} transaction(s) into "${res.account}" (skipped ${res.skipped} duplicates/empty rows).${res.backup ? ` DB snapshot: backups/${res.backup}.` : ''}`,
      )
      refreshInvalidate()
      setText(null)
      setFileName('')
      setAuto(null)
    },
    onError: (e: Error) => setError(errMsg(e)),
  })

  const setCol = (key: 'date' | 'payee' | 'amount' | 'memo', idx: number | null) => {
    if (!auto) return
    const next: Partial<CsvSpec> = { ...override, columns: { ...auto.spec.columns, ...override.columns, [key]: idx } }
    setOverride(next)
    if (text) previewAuto.mutate({ csv: text, spec: next as Record<string, unknown> })
  }
  const setSpec = (key: 'dateOrder' | 'decimal', value: string) => {
    if (!auto) return
    const next: Partial<CsvSpec> = { ...override, [key]: value }
    setOverride(next)
    if (text) previewAuto.mutate({ csv: text, spec: next as Record<string, unknown> })
  }

  const preview = text ? text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 3) : []
  const spec = auto?.spec
  const colCount = spec ? Math.max(spec.header.length, ...Object.values(spec.columns).map((v) => (typeof v === 'number' ? v + 1 : 0))) : 0
  const colLabel = (i: number) => spec?.header[i]?.trim() || `Column ${i + 1}`
  const colOptions = Array.from({ length: Math.max(colCount, 1) }, (_, i) => i)

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative z-10 flex max-h-[85vh] w-[600px] flex-col overflow-auto rounded-xl bg-panel p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-slate-800">Import CSV</h2>
          <button onClick={onClose} className="rounded px-2 py-1 text-slate-400 hover:bg-slate-100">
            ✕
          </button>
        </div>
        <div className="mb-3 text-xs text-slate-400">
          Merges bank movements with the register (dedup by importId + date/amount/payee). A timestamped DB snapshot is
          taken automatically before importing.
        </div>
        {result && <div className="mb-2 rounded bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{result}</div>}
        {error && <div className="mb-2 rounded bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>}

        <div className="mb-2 flex items-center gap-2">
          <select
            value={format}
            onChange={(e) => {
              setFormat(e.target.value as 'bvr' | 'tr' | 'auto')
              setAuto(null)
              setOverride({})
              setResult(null)
              setError(null)
            }}
            className="rounded border border-slate-200 px-2 py-1.5 text-sm"
          >
            <option value="bvr">Bank CSV (BVR)</option>
            <option value="tr">Trade Republic statement</option>
            <option value="auto">Auto-detect (any bank)</option>
          </select>
          {format !== 'tr' && (
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
              <div className="mt-1 text-xs">
                {format === 'auto' && previewAuto.isPending
                  ? 'detecting format…'
                  : text
                    ? `${text.split(/\r?\n/).filter((l) => l.trim()).length} rows parsed`
                    : 'reading…'}
              </div>
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

        {format === 'auto' && auto && spec && (
          <div className="mt-3 rounded-lg border border-slate-200 p-3">
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="font-medium text-slate-600">
                Detected: “{spec.delimiter === '\t' ? 'Tab' : spec.delimiter}” delimited · {spec.dateOrder} dates ·{' '}
                {spec.decimal === ',' ? '1.234,56' : '1,234.56'} ·{' '}
                {Math.round(spec.confidence * 100)}% confidence
              </span>
              <span className={auto.count > 0 ? 'text-emerald-600' : 'text-amber-600'}>
                {auto.count} rows · net {fmt(auto.net, c)}
              </span>
            </div>
            <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(
                [
                  ['Date', 'date', spec.columns.date],
                  ['Payee', 'payee', spec.columns.payee],
                  ['Amount', 'amount', spec.columns.amount],
                  ['Memo', 'memo', spec.columns.memo],
                ] as [string, 'date' | 'payee' | 'amount' | 'memo', number | null][]
              ).map(([label, key, val]) => (
                <label key={key} className="text-[11px] text-slate-500">
                  {label}
                  <select
                    value={val ?? ''}
                    onChange={(e) => setCol(key, e.target.value === '' ? null : Number(e.target.value))}
                    className="mt-0.5 w-full rounded border border-slate-200 px-1.5 py-1 text-[12px]"
                  >
                    <option value="">—</option>
                    {colOptions.map((i) => (
                      <option key={i} value={i}>
                        {colLabel(i)}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-400">
                  <th className="py-1 pr-2">Date</th>
                  <th className="py-1 pr-2">Payee</th>
                  <th className="py-1 pr-2 text-right">Amount</th>
                  <th className="py-1">Memo</th>
                </tr>
              </thead>
              <tbody>
                {auto.preview.map((r, i) => (
                  <tr key={i} className="border-b border-slate-100 last:border-0">
                    <td className="py-1 pr-2 text-slate-600">{r.date}</td>
                    <td className="py-1 pr-2 text-slate-600">{r.payee}</td>
                    <td className={`tnum py-1 pr-2 text-right ${r.amount < 0 ? 'text-red-500' : 'text-emerald-600'}`}>
                      {fmt(r.amount, c)}
                    </td>
                    <td className="py-1 text-slate-400">{r.memo || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {spec.dateOrder !== 'ISO' && (
              <div className="mt-2 flex gap-3 text-[11px] text-slate-500">
                <label>
                  Date order{' '}
                  <select
                    value={override.dateOrder ?? spec.dateOrder}
                    onChange={(e) => setSpec('dateOrder', e.target.value)}
                    className="ml-1 rounded border border-slate-200 px-1 py-0.5"
                  >
                    <option value="DMY">DD/MM/YYYY</option>
                    <option value="MDY">MM/DD/YYYY</option>
                  </select>
                </label>
                <label>
                  Decimals{' '}
                  <select
                    value={override.decimal ?? spec.decimal}
                    onChange={(e) => setSpec('decimal', e.target.value)}
                    className="ml-1 rounded border border-slate-200 px-1 py-0.5"
                  >
                    <option value=",">1.234,56</option>
                    <option value=".">1,234.56</option>
                  </select>
                </label>
              </div>
            )}
          </div>
        )}

        {format !== 'auto' && preview.length > 0 && (
          <pre className="mt-2 max-h-24 overflow-auto rounded bg-slate-50 px-2 py-1 text-[10px] text-slate-400">{preview.join('\n')}</pre>
        )}

        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} className="rounded border border-slate-200 px-3 py-1.5 text-sm text-slate-600">
            Close
          </button>
          {format === 'auto' ? (
            <button
              disabled={!text || !auto || auto.count === 0 || commitAuto.isPending}
              onClick={() => commitAuto.mutate()}
              className="rounded bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-40"
            >
              {commitAuto.isPending ? 'Importing…' : `Import ${auto?.count ?? 0} rows`}
            </button>
          ) : (
            <button
              disabled={!text || imp.isPending}
              onClick={() => imp.mutate()}
              className="rounded bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-40"
            >
              {imp.isPending ? 'Importing…' : 'Import'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
