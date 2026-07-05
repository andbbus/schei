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
      return -(prev?.activity ?? 0);
    case 'averageAssigned': {
      let sum = 0;
      for (let i = 1; i <= avgMonths; i++) sum += history[addMonths(month, -i)]?.assigned ?? 0;
      return Math.round(sum / avgMonths);
    }
    case 'averageSpent': {
      let sum = 0;
      for (let i = 1; i <= avgMonths; i++) sum += -(history[addMonths(month, -i)]?.activity ?? 0);
      return Math.round(sum / avgMonths);
    }
    case 'resetAvailable':
      return cur.assigned - cur.available; // makes available exactly 0
    case 'resetAssigned':
      return 0;
  }
}
