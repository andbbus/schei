// Anomaly detection — pure functions over categorized outflows. Flags charges
// that deviate sharply from the same payee's own history (absolute z-score) in
// either direction (a spike OR an unusual drop, e.g. a partial refund or a
// discounted bill). Split subtransactions count as samples under their own
// amount; the caller expands them (posting-aware, mirrors engine/postings.ts).

export interface AnomalyInputTxn {
  id: string; // transaction (or subtransaction) id
  date: string;
  amount: number; // signed milliunits, negative = outflow
  payeeId: string | null;
  payeeName: string;
  categoryId: string | null;
  categoryName: string | null;
}

export interface Anomaly {
  txnId: string;
  date: string;
  payeeId: string | null;
  payeeName: string;
  categoryName: string | null;
  amount: number; // the outlier outflow (negative)
  mean: number; // mean of prior outflow sizes (positive milliunits)
  z: number; // absolute z-score (Infinity when history is perfectly constant)
  delta: number; // |amount| − mean (positive milliunits)
  direction: 'increase' | 'decrease';
}

export interface AnomalyOptions {
  zThreshold?: number; // absolute z-score required to flag (default 3)
  minHistory?: number; // prior samples required per payee (default 4)
  minDelta?: number; // minimum |amount| − mean in milliunits (default 500 = 0.50)
  recentFrom?: string; // only flag transactions dated ≥ this (ISO); history still uses everything
}

// Group key: payee identity. Unclassified rows share the null key and are
// skipped — payee-less spending has no meaningful "same merchant" history.
function groupKey(t: AnomalyInputTxn): string | null {
  return t.payeeId ?? null;
}

export function detectAnomalies(txns: AnomalyInputTxn[], opts: AnomalyOptions = {}): Anomaly[] {
  const zThreshold = opts.zThreshold ?? 3;
  const minHistory = opts.minHistory ?? 4;
  const minDelta = opts.minDelta ?? 500;
  const recentFrom = opts.recentFrom ?? null;

  // Outflows only, grouped per payee, chronological within group.
  const groups = new Map<string, AnomalyInputTxn[]>();
  for (const t of txns) {
    if (t.amount >= 0) continue; // inflows / zero rows never anomaly-check
    const key = groupKey(t);
    if (!key) continue;
    const arr = groups.get(key) ?? [];
    arr.push(t);
    groups.set(key, arr);
  }

  const out: Anomaly[] = [];
  for (const rows of groups.values()) {
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    for (let i = 0; i < rows.length; i++) {
      const t = rows[i];
      if (recentFrom && t.date < recentFrom) continue; // old rows only feed history
      const prior = rows.slice(0, i).map((p) => -p.amount); // positive outflow sizes
      if (prior.length < minHistory) continue;
      const n = prior.length;
      const mean = prior.reduce((s, x) => s + x, 0) / n;
      const variance = prior.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
      const stdev = Math.sqrt(variance);
      const size = -t.amount;
      const delta = Math.abs(size - mean);
      if (delta < minDelta) continue;
      const z = stdev > 0 ? Math.abs(size - mean) / stdev : Number.POSITIVE_INFINITY;
      if (z < zThreshold) continue;
      out.push({
        txnId: t.id,
        date: t.date,
        payeeId: t.payeeId,
        payeeName: t.payeeName,
        categoryName: t.categoryName,
        amount: t.amount,
        mean: Math.round(mean),
        z: Math.round(z * 100) / 100,
        delta: Math.round(delta),
        direction: size > mean ? 'increase' : 'decrease',
      });
    }
  }

  // Most alarming first: biggest deviation, then newest.
  return out.sort((a, b) => (b.z === a.z ? (a.date < b.date ? 1 : -1) : b.z - a.z));
}
