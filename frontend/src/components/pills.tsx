import type { TargetState } from '../api'

// YNAB "Available" pill colouring.
export function availablePill(available: number, target?: TargetState, overspendType?: string | null): string {
  if (available < 0)
    return overspendType === 'credit'
      ? 'bg-amber-50 text-amber-700 border-amber-200' // credit overspend — debt, not missing cash
      : 'bg-red-50 text-red-600 border-red-200' // overspent (cash or mixed)
  if (target?.state === 'underfunded') return 'bg-amber-50 text-amber-700 border-amber-200' // funded short of target
  if (available === 0) return 'bg-slate-100 text-slate-500 border-slate-200'
  return 'bg-emerald-50 text-emerald-700 border-emerald-200' // funded
}

// "Ready to Assign" banner colouring.
export function rtaPill(rta: number): string {
  if (rta > 0) return 'bg-emerald-50 text-emerald-700 border-emerald-200'
  if (rta < 0) return 'bg-red-50 text-red-600 border-red-200'
  return 'bg-panel text-slate-700 border-slate-200'
}

export function rtaLabel(rta: number): string {
  if (rta > 0) return 'Ready to Assign'
  if (rta < 0) return 'You assigned more than you have'
  return 'All Money Assigned'
}
