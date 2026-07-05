// Target (goal) math — YNAB Rule 2, "Embrace Your True Expenses".
// goal_type: MF (monthly funding), NEED (needed for spending), TB (target
// balance), TBD (target balance by date).
//
// ponytail: the common flavors (Monthly, Need-monthly/weekly, Have-a-balance,
// Balance-by-date) are implemented faithfully; yearly and a few rare cadences
// fall back to the monthly treatment. Refine when a real target needs it.

export type GoalType = 'MF' | 'NEED' | 'TB' | 'TBD' | null;

export interface TargetInput {
  goalType: GoalType;
  goalTarget: number | null; // milliunits
  goalCadence: string | null; // monthly | weekly | yearly | byDate
  goalDay: number | null; // 0-6 for weekly
  goalTargetMonth: string | null; // "YYYY-MM-01"
  goalNeedsWholeAmount: boolean | null; // NEED: true = refill up to, false = set aside
}

export interface TargetState {
  hasTarget: boolean;
  neededThisMonth: number; // total the category wants funded this month
  underfunded: number; // still needed to assign this month
  progress: number; // 0..1
  state: 'none' | 'funded' | 'underfunded';
}

const NONE: TargetState = { hasTarget: false, neededThisMonth: 0, underfunded: 0, progress: 0, state: 'none' };

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function weekdayOccurrences(month: string, day: number): number {
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let count = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === day) count++;
  }
  return count;
}

export function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}

export function computeTarget(
  t: TargetInput,
  ctx: { month: string; assignedThisMonth: number; available: number },
): TargetState {
  if (!t.goalType || t.goalTarget == null) return NONE;
  const target = t.goalTarget;
  const { month, assignedThisMonth, available } = ctx;
  const availableBeforeAssign = available - assignedThisMonth;

  const result = (neededThisMonth: number, underfunded: number, progressDenom: number): TargetState => ({
    hasTarget: true,
    neededThisMonth,
    underfunded: Math.max(0, underfunded),
    progress: progressDenom > 0 ? clamp01(available / progressDenom) : available >= 0 ? 1 : 0,
    state: underfunded > 0 ? 'underfunded' : 'funded',
  });

  switch (t.goalType) {
    case 'MF':
      // Refill available up to `target` each month.
      return result(target, target - available, target);

    case 'TB':
      // Have a balance of `target` (no date). Top up toward it.
      return result(Math.max(0, target - availableBeforeAssign), target - available, target);

    case 'TBD': {
      // Reach `target` by a date — spread the remaining over months left.
      const monthsLeft = t.goalTargetMonth ? Math.max(1, monthsBetween(month, t.goalTargetMonth) + 1) : 1;
      const remaining = Math.max(0, target - availableBeforeAssign);
      const needed = Math.ceil(remaining / monthsLeft);
      return result(needed, needed - assignedThisMonth, target);
    }

    case 'NEED': {
      if (t.goalCadence === 'byDate' && t.goalTargetMonth) {
        const monthsLeft = Math.max(1, monthsBetween(month, t.goalTargetMonth) + 1);
        const remaining = Math.max(0, target - availableBeforeAssign);
        const needed = Math.ceil(remaining / monthsLeft);
        return result(needed, needed - assignedThisMonth, target);
      }
      const perMonth =
        t.goalCadence === 'weekly' && t.goalDay != null
          ? target * weekdayOccurrences(month, t.goalDay)
          : target; // monthly / yearly-as-monthly fallback
      if (t.goalNeedsWholeAmount === false) {
        // "Set aside another X" — assign X this month regardless of carryover.
        return result(perMonth, perMonth - assignedThisMonth, perMonth);
      }
      // "Refill up to X" — top available up to X.
      return result(perMonth, perMonth - available, perMonth);
    }

    default:
      return NONE;
  }
}
