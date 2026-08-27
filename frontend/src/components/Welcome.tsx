import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api, errMsg } from '../api'
import { parseAmount, normalizeAmount } from '../format'
import AssistantConfigForm from './AssistantConfigForm'

// First-run wizard: a fresh clone has an empty database, so App renders this
// instead of the shell until a budget exists. Three steps: budget (+ starter
// categories), first account, assistant provider (optional). Every mutation
// is a regular logged endpoint — everything stays editable later.

const CURRENCIES = ['€', '$', '£', '¥', 'CHF']
const LOCALES = [
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
  ['de-DE', 'Deutsch'],
  ['it-IT', 'Italiano'],
  ['fr-FR', 'Français'],
  ['es-ES', 'Español'],
]
const ACCOUNT_TYPES = [
  ['checking', 'Checking'],
  ['savings', 'Savings'],
  ['cash', 'Cash'],
  ['creditCard', 'Credit Card'],
  ['otherAsset', 'Tracking (Asset)'],
  ['otherLiability', 'Tracking (Liability)'],
]

export default function Welcome() {
  const qc = useQueryClient()
  const { data: setup } = useSetup()
  const [step, setStep] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // step 1
  const [name, setName] = useState('My Budget')
  const [symbol, setSymbol] = useState('€')
  const [locale, setLocale] = useState('en-US')
  const [starter, setStarter] = useState(true)
  // step 2
  const [acctName, setAcctName] = useState('')
  const [acctType, setAcctType] = useState('checking')
  const [balance, setBalance] = useState('')
  // step 4 (done)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)

  // assistant form's onSaved — stay inside the wizard; the shell appears only
  // when the user clicks "Open my budget"
  const finish = () => setStep(4)

  const createBudget = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.setupCreateBudget({
        name,
        currencySymbol: symbol,
        decimalDigits: 2,
        locale,
        starterCategories: starter,
      })
      // deliberately NOT refreshing the ['setup'] cache here: flipping
      // hasBudget would unmount the wizard and jump straight to the shell.
      setStep(2)
    } catch (e) {
      setError(errMsg(e as Error))
    } finally {
      setBusy(false)
    }
  }

  const createAccount = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.createAccount({ name: acctName, type: acctType, balance: parseAmount(balance) })
      qc.invalidateQueries({ queryKey: ['budget'] })
      setStep(3)
    } catch (e) {
      setError(errMsg(e as Error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid h-full place-items-center bg-slate-50 p-6">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-panel p-6 shadow-[var(--elev-popover)]">
        <div className="mb-1 flex items-center gap-2">
          <div className="grid h-[22px] w-[22px] place-items-center rounded border border-blue-400/50 text-[11px] font-bold text-blue-400">
            yc
          </div>
          <span className="text-[13px] font-semibold tracking-tight text-slate-900">Welcome to your budget</span>
        </div>

        {/* progress dots */}
        <div className="mb-4 mt-3 flex gap-1.5">
          {[1, 2, 3, 4].map((n) => (
            <div
              key={n}
              className={`h-1 flex-1 rounded-full ${n < step ? 'bg-emerald-500' : n === step ? 'bg-accent' : 'bg-slate-200'}`}
            />
          ))}
        </div>

        {error && <div className="mb-3 rounded bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>}

        {step === 1 && (
          <>
            <h1 className="text-[16px] font-semibold text-slate-900">Create your budget</h1>
            <p className="mt-1 text-[12px] text-slate-500">
              It starts this month. Money you already have gets assigned to categories from here on.
            </p>
            <label className="mt-4 block text-[11px] font-medium text-slate-500">
              Budget name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5 text-[13px] text-slate-800"
              />
            </label>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="text-[11px] font-medium text-slate-500">
                Currency
                <select
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value)}
                  className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5 text-[13px] text-slate-800"
                >
                  {CURRENCIES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-[11px] font-medium text-slate-500">
                Number format
                <select
                  value={locale}
                  onChange={(e) => setLocale(e.target.value)}
                  className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5 text-[13px] text-slate-800"
                >
                  {LOCALES.map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="mt-3 flex items-start gap-2 text-[12px] text-slate-600">
              <input type="checkbox" checked={starter} onChange={(e) => setStarter(e.target.checked)} className="mt-0.5" />
              <span>
                Add starter categories
                <span className="block text-[10px] text-slate-400">Bills, Everyday, Fun, Savings — rename or delete later</span>
              </span>
            </label>
            <button
              onClick={createBudget}
              disabled={busy || !name.trim()}
              className="mt-5 w-full rounded bg-accent px-3 py-2 text-[13px] font-medium text-white hover:bg-accent-hover disabled:opacity-40"
            >
              {busy ? 'Creating…' : 'Create budget'}
            </button>
          </>
        )}

        {step === 2 && (
          <>
            <h1 className="text-[16px] font-semibold text-slate-900">Add your first account</h1>
            <p className="mt-1 text-[12px] text-slate-500">
              The balance you have today becomes Ready to Assign — the money waiting for a job.
            </p>
            <label className="mt-4 block text-[11px] font-medium text-slate-500">
              Account name
              <input
                value={acctName}
                onChange={(e) => setAcctName(e.target.value)}
                placeholder="e.g. Main Checking"
                className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5 text-[13px] text-slate-800"
              />
            </label>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="text-[11px] font-medium text-slate-500">
                Type
                <select
                  value={acctType}
                  onChange={(e) => setAcctType(e.target.value)}
                  className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5 text-[13px] text-slate-800"
                >
                  {ACCOUNT_TYPES.map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-[11px] font-medium text-slate-500">
                Current balance
                <input
                  value={balance}
                  onChange={(e) => setBalance(e.target.value)}
                  onBlur={(e) => setBalance(normalizeAmount(e.target.value))}
                  placeholder={symbol === '€' ? '1.250,00' : '1,250.00'}
                  className="tnum mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5 text-[13px] text-slate-800"
                />
              </label>
            </div>
            <div className="mt-5 flex gap-2">
              <button
                onClick={() => setStep(3)}
                className="rounded border border-slate-300 px-3 py-2 text-[13px] text-slate-600 hover:bg-slate-100"
              >
                Later
              </button>
              <button
                onClick={createAccount}
                disabled={busy || !acctName.trim()}
                className="flex-1 rounded bg-accent px-3 py-2 text-[13px] font-medium text-white hover:bg-accent-hover disabled:opacity-40"
              >
                {busy ? 'Adding…' : 'Add account'}
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h1 className="text-[16px] font-semibold text-slate-900">Set up the AI assistant</h1>
            <p className="mt-1 text-[12px] text-slate-500">
              Optional — the assistant answers questions about your budget and can make changes for
              you. Bring any OpenAI-compatible provider key.
            </p>
            <div className="mt-4">
              <AssistantConfigForm
                initial={{
                  model: setup?.chat.model ?? '',
                  baseUrl: setup?.chat.baseUrl ?? '',
                  keyTail: setup?.chat.keyTail ?? null,
                  configured: setup?.chat.configured ?? false,
                }}
                onSaved={(msg) => {
                  setSavedMsg(msg)
                  finish()
                }}
              />
            </div>
            <button
              onClick={() => setStep(4)}
              className="mt-4 w-full rounded border border-slate-300 px-3 py-2 text-[12px] text-slate-500 hover:bg-slate-100"
            >
              Skip for now — configure later from the Assistant page
            </button>
          </>
        )}

        {step === 4 && (
          <div className="py-2 text-center">
            <div className="text-3xl">🎉</div>
            <h1 className="mt-2 text-[16px] font-semibold text-slate-900">You're all set</h1>
            <p className="mt-1 text-[12px] text-slate-500">
              {savedMsg ? `${savedMsg} ` : ''}
              Assign every unit of money a job, record transactions as they happen, and the
              reports tell you where you stand.
            </p>
            <button
              onClick={() => {
                qc.invalidateQueries({ queryKey: ['setup'] })
                qc.invalidateQueries({ queryKey: ['budget'] })
              }}
              className="mt-5 w-full rounded bg-accent px-3 py-2 text-[13px] font-medium text-white hover:bg-accent-hover"
            >
              Open my budget
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// tiny local hook to avoid a circular import with App
import { useQuery } from '@tanstack/react-query'
function useSetup() {
  return useQuery({ queryKey: ['setup'], queryFn: api.setupStatus })
}
