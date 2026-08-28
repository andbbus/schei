import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, errMsg } from '../api'
import { normalizeAmount, parseAmount } from '../format'
import Modal, { fieldInput, fieldLabel, ghostBtn, primaryBtn } from './Modal'

const TYPES = [
  ['checking', 'Checking'],
  ['savings', 'Savings'],
  ['cash', 'Cash'],
  ['creditCard', 'Credit card'],
  ['otherAsset', 'Tracking asset'],
  ['otherLiability', 'Tracking liability'],
] as const

const HINTS: Record<string, string> = {
  creditCard: 'Creates the card’s payment category automatically.',
  otherAsset: 'Off-budget — tracked, but not part of Ready to Assign.',
  otherLiability: 'Off-budget — tracked, but not part of Ready to Assign.',
}

// Centered "New account" dialog (replaces the old inline sidebar form).
export default function AccountModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [type, setType] = useState<string>('checking')
  const [balance, setBalance] = useState('')
  const [error, setError] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () => api.createAccount({ name: name.trim(), type, balance: parseAmount(balance) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['budget'] })
      qc.invalidateQueries({ queryKey: ['accounts'] })
      onClose()
    },
    onError: (e: Error) => setError(errMsg(e)),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return setError('Give the account a name.')
    setError(null)
    create.mutate()
  }

  return (
    <Modal title="New account" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        <label className="block">
          <span className={fieldLabel}>Name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Main checking"
            className={fieldInput}
          />
        </label>
        <label className="block">
          <span className={fieldLabel}>Type</span>
          <select value={type} onChange={(e) => setType(e.target.value)} className={fieldInput}>
            {TYPES.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
          {HINTS[type] && <span className="mt-1 block text-[11px] text-slate-400">{HINTS[type]}</span>}
        </label>
        <label className="block">
          <span className={fieldLabel}>Starting balance</span>
          <input
            value={balance}
            onChange={(e) => setBalance(e.target.value)}
            onBlur={(e) => setBalance(normalizeAmount(e.target.value))}
            placeholder="0 (a Starting Balance transaction is created)"
            inputMode="decimal"
            className={`${fieldInput} tnum`}
          />
        </label>
        {error && <div className="rounded bg-red-50 px-2.5 py-1.5 text-[12px] text-red-600">{error}</div>}
        <div className="mt-1 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={ghostBtn}>
            Cancel
          </button>
          <button type="submit" disabled={create.isPending} className={primaryBtn}>
            Create account
          </button>
        </div>
      </form>
    </Modal>
  )
}
