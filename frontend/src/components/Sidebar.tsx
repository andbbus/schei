import { NavLink } from 'react-router-dom'
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { BudgetMeta, AccountLite } from '../api'
import { api } from '../api'
import { fmt, parseAmount, type Currency } from '../format'

function NavItem({ to, label, icon, end }: { to: string; label: string; icon: string; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center gap-2 rounded px-3 py-1.5 text-sm ${
          isActive ? 'bg-white/15 text-white font-medium' : 'text-indigo-100 hover:bg-white/10'
        }`
      }
    >
      <span className="w-4 text-center">{icon}</span>
      {label}
    </NavLink>
  )
}

function AccountItem({ a, c }: { a: AccountLite; c: Currency }) {
  return (
    <NavLink
      to={`/accounts/${a.id}`}
      className={({ isActive }) =>
        `flex items-center justify-between rounded px-3 py-1 text-[13px] ${
          isActive ? 'bg-white/15 text-white' : 'text-indigo-100 hover:bg-white/10'
        }`
      }
    >
      <span className="truncate pr-2">{a.name}</span>
      <span className={`tnum shrink-0 ${a.working < 0 ? 'text-red-300' : 'text-indigo-200'}`}>{fmt(a.working, c)}</span>
    </NavLink>
  )
}

export default function Sidebar({ meta }: { meta: BudgetMeta }) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const c: Currency = {
    symbol: meta.budget.currencySymbol,
    digits: meta.budget.decimalDigits,
    locale: meta.budget.locale,
  }
  const budgetAccts = meta.accounts.filter((a) => a.onBudget && !a.closed)
  const trackingAccts = meta.accounts.filter((a) => !a.onBudget && !a.closed)
  const total = (arr: AccountLite[]) => arr.reduce((s, a) => s + a.working, 0)

  const create = useMutation({
    mutationFn: (b: Record<string, unknown>) => api.createAccount(b),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['budget'] })
      setAdding(false)
    },
  })

  return (
    <aside className="sidebar-grad flex h-full w-64 shrink-0 flex-col text-indigo-100">
      <div className="px-4 py-4">
        <div className="text-[15px] font-semibold text-white">{meta.budget.name}</div>
        <div className="text-xs text-indigo-300">Owner</div>
      </div>

      <nav className="space-y-0.5 px-2">
        <NavItem to="/" label="Budget" icon="📊" end />
        <NavItem to="/reflect" label="Reflect" icon="📈" />
      </nav>

      <div className="mt-5 mb-1 flex justify-between px-4 text-[11px] tracking-wide text-indigo-300 uppercase">
        <span>Budget</span>
        <span className="tnum">{fmt(total(budgetAccts), c)}</span>
      </div>
      <div className="space-y-px overflow-y-auto px-2">
        {budgetAccts.map((a) => (
          <AccountItem key={a.id} a={a} c={c} />
        ))}
      </div>

      {trackingAccts.length > 0 && (
        <>
          <div className="mt-4 mb-1 flex justify-between px-4 text-[11px] tracking-wide text-indigo-300 uppercase">
            <span>Tracking</span>
            <span className="tnum">{fmt(total(trackingAccts), c)}</span>
          </div>
          <div className="space-y-px px-2">
            {trackingAccts.map((a) => (
              <AccountItem key={a.id} a={a} c={c} />
            ))}
          </div>
        </>
      )}

      <div className="px-2 pt-2">
        {adding ? (
          <AddAccount onCancel={() => setAdding(false)} onCreate={(b) => create.mutate(b)} />
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="w-full rounded px-3 py-1.5 text-left text-[13px] text-indigo-200 hover:bg-white/10"
          >
            + Add Account
          </button>
        )}
      </div>

      <div className="mt-auto border-t border-white/10 px-4 py-3 text-xs">
        <div className="text-indigo-300">Age of Money</div>
        <div className="text-lg font-semibold text-white">
          {meta.ageOfMoney ?? '–'} <span className="text-sm font-normal text-indigo-200">days</span>
        </div>
      </div>
    </aside>
  )
}

function AddAccount({
  onCancel,
  onCreate,
}: {
  onCancel: () => void
  onCreate: (b: Record<string, unknown>) => void
}) {
  const [name, setName] = useState('')
  const [type, setType] = useState('checking')
  const [balance, setBalance] = useState('')
  return (
    <div className="rounded bg-white/10 p-2 text-[13px]">
      <input
        autoFocus
        placeholder="Account name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="mb-1 w-full rounded bg-white/90 px-2 py-1 text-slate-800"
      />
      <select value={type} onChange={(e) => setType(e.target.value)} className="mb-1 w-full rounded bg-white/90 px-2 py-1 text-slate-800">
        <option value="checking">Checking</option>
        <option value="savings">Savings</option>
        <option value="cash">Cash</option>
        <option value="creditCard">Credit Card</option>
        <option value="otherAsset">Tracking (Asset)</option>
        <option value="otherLiability">Tracking (Liability)</option>
      </select>
      <input
        placeholder="Starting balance"
        value={balance}
        onChange={(e) => setBalance(e.target.value)}
        className="mb-1 w-full rounded bg-white/90 px-2 py-1 text-slate-800"
      />
      <div className="flex gap-1">
        <button
          onClick={() => onCreate({ name, type, balance: parseAmount(balance) })}
          disabled={!name}
          className="flex-1 rounded bg-emerald-500 px-2 py-1 text-white disabled:opacity-50"
        >
          Add
        </button>
        <button onClick={onCancel} className="rounded bg-white/20 px-2 py-1">
          Cancel
        </button>
      </div>
    </div>
  )
}
