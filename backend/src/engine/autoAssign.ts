// Auto-assign — the inspector's quick-fund buttons. Each returns the NEW
// `assigned` value for a category in a given month.

import { addMonths } from './budget';

export type AutoAssignMode =
  | 'underfunded'
  | 'assignedLastMonth'
  | 'spentLastMonth'
  | 'averageAssigned'
  | 'averageSpent'
  | 'resetAvailable'
  | 'resetAssigned';

export interface CatMonth {
  assigned: number;
  activity: number;
  available: number;
}

export function autoAssignAmount(
  mode: AutoAssignMode,
  month: string,
  history: Record<string, CatMonth>,
  underfunded: number,
  avgMonths = 3,
): number {
  const cur = history[month] ?? { assigned: 0, activity: 0, available: 0 };
  const prev = history[addMonths(month, -1)];

  switch (mode) {
    case 'underfunded':
      return cur.assigned + Math.max(0, underfunded);
    case 'assignedLastMonth':
      return prev?.assigned ?? 0;
    case 'spentLastMonth':
      return -(prev?.activity ?? 0) || 0; // || 0 normalizes -0 (missing history)
    case 'averageAssigned': {
      let sum = 0;
      for (let i = 1; i <= avgMonths; i++) sum += history[addMonths(month, -i)]?.assigned ?? 0;
      return Math.round(sum / avgMonths) || 0;
    }
    case 'averageSpent': {
      let sum = 0;
      for (let i = 1; i <= avgMonths; i++) sum += -(history[addMonths(month, -i)]?.activity ?? 0);
      return (Math.round(sum / avgMonths) || 0);
    }
    case 'resetAvailable':
      return (cur.assigned - cur.available) || 0; // makes available exactly 0
    case 'resetAssigned':
      return 0;
  }
}

// Month-level "Underfunded" quick budget: fill every category's target
// shortfall, but never assign more than Ready-to-Assign allows. Shortfalls are
// funded largest-first (YNAB's ordering) and the last categories eat the
// remainder. Pure — the route turns the plan into upserts + one undo op.
export interface UnderfundedItem {
  categoryId: string;
  underfunded: number; // positive shortfall to cover
}

export function planUnderfunded(
  items: UnderfundedItem[],
  rta: number,
): { categoryId: string; add: number }[] {
  const positive = items
    .filter((i) => i.underfunded > 0)
    .sort((a, b) => b.underfunded - a.underfunded);
  let budget = Math.max(0, rta);
  const plan: { categoryId: string; add: number }[] = [];
  for (const item of positive) {
    if (budget <= 0) break;
    const add = Math.min(item.underfunded, budget);
    plan.push({ categoryId: item.categoryId, add });
    budget -= add;
  }
  return plan;
}
