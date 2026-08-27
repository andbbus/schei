// Recurring-pattern detection for schedule suggestions. Pure, no I/O.
// Groups cleared/reconciled transactions by (payeeId, accountId), scores date
// regularity + amount consistency, and proposes a ScheduledTransaction.

import { addMonths } from './budget';
import { nextOccurrence } from './schedule';

export interface SuggestionRow {
  date: string;
  amount: number;
  payeeId: string;
  accountId: string;
  cleared: string;
  categoryId: string | null;
}

export interface Suggestion {
  payeeId: string;
  payee: string;
  accountId: string;
  categoryId: string | null;
  amount: number;
  frequency: string;
  anchorDay: number | null;
  nextDate: string;
  occurrences: number;
  confidence: number;
  varies: boolean;
  recentDates: string[];
}

export const EXCLUDED_PAYEES = new Set([
  'Starting Balance',
  'Manual Balance Adjustment',
  'Reconciliation Balance Adjustment',
]);

const TRANSFER_PREFIX = 'Transfer : ';

const DAY = 86400000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);
const dayOfMonth = (d: string) => Number(d.slice(8, 10));

interface Candidate {
  frequency: string;
  interval: number;
  meanK: number; // avg multiplier of matched gaps (tie-break: lower wins)
  matched: number;
}

function candidateGapOk(frequency: string, gap: number): { ok: boolean; k: number } {
  switch (frequency) {
    case 'weekly': {
      const k = Math.round(gap / 7);
      if (k < 1 || k > 3) return { ok: false, k };
      return { ok: Math.abs(gap - k * 7) <= 2, k };
    }
    case 'everyOtherWeek': {
      const k = Math.round(gap / 14);
      if (k < 1 || k > 2) return { ok: false, k };
      return { ok: Math.abs(gap - k * 14) <= 3, k };
    }
    case 'yearly': {
      return { ok: gap >= 360 && gap <= 370, k: 1 };
    }
    default:
      return { ok: false, k: 0 };
  }
}

// Monthly is judged on the day-of-month axis (31st → 28th Feb is a 3-day
// shift) AND the gap must be a single month (24-40 days — a 3-month pause
// with the same day-of-month must not match).
function monthlyGapOk(prev: string, next: string, gap: number): boolean {
  if (gap < 24 || gap > 40) return false;
  const d = Math.abs(dayOfMonth(prev) - dayOfMonth(next));
  return d <= 4 || d >= 26; // wrap: 31 → 1 of the following month
}

