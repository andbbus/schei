// Cash-flow projection: what future months look like given known schedules,
// trailing-average income/spending, and the user's own assigned amounts.
// Pure; no I/O. All amounts signed milliunits (negative = outflow) except
// projectedSpending/projectedIncome which are positive magnitudes for display.

import { addMonths, listMonths, monthOf } from './budget';
import { BudgetComputation, EngineAccount, EngineTxn } from './types';
import { nextOccurrence } from './schedule';
import { computeTarget, TargetInput } from './targets';

export interface ScheduledLike {
  id: string;
  accountId: string;
  payeeId: string | null;
  payee?: string | null;
  categoryId: string | null;
  amount: number;
  frequency: string;
  nextDate: string;
  anchorDay: number | null;
  endMonth?: string | null;
  transferAccountId: string | null;
}

export interface ScheduleOccurrence {
  date: string;
  payee: string;
  amount: number;
  frequency: string;
  categoryId: string | null;
  source: 'scheduled' | 'upcoming';
}

export interface CashflowRow {
  month: string;
  partial: boolean;
  knownScheduledNet: number;
  projectedIncome: number;
  projectedSpending: number;
  projectedAssigned: number;
  projectedNet: number;
  projectedRTA: number | null;
  overridesUsed: number; // categories whose projected expense is a manual override
  schedules: ScheduleOccurrence[];
}

export interface CashflowResult {
  anchorRta: number;
  anchorMonth: string;
  historyMonths: number;
  sufficient: boolean;
  horizonMonths: number;
  rows: CashflowRow[];
}

