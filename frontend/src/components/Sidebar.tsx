import { NavLink } from 'react-router-dom'
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { BudgetMeta, AccountLite } from '../api'
import { api } from '../api'
import { fmt, parseAmount, normalizeAmount, type Currency } from '../format'

function NavItem({ to, label, icon, end }: { to: string; label: string; icon: string; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center gap-2 rounded-md px-2 py-[7px] text-[13px] transition-colors duration-100 ${
          isActive ? 'bg-white/15 font-semibold text-white' : 'font-medium text-indigo-100 hover:bg-white/10'
        }`
      }
    >
      <span className="w-4 text-center opacity-85">{icon}</span>
      {label}
    </NavLink>
  )
}

function AccountItem({ a, c }: { a: AccountLite; c: Currency }) {
  return (
    <NavLink
      to={`/accounts/${a.id}`}
      className={({ isActive }) =>
        `flex items-center justify-between rounded-md px-2 py-[6px] text-[13px] transition-colors duration-100 ${
          isActive ? 'bg-white/15 text-white' : 'text-indigo-100 hover:bg-white/10'
        }`
      }
    >
      <span className="truncate pr-2 text-[#e4e5f6]">{a.name}</span>
      <span className={`tnum shrink-0 font-medium ${a.working < 0 ? 'text-[#ff9a9a]' : 'text-white'}`}>{fmt(a.working, c)}</span>
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
    <aside className="sidebar-grad print-hide flex h-full w-60 shrink-0 flex-col gap-5 overflow-y-auto px-3 py-5 pb-4 text-indigo-100">
      <div className="flex items-center gap-2.5 px-2">
        <div className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-md bg-emerald-500 text-xs font-bold text-[#06301f]">
          yc
        </div>
        <div>
          <div className="text-[14px] font-semibold tracking-tight text-white">{meta.budget.name}</div>
          <div className="text-[11px] text-[#b9bbe0]">Owner</div>
        </div>
      </div>

      <nav className="flex flex-col gap-0.5">
        <NavItem to="/" label="Budget" icon="📊" end />
        <NavItem to="/reflect" label="Reflect" icon="📈" />
        <NavItem to="/debts" label="Debts" icon="📉" />
        <NavItem to="/goals" label="Goals" icon="🎯" />
        <NavItem to="/subscriptions" label="Subscriptions" icon="🔁" />
        <NavItem to="/shopping" label="Shopping" icon="🛒" />
      </nav>

      <div className="flex flex-col gap-0.5">
        <div className="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-[0.06em] text-[#b9bbe0] uppercase">
          <div className="flex justify-between">
            <span>Budget</span>
            <span className="tnum">{fmt(total(budgetAccts), c)}</span>
          </div>
        </div>
        <div className="flex flex-col gap-px">
          {budgetAccts.map((a) => (
            <AccountItem key={a.id} a={a} c={c} />
          ))}
        </div>
      </div>

      {trackingAccts.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <div className="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-[0.06em] text-[#b9bbe0] uppercase">
            <div className="flex justify-between">
              <span>Tracking</span>
              <span className="tnum">{fmt(total(trackingAccts), c)}</span>
            </div>
          </div>
          <div className="flex flex-col gap-px">
            {trackingAccts.map((a) => (
              <AccountItem key={a.id} a={a} c={c} />
            ))}
          </div>
        </div>
      )}

      <div className="px-2 pt-2">
        {adding ? (
          <AddAccount onCancel={() => setAdding(false)} onCreate={(b) => create.mutate(b)} />
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="w-full rounded-md px-2 py-[7px] text-left text-[13px] font-medium text-indigo-200 transition-colors hover:bg-white/10"
          >
            + Add Account
          </button>
        )}
      </div>

      <div className="mt-auto border-t border-white/10 px-2 pt-3 text-xs">
        <div className="text-[#b9bbe0]">Age of Money</div>
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
        onBlur={(e) => setBalance(normalizeAmount(e.target.value))}
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