export function detectSuggestions(
  rows: SuggestionRow[],
  payeeNames: Map<string, string>,
  today: string,
): Suggestion[] {
  // filter: not future-dated, cleared/reconciled only, no excluded/transfer payees
  const clean = rows.filter((r) => {
    if (r.date > today) return false;
    if (r.cleared === 'uncleared') return false;
    const name = payeeNames.get(r.payeeId) ?? '';
    if (EXCLUDED_PAYEES.has(name) || name.startsWith(TRANSFER_PREFIX)) return false;
    return true;
  });
  // dedupe: one row per (payeeId, accountId, date, amount)
  const seen = new Set<string>();
  const dedup: SuggestionRow[] = [];
  for (const r of clean) {
    const k = `${r.payeeId}|${r.accountId}|${r.date}|${r.amount}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(r);
  }
  // group by (payeeId, accountId)
  const groups = new Map<string, SuggestionRow[]>();
  for (const r of dedup) {
    const k = `${r.payeeId}|${r.accountId}`;
    const arr = groups.get(k);
    if (arr) arr.push(r);
    else groups.set(k, [r]);
  }

  const out: Suggestion[] = [];
  for (const [key, list] of groups) {
    const [payeeId, accountId] = key.split('|');
    const payee = payeeNames.get(payeeId) ?? '';
    const dates = list.map((r) => r.date).sort();
    const occurrences = dates.length;
    if (occurrences < 3) continue;
    // same sign required (refunds would break amount regularity)
    const signs = new Set(list.map((r) => Math.sign(r.amount)));
    if (signs.size > 1) continue;

    const gaps: { prev: string; next: string; g: number }[] = [];
    for (let i = 1; i < dates.length; i++) gaps.push({ prev: dates[i - 1], next: dates[i], g: daysBetween(dates[i - 1], dates[i]) });
    const total = gaps.length;

    const scored: Candidate[] = [];
    // a pause longer than ~2.5 periods kills the candidate (skipped weekly /
    // biweekly / monthly occurrences stay within it; a 3-month pause doesn't)
    const maxGap = Math.max(...gaps.map((x) => x.g));
    for (const freq of ['weekly', 'everyOtherWeek', 'yearly']) {
      const interval = freq === 'weekly' ? 7 : freq === 'everyOtherWeek' ? 14 : 365;
      if (maxGap > 2.5 * interval) continue;
      let matched = 0;
      let kSum = 0;
      for (const { g } of gaps) {
        const m = candidateGapOk(freq, g);
        if (m.ok) {
          matched++;
          kSum += m.k;
        }
      }
      const ratio = matched / total;
      const minMatches = freq === 'yearly' ? 2 : 3; // yearly needs fewer occurrences
      const minOcc = freq === 'yearly' ? 3 : 4;
      if (ratio >= 0.6 && matched >= minMatches && occurrences >= minOcc) {
        scored.push({ frequency: freq, interval, meanK: kSum / matched, matched });
      }
    }
    // monthly on the day-of-month axis
    {
      if (maxGap <= 2.5 * 31) {
        let matched = 0;
        for (const { prev, next, g } of gaps) if (monthlyGapOk(prev, next, g)) matched++;
        const ratio = matched / total;
        if (ratio >= 0.6 && matched >= 3 && occurrences >= 4) {
          scored.push({ frequency: 'monthly', interval: 31, meanK: 0, matched });
        }
      }
    }
    if (scored.length === 0) continue;
    scored.sort((a, b) => b.matched / total - a.matched / total || a.meanK - b.meanK || a.interval - b.interval);
    const best = scored[0];

    // recency guard: pattern must still be alive
    const lastDate = dates[dates.length - 1];
    if (daysBetween(lastDate, today) > 1.5 * best.interval) continue;

    // modal amount + consistency
    const amounts = list.map((r) => r.amount);
    const modal = amounts.sort((a, b) => amounts.filter((v) => v === a).length - amounts.filter((v) => v === b).length)[0];
    const tolerance = Math.max(Math.abs(modal) * 0.01, 500);
    const within = amounts.filter((a) => Math.abs(a - modal) <= tolerance).length;
    const amtRatio = within / amounts.length;
    const regularity = best.matched / total;
    const confidence = 0.35 * Math.min(1, (occurrences - 2) / 4) + 0.4 * regularity + 0.25 * amtRatio;
    if (confidence < 0.6) continue;

    // nextDate: first occurrence strictly after today, drift-free via anchorDay
    const anchorDay = best.frequency === 'monthly' ? dayOfMonth(dates[dates.length - 1]) : null;
    let next: string | null = null;
    let cursor = lastDate;
    for (let i = 0; i < 120; i++) {
      const n = nextOccurrence(best.frequency, cursor, anchorDay ?? undefined);
      if (!n) break;
      if (n > today) {
        next = n;
        break;
      }
      cursor = n;
    }
    if (!next) continue;

    const categoryId = list[list.length - 1].categoryId ?? null;
    out.push({
      payeeId,
      payee,
      accountId,
      categoryId,
      amount: modal,
      frequency: best.frequency,
      anchorDay,
      nextDate: next,
      occurrences,
      confidence,
      varies: within < amounts.length,
      recentDates: dates.slice(-6),
    });
  }

  return out.sort((a, b) => b.confidence - a.confidence).slice(0, 20);
}

export const suggestionWindow = (today: string, firstMonth: string) => {
  const start = addMonths(today.slice(0, 7) + '-01', -24);
  return start < firstMonth ? firstMonth : start;
};
