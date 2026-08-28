import { Link, useOutletContext } from 'react-router-dom'
import type { AccountLite, BudgetMeta } from '../api'
import { fmt, type Currency } from '../format'

const TYPE_LABELS: Record<string, string> = {
  checking: 'Checking',
  savings: 'Savings',
  cash: 'Cash',
  creditCard: 'Credit Card',
  lineOfCredit: 'Line of Credit',
  otherAsset: 'Tracking (Asset)',
  otherLiability: 'Tracking (Liability)',
  mortgage: 'Mortgage',
  autoLoan: 'Auto Loan',
}

const typeLabel = (t: string) => TYPE_LABELS[t] ?? t

function StatCard({ label, value, c, negative }: { label: string; value: number; c: Currency; negative?: boolean }) {
  return (
    <div className="rounded-[10px] border border-slate-200 bg-panel px-4 py-3 shadow-[var(--elev-subtle)]">
      <div className="text-[11px] font-semibold tracking-[0.06em] text-slate-400 uppercase">{label}</div>
      <div className={`tnum mt-0.5 text-lg font-semibold ${negative ? 'text-red-600' : 'text-slate-900'}`}>
        {fmt(value, c)}
      </div>
    </div>
  )
}

function AccountRow({ a, c }: { a: AccountLite; c: Currency }) {
  return (
    <tr className={`border-b border-slate-100 last:border-0 ${a.closed ? 'opacity-60' : ''}`}>
      <td className="py-2.5 pr-3 pl-4">
        <Link to={`/accounts/${a.id}`} className="group flex items-baseline gap-2">
          <span className="font-medium text-slate-800 group-hover:text-blue-600">{a.name}</span>
          <span className="text-[11px] text-slate-400">{typeLabel(a.type)}</span>
          {a.type === 'creditCard' && (
            <span className="rounded bg-slate-100 px-1 text-[10px] text-slate-500">card</span>
          )}
          {a.closed && <span className="rounded bg-slate-200 px-1 text-[10px] text-slate-500">closed</span>}
        </Link>
      </td>
      <td className="tnum py-2.5 pr-4 text-right text-slate-600">{fmt(a.cleared, c)}</td>
      <td className="tnum py-2.5 pr-4 text-right text-slate-600">{fmt(a.uncleared, c)}</td>
      <td className={`tnum py-2.5 pr-4 text-right font-semibold ${a.working < 0 ? 'text-red-600' : 'text-slate-900'}`}>
        {fmt(a.working, c)}
      </td>
      <td className={`tnum py-2.5 pr-4 text-right ${a.upcoming === 0 ? 'text-slate-300' : 'text-slate-400'}`}>
        {a.upcoming === 0 ? '—' : fmt(a.upcoming, c)}
      </td>
    </tr>
  )
}

function AccountSection({ title, accounts, c, total }: { title: string; accounts: AccountLite[]; c: Currency; total?: boolean }) {
  if (accounts.length === 0) return null
  const sum = accounts.reduce((s, a) => s + a.working, 0)
  return (
    <div className="rounded-[10px] border border-slate-200 bg-panel shadow-[var(--elev-subtle)]">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
        <h2 className="text-[13px] font-semibold text-slate-700">{title}</h2>
        {total && (
          <span className={`tnum text-[13px] font-semibold ${sum < 0 ? 'text-red-600' : 'text-slate-800'}`}>
            {fmt(sum, c)}
          </span>
        )}
      </div>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-[11px] text-slate-400">
            <th className="pt-2 pb-1 pl-4 text-left font-medium">Account</th>
            <th className="px-4 pt-2 pb-1 text-right font-medium">Cleared</th>
            <th className="px-4 pt-2 pb-1 text-right font-medium">Uncleared</th>
            <th className="px-4 pt-2 pb-1 text-right font-medium">Working</th>
            <th className="pr-4 pt-2 pb-1 text-right font-medium">Upcoming</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => (
            <AccountRow key={a.id} a={a} c={c} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function AccountsView() {
  const meta = useOutletContext<BudgetMeta>()
  const c: Currency = {
    symbol: meta.budget.currencySymbol,
    digits: meta.budget.decimalDigits,
    locale: meta.budget.locale,
  }
  const open = meta.accounts.filter((a) => !a.closed)
  const closed = meta.accounts.filter((a) => a.closed)
  const onBudget = open.filter((a) => a.onBudget)
  const tracking = open.filter((a) => !a.onBudget)
  const onBudgetTotal = onBudget.reduce((s, a) => s + a.working, 0)
  const trackingTotal = tracking.reduce((s, a) => s + a.working, 0)
  const netWorth = meta.accounts.reduce((s, a) => s + a.working, 0)

  return (
    <div className="flex h-full flex-col bg-slate-50">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-panel px-6">
        <h1 className="text-[15px] font-semibold tracking-tight text-slate-900">Accounts</h1>
        <span className="text-[12px] text-slate-400">
          {open.length} open{closed.length > 0 ? ` · ${closed.length} closed` : ''}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="flex flex-wrap gap-3">
          <StatCard label="On budget" value={onBudgetTotal} c={c} negative={onBudgetTotal < 0} />
          <StatCard label="Tracking" value={trackingTotal} c={c} negative={trackingTotal < 0} />
          <StatCard label="Net worth" value={netWorth} c={c} negative={netWorth < 0} />
        </div>

        <div className="mt-5 flex flex-col gap-4">
          <AccountSection title="On-budget accounts" accounts={onBudget} c={c} total />
          <AccountSection title="Tracking accounts" accounts={tracking} c={c} total />
          <AccountSection title="Closed accounts" accounts={closed} c={c} />
        </div>

        {meta.accounts.length === 0 && (
          <div className="mt-6 rounded-[10px] border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">
            No accounts yet — use "+ Add Account" in the sidebar to create one.
          </div>
        )}
      </div>
    </div>
  )
}