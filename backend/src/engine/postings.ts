// Shared category-posting view used by reports and drill-downs. Mirrors the
// engine's collectPostings rules exactly (on-budget only, sub-postings
// authoritative, future-dated excluded) so report totals and budget activity
// can never drift apart. Sign/inflow filtering stays consumer-side.

import { EngineTxn, EngineAccount } from './types';
import { monthOf } from './budget';

export interface Posting {
  txnId: string;
  subId: string | null; // set when the posting comes from a split subtransaction
  date: string;
  month: string;
  categoryId: string;
  amount: number;
  accountId: string;
  payeeId: string | null;
  memo: string | null;
  cleared: string;
  flagColor: string | null;
  transferAccountId: string | null;
}

export function categoryPostings(
  txns: EngineTxn[],
  accounts: EngineAccount[],
  opts: { from?: string; to?: string; accountId?: string; asOf?: string },
): Posting[] {
  const onBudget = new Map(accounts.map((a) => [a.id, a.onBudget]));
  const cutoff = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const out: Posting[] = [];
  for (const t of txns) {
    if (t.deleted) continue;
    if (opts.accountId && t.accountId !== opts.accountId) continue;
    if (!onBudget.get(t.accountId)) continue;
    if (t.date > cutoff) continue;
    const month = monthOf(t.date);
    if (opts.from && month < opts.from) continue;
    if (opts.to && month > opts.to) continue;
    const base = {
      date: t.date,
      month,
      accountId: t.accountId,
      payeeId: t.payeeId ?? null,
      memo: t.memo ?? null,
      cleared: t.cleared,
      flagColor: t.flagColor ?? null,
      transferAccountId: t.transferAccountId ?? null,
    };
    if (t.subtransactions && t.subtransactions.length) {
      for (const s of t.subtransactions) {
        if (!s.categoryId) continue;
        out.push({ ...base, txnId: t.id, subId: s.id ?? null, categoryId: s.categoryId, amount: s.amount });
      }
    } else if (t.categoryId) {
      out.push({ ...base, txnId: t.id, subId: null, categoryId: t.categoryId, amount: t.amount });
    }
  }
  return out;
}