export function projectCashflow(params: {
  comp: BudgetComputation;
  currentMonth: string;
  horizonMonths: number;
  today: string;
  accounts: EngineAccount[];
  txns: EngineTxn[];
  inflowCatId: string | null;
  paymentCatIds: Set<string>;
  systemPayeeIds: Set<string>;
  scheduled: ScheduledLike[];
  targetCats?: TargetInput[];
  overrides?: { categoryId: string; month: string; amount: number }[];
}): CashflowResult {
  const { comp, currentMonth, horizonMonths, today, accounts, txns, inflowCatId, paymentCatIds, systemPayeeIds, scheduled, targetCats = [], overrides = [] } = params;
  const onBudgetTarget = new Map(accounts.map((a) => [a.id, a.onBudget]));
  const horizonEnd = addMonths(currentMonth, horizonMonths);
  const horizon = listMonths(addMonths(currentMonth, 1), horizonEnd);

  // per-(category, month) projected-expense overrides: they win over averages
  const overrideByMonthCat = new Map<string, Map<string, number>>();
  for (const o of overrides) {
    const row = overrideByMonthCat.get(o.month) ?? new Map<string, number>();
    row.set(o.categoryId, o.amount);
    overrideByMonthCat.set(o.month, row);
  }

  const completedMonths = new Set<string>();
  for (const m of comp.monthCategories) if (m.month < currentMonth) completedMonths.add(m.month);
  const historyMonths = completedMonths.size;
  const paymentSet = new Set(paymentCatIds);

  // Seasonal adjustment: if a month's value exists for the same calendar month
  // a year earlier, blend it with the flat average (50/50). Weak history (few
  // samples) returns the flat average unchanged.
  const seasonalFactor = (byMonth: Map<string, number>, month: string, avg: number): number => {
    if (byMonth.size < 6 || avg === 0) return 1;
    const prevYear = `${Number(month.slice(0, 4)) - 1}-${month.slice(5, 7)}-01`;
    const prev = byMonth.get(prevYear);
    if (prev === undefined) return 1;
    return 0.5 + 0.5 * (prev / avg);
  };

  // per-category per-month activity (completed months, payment cats excluded)
  const catActivity = new Map<string, Map<string, number>>();
  for (const mc of comp.monthCategories) {
    if (!completedMonths.has(mc.month) || paymentSet.has(mc.categoryId)) continue;
    const row = catActivity.get(mc.categoryId) ?? new Map<string, number>();
    row.set(mc.month, mc.activity);
    catActivity.set(mc.categoryId, row);
  }
  const catAvg = new Map<string, number>();
  for (const [cat, byMonth] of catActivity) {
    catAvg.set(cat, [...byMonth.values()].reduce((s, v) => s + v, 0) / Math.max(1, byMonth.size));
  }

  // per-month per-category per-payee activity (scheduled-remainder subtraction)
  const payeeActivity = new Map<string, Map<string, number>>(); // `${cat}|${payeeId}` → month → sum
  for (const t of txns) {
    if (!t.categoryId || !t.payeeId) continue;
    const m = monthOf(t.date);
    if (!completedMonths.has(m)) continue;
    const k = `${t.categoryId}|${t.payeeId}`;
    const row = payeeActivity.get(k) ?? new Map<string, number>();
    row.set(m, (row.get(m) ?? 0) + t.amount);
    payeeActivity.set(k, row);
  }
  const remainderAvg = new Map<string, Map<string, number>>(); // cat → payee → avg of (cat − payee)
  for (const [k, byMonth] of payeeActivity) {
    const [cat, payeeId] = k.split('|');
    const base = catActivity.get(cat);
    if (!base) continue;
    const vals = [...completedMonths].map((m) => (base.get(m) ?? 0) - (byMonth.get(m) ?? 0));
    const row = remainderAvg.get(cat) ?? new Map<string, number>();
    row.set(payeeId, vals.reduce((s, v) => s + v, 0) / Math.max(1, vals.length));
    remainderAvg.set(cat, row);
  }

  // walk each schedule's occurrences into the window (its own nextDate first)
  const occByMonth = new Map<string, ScheduleOccurrence[]>();
  const scheduledByCat = new Map<string, ScheduledLike[]>();
  const scheduledInflowByMonth = new Map<string, number>();
  const bucket = (date: string, s: ScheduledLike) => {
    const m = monthOf(date);
    if (m < currentMonth || m > horizonEnd) return;
    if (s.endMonth && m > s.endMonth) return; // subscription ended
    const arr = occByMonth.get(m) ?? [];
    arr.push({
      date,
      payee: s.payee ?? '',
      amount: s.amount,
      frequency: s.frequency,
      categoryId: s.categoryId,
      source: 'scheduled',
    });
    occByMonth.set(m, arr);
    if (s.categoryId === inflowCatId) {
      scheduledInflowByMonth.set(m, (scheduledInflowByMonth.get(m) ?? 0) + s.amount);
    }
  };
  for (const s of scheduled) {
    if (s.transferAccountId && onBudgetTarget.get(s.transferAccountId)) continue; // internal transfer — not cash flow
    if (s.categoryId && s.categoryId !== inflowCatId) {
      const arr = scheduledByCat.get(s.categoryId) ?? [];
      arr.push(s);
      scheduledByCat.set(s.categoryId, arr);
    }
    if (s.nextDate > today) bucket(s.nextDate, s);
    let cursor = s.nextDate > today ? s.nextDate : today;
    for (let i = 0; i < 120; i++) {
      const n = nextOccurrence(s.frequency, cursor, s.anchorDay ?? undefined);
      if (!n) break;
      cursor = n;
      if (monthOf(n) > horizonEnd) break;
      if (s.endMonth && monthOf(n) > s.endMonth) break;
      bucket(n, s);
    }
  }

  // future-dated real transactions (beyond the horizon: dropped by design)
  const futureByMonth = new Map<string, ScheduleOccurrence[]>();
  const upcomingInflowByMonth = new Map<string, number>();
  for (const t of txns) {
    if (t.date <= today) continue;
    const m = monthOf(t.date);
    if (m > horizonEnd) continue;
    const arr = futureByMonth.get(m) ?? [];
    arr.push({ date: t.date, payee: '', amount: t.amount, frequency: '', categoryId: t.categoryId, source: 'upcoming' });
    futureByMonth.set(m, arr);
    if (t.categoryId === inflowCatId) {
      upcomingInflowByMonth.set(m, (upcomingInflowByMonth.get(m) ?? 0) + t.amount);
    }
  }

  const merge = (m: string): ScheduleOccurrence[] =>
    [...(occByMonth.get(m) ?? []), ...(futureByMonth.get(m) ?? [])].sort((a, b) => (a.date < b.date ? -1 : 1));

  // partial current-month row: known net only (the RTA chain starts next month)
  const partialSchedules = merge(currentMonth);
  const rows: CashflowRow[] = [
    {
      month: currentMonth,
      partial: true,
      knownScheduledNet: partialSchedules.reduce((s, x) => s + x.amount, 0),
      projectedIncome: 0,
      projectedSpending: 0,
      projectedAssigned: 0,
      projectedNet: partialSchedules.reduce((s, x) => s + x.amount, 0),
      projectedRTA: null,
      overridesUsed: 0,
      schedules: partialSchedules,
    },
  ];

  const assignedByMonth = new Map<string, number>();
  for (const mc of comp.monthCategories) {
    if (mc.assigned !== 0) assignedByMonth.set(mc.month, (assignedByMonth.get(mc.month) ?? 0) + mc.assigned);
  }
  const assignedAvg =
    historyMonths >= 2
      ? [...completedMonths].map((m) => assignedByMonth.get(m) ?? 0).reduce((s, v) => s + v, 0) /
        Math.max(1, completedMonths.size)
      : 0;

  let prevRta = comp.rtaByMonth[currentMonth] ?? 0;
  for (const m of horizon) {
    const all = merge(m);
    const knownNet = all.reduce((s, x) => s + x.amount, 0);

    // spending: overrides win outright; scheduled categories otherwise use their
    // scheduled occurrences + the remainder average; everything else uses its
    // seasonal-adjusted trailing average (same-calendar-month-last-year 50/50).
    let spendingSigned = 0;
    const handled = new Set<string>();
    const overridesThisMonth = overrideByMonthCat.get(m);
    if (overridesThisMonth) {
      for (const [cat, amt] of overridesThisMonth) {
        spendingSigned += amt;
        handled.add(cat);
      }
    }
    for (const [cat] of scheduledByCat) {
      if (handled.has(cat)) continue;
      const scheduledPortion = all.filter((o) => o.source === 'scheduled' && o.categoryId === cat).reduce((s, x) => s + x.amount, 0);
      const remainder = [...(remainderAvg.get(cat)?.values() ?? [])].reduce((s, v) => s + v, 0);
      spendingSigned += scheduledPortion + remainder;
      handled.add(cat);
    }
    for (const [cat, avg] of catAvg) {
      if (handled.has(cat)) continue;
      const base = catActivity.get(cat);
      spendingSigned += avg * seasonalFactor(base ?? new Map(), m, avg);
    }

    // income: only KNOWN inflows (scheduled + upcoming) — no trailing average.
    // The user wants the projection to rely on real scheduled income, not a guess.
    const income = (scheduledInflowByMonth.get(m) ?? 0) + (upcomingInflowByMonth.get(m) ?? 0);

    // assigned: the user's own number when they've assigned in M, otherwise
    // the trailing average, never below the sum of target requirements (a
    // category with a target will ask for at least its monthly need).
    // Reported for reference only — the RTA chain below uses real activity.
    let projectedAssigned = assignedByMonth.has(m) ? assignedByMonth.get(m)! : assignedAvg;
    if (!assignedByMonth.has(m) && targetCats.length > 0) {
      const required = targetCats.reduce((s, t) => {
        const st = computeTarget(t, { month: m, assignedThisMonth: 0, available: 0 });
        return s + (st.hasTarget ? st.neededThisMonth : 0);
      }, 0);
      projectedAssigned = Math.max(projectedAssigned, required);
    }
    const spending = Math.max(0, -spendingSigned);
    // RTA chain is cash-flow based: known income minus ACTIVITY-based spending.
    const projectedRta = prevRta + income - spending;

    rows.push({
      month: m,
      partial: false,
      knownScheduledNet: knownNet,
      projectedIncome: income,
      projectedSpending: spending,
      projectedAssigned,
      projectedNet: income - spending,
      projectedRTA: projectedRta,
      overridesUsed: overridesThisMonth?.size ?? 0,
      schedules: all,
    });
    prevRta = projectedRta;
  }

  return {
    anchorRta: comp.rtaByMonth[currentMonth] ?? 0,
    anchorMonth: currentMonth,
    historyMonths,
    sufficient: historyMonths >= 2,
    horizonMonths,
    rows,
  };
}
