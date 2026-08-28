// Age of Money — "rule 4". The median age (in days) of the dollars you spend.
//
// ponytail: this is the standard FIFO approximation — income dollars queue
// oldest-first, each outflow consumes from the oldest income, and a spend's age
// is the amount-weighted age of the income it consumed. Age of Money = median
// over the last 10 outflows. Good enough to display; the exact original
// figure can differ by a day or two. Refine only if it ever matters.

import { EngineTxn, EngineAccount } from './types';

const DAY = 86_400_000;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / DAY);
}

export function computeAgeOfMoney(
  txns: EngineTxn[],
  accounts: EngineAccount[],
  asOf?: string,
): number | null {
  const onBudget = new Map(accounts.map((a) => [a.id, a.onBudget]));
  const cutoff = asOf ?? '9999-12-31';

  const live = txns
    .filter((t) => !t.deleted && onBudget.get(t.accountId) && t.date <= cutoff && !t.transferAccountId)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // FIFO queue of income dollars (oldest first).
  const incomeQueue: { date: string; remaining: number }[] = [];
  for (const t of live) if (t.amount > 0) incomeQueue.push({ date: t.date, remaining: t.amount });

  const ages: number[] = [];
  for (const t of live) {
    if (t.amount >= 0) continue; // outflow only
    let need = -t.amount;
    let weighted = 0;
    let consumed = 0;
    while (need > 0 && incomeQueue.length) {
      const head = incomeQueue[0];
      const take = Math.min(need, head.remaining);
      weighted += take * Math.max(0, daysBetween(head.date, t.date));
      consumed += take;
      head.remaining -= take;
      need -= take;
      if (head.remaining <= 0) incomeQueue.shift();
    }
    if (consumed > 0) ages.push(weighted / consumed);
  }

  if (!ages.length) return null;
  const last = ages.slice(-10);
  const sorted = [...last].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(median);
}
