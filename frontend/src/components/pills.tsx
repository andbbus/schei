import type { TargetState } from '../api'

// YNAB "Available" pill colouring.
export function availablePill(available: number, target?: TargetState, overspendType?: string | null): string {
  if (available < 0)
    return overspendType === 'credit'
      ? 'bg-amber-400 text-amber-950' // credit overspend — debt, not missing cash
      : 'bg-red-500 text-white' // overspent (cash or mixed)
  if (target?.state === 'underfunded') return 'bg-amber-200 text-amber-900' // funded short of target
  if (available === 0) return 'bg-slate-200 text-slate-500'
  return 'bg-emerald-100 text-emerald-800' // funded
}

// "Ready to Assign" banner colouring.
export function rtaPill(rta: number): string {
  if (rta > 0) return 'bg-emerald-500 text-white'
  if (rta < 0) return 'bg-red-500 text-white'
  return 'bg-slate-200 text-slate-700'
}

export function rtaLabel(rta: number): string {
  if (rta > 0) return 'Ready to Assign'
  if (rta < 0) return 'You assigned more than you have'
  return 'All Money Assigned'
}
