import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, errMsg } from '../api'
import { fmt, dateDisplay, type Currency } from '../format'

export interface Drill {
  categoryId: string
  categoryName: string
  from: string
  to: string
  accountId?: string
  mode: 'spending' | 'activity'
}

export default function TxnListModal({
  drill,
  c,
  accounts,
  onClose,
}: {
  drill: Drill
  c: Currency
  accounts: { id: string; name: string }[]
  onClose: () => void
}) {
  const navigate = useNavigate()
  const { data, isPending, isError, error } = useQuery({
    queryKey: ['drill', drill.categoryId, drill.from, drill.to, drill.accountId ?? 'all'],
    queryFn: () => api.txnsByCategory({ categoryId: drill.categoryId, from: drill.from, to: drill.to, accountId: drill.accountId }),
  })
  const spent = data ? data.txns.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0) : 0
  const refunded = data ? data.txns.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0) : 0
  const title = data
    ? `${data.categoryName} · ${data.from === data.to ? dateDisplay(data.from) : `${dateDisplay(data.from)} – ${dateDisplay(data.to)}`}`
    : drill.categoryName
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative z-10 flex max-h-[80vh] w-[760px] flex-col rounded-xl bg-panel shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <div>
            <div className="text-[15px] font-semibold text-slate-800">{title}</div>
            {data && drill.mode === 'spending' && (
              <div className="text-xs text-slate-500">
                Spent {fmt(-spent, c)}
                {refunded !== 0 && <span className="text-slate-400"> · refunds {fmt(refunded, c)}</span>}
              </div>
            )}
            {data && drill.mode === 'activity' && (
              <div className="text-xs text-slate-500">Net {fmt(spent + refunded, c)}</div>
            )}
          </div>
          <button onClick={onClose} className="rounded px-2 py-1 text-slate-400 hover:bg-slate-100">
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {isPending && <div className="p-6 text-slate-400">Loading…</div>}
          {isError && <div className="p-6 text-sm text-red-600">{errMsg(error as Error)}</div>}
          {data && data.txns.length === 0 && <div className="p-6 text-center text-sm text-slate-400">No transactions in this range.</div>}
          {data && data.txns.length > 0 && (
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-panel text-left text-[11px] tracking-wide text-slate-400 uppercase">
                <tr className="border-b border-slate-100">
                  <th className="px-3 py-1.5">Date</th>
                  <th className="px-3 py-1.5">Payee</th>
                  <th className="px-3 py-1.5">Memo</th>
                  <th className="px-3 py-1.5 text-right">Outflow</th>
                  <th className="px-3 py-1.5 text-right">Inflow</th>
                  <th className="px-3 py-1.5">Account</th>
                  <th className="px-3 py-1.5">C</th>
                </tr>
              </thead>
              <tbody>
                {data.txns.map((t) => (
                  <tr
                    key={t.id}
                    onClick={() => {
                      onClose()
                      navigate(`/accounts/${t.accountId}`)
                    }}
                    className="cursor-pointer border-b border-slate-50 hover:bg-blue-50"
                    title="Open in register"
                  >
                    <td className="px-3 py-1.5 whitespace-nowrap">{dateDisplay(t.date)}</td>
                    <td className="max-w-[220px] truncate px-3 py-1.5">
                      {t.payee}
                      {t.transferAccountId ? <span className="ml-1 rounded bg-slate-100 px-1 text-[10px]">transfer</span> : null}
                    </td>
                    <td className="max-w-[160px] truncate px-3 py-1.5 text-slate-400">{t.memo}</td>
                    <td className="tnum px-3 py-1.5 text-right">{t.amount < 0 ? fmt(-t.amount, c) : ''}</td>
                    <td className="tnum px-3 py-1.5 text-right text-emerald-700">{t.amount > 0 ? fmt(t.amount, c) : ''}</td>
                    <td className="px-3 py-1.5 text-slate-500">{accounts.find((a) => a.id === t.accountId)?.name ?? ''}</td>
                    <td className="px-3 py-1.5 text-slate-400">{t.cleared === 'uncleared' ? '' : t.cleared[0].toUpperCase()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
