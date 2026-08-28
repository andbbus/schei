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
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <div className="text-[11px] font-semibold tracking-[0.06em] text-slate-400 uppercase">{label}</div>
      <div className={`tnum text-lg font-semibold ${negative ? 'text-red-600' : 'text-slate-900'}`}>{fmt(value, c)}</div>
    </div>
  )
}

function AccountRow({ a, c }: { a: AccountLite; c: Currency }) {
  return (
    <tr className={`border-b border-slate-100 last:border-0 ${a.closed ? 'opacity-60' : 'hover:bg-slate-50'}`}>
      <td className="py-2.5 pr-3">
        <Link to={`/accounts/${a.id}`} className="block">
          <span className="font-medium text-slate-800 hover:text-blue-600">{a.name}</span>
          <span className="ml-2 text-[11px] text-slate-400">{typeLabel(a.type)}</span>
          {a.type === 'creditCard' && (
            <span className="ml-1 rounded bg-slate-100 px-1 text-[10px] text-slate-500">card</span>
          )}
          {a.closed && <span className="ml-1 rounded bg-slate-200 px-1 text-[10px] text-slate-500">closed</span>}
        </Link>
      </td>
      <td className="tnum py-2.5 pr-3 text-right text-slate-600">{fmt(a.cleared, c)}</td>
      <td className="tnum py-2.5 pr-3 text-right text-slate-600">{fmt(a.uncleared, c)}</td>
      <td className={`tnum py-2.5 pr-3 text-right font-semibold ${a.working < 0 ? 'text-red-600' : 'text-slate-900'}`}>
        {fmt(a.working, c)}
      </td>
      <td className={`tnum py-2.5 text-right text-slate-400 ${a.upcoming === 0 ? 'text-slate-200' : ''}`}>
        {a.upcoming === 0 ? '—' : fmt(a.upcoming, c)}
      </td>
    </tr>
  )
}

function AccountSection({ title, accounts, c, total }: { title: string; accounts: AccountLite[]; c: Currency; total?: boolean }) {
  if (accounts.length === 0) return null
  const sum = accounts.reduce((s, a) => s + a.working, 0)
  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
        <h2 className="text-[13px] font-semibold text-slate-700">{title}</h2>
        {total && (
          <span className={`tnum text-[13px] font-semibold ${sum < 0 ? 'text-red-600' : 'text-slate-800'}`}>
            {fmt(sum, c)}
          </span>
        )}
      </div>
      <table className="w-full px-4 text-[13px]">
        <thead>
          <tr className="text-left text-[11px] text-slate-400">
            <th className="px-4 pt-2.5 pb-1 font-medium">Account</th>
            <th className="px-3 pt-2.5 pb-1 text-right font-medium">Cleared</th>
            <th className="px-3 pt-2.5 pb-1 text-right font-medium">Uncleared</th>
            <th className="px-3 pt-2.5 pb-1 text-right font-medium">Working</th>
            <th className="pr-4 pt-2.5 pb-1 text-right font-medium">Upcoming</th>
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
    <div className="h-full overflow-y-auto p-5">
      <h1 className="text-xl font-semibold text-slate-800">Accounts</h1>
      <p className="mt-0.5 text-sm text-slate-400">Overview of all accounts — click a row to open its register.</p>

      <div className="mt-4 flex flex-wrap gap-3">
        <StatCard label="On budget" value={onBudgetTotal} c={c} negative={onBudgetTotal < 0} />
        <StatCard label="Tracking" value={trackingTotal} c={c} negative={trackingTotal < 0} />
        <StatCard label="Net worth" value={netWorth} c={c} negative={netWorth < 0} />
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
          <div className="text-[11px] font-semibold tracking-[0.06em] text-slate-400 uppercase">Accounts</div>
          <div className="tnum text-lg font-semibold text-slate-900">{open.length}</div>
        </div>
      </div>

      <div className="mt-5 flex flex-col gap-4">
        <AccountSection title="On-budget accounts" accounts={onBudget} c={c} total />
        <AccountSection title="Tracking accounts" accounts={tracking} c={c} total />
        <AccountSection title="Closed accounts" accounts={closed} c={c} />
      </div>

      {meta.accounts.length === 0 && (
        <div className="mt-8 rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">
          No accounts yet — use "+ Add Account" in the sidebar to create one.
        </div>
      )}
    </div>
  )
}