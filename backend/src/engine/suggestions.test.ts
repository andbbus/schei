import { strict as assert } from 'node:assert';
import { detectSuggestions, SuggestionRow } from './suggestions';

const PAYEES = new Map([
  ['p1', 'Rent'],
  ['p2', 'Spotify'],
  ['p3', 'Gym'],
  ['p4', 'Reconciliation Balance Adjustment'],
  ['p5', 'Lidl'],
  ['p6', 'Insurance'],
]);
const TODAY = '2026-08-14';

const r = (over: Partial<SuggestionRow>): SuggestionRow => ({
  date: '2026-01-01',
  amount: -10000,
  payeeId: 'p1',
  accountId: 'a1',
  cleared: 'cleared',
  categoryId: 'c1',
  ...over,
});

export function test() {
  // monthly, 31st-anchored → anchorDay 31, nextDate 2026-08-31 (no drift)
  const monthly31 = ['2026-01-31', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31'].map((date) => r({ date, amount: -150000 }));
  const s = detectSuggestions(monthly31, PAYEES, TODAY);
  assert.equal(s.length, 1);
  assert.equal(s[0].frequency, 'monthly');
  assert.equal(s[0].anchorDay, 31);
  assert.equal(s[0].nextDate, '2026-08-31');

  // Feb boundary: monthly on the 28th/29th still matches (day-axis ±4)
  const feb = ['2026-02-28', '2026-03-28', '2026-04-28', '2026-05-28', '2026-06-28', '2026-07-28'].map((date) => r({ date }));
  assert.equal(detectSuggestions(feb, PAYEES, TODAY)[0]?.frequency, 'monthly');

  // pure-14-day stream → everyOtherWeek (tie-break by mean k), not weekly
  const biweekly = [0, 14, 28, 42, 56, 70, 84, 98].map((d) => {
    const t = new Date(Date.parse('2026-05-01T00:00:00Z') + d * 86400000).toISOString().slice(0, 10);
    return r({ date: t });
  });
  const bs = detectSuggestions(biweekly, PAYEES, TODAY);
  assert.equal(bs.length, 1);
  assert.equal(bs[0].frequency, 'everyOtherWeek');
  assert.equal(bs[0].nextDate > TODAY, true);

  // biweekly with a skipped week → still biweekly (14k±3 covers 28)
  const skip = ['2026-05-01', '2026-05-15', '2026-05-29', '2026-06-26', '2026-07-10', '2026-07-24'].map((date) => r({ date }));
  assert.equal(detectSuggestions(skip, PAYEES, TODAY)[0]?.frequency, 'everyOtherWeek');

  // weekly
  const weekly = ['2026-07-01', '2026-07-08', '2026-07-15', '2026-07-22', '2026-07-29', '2026-08-05'].map((date) => r({ date, payeeId: 'p2', categoryId: 'c2' }));
  const ws = detectSuggestions(weekly, PAYEES, TODAY);
  assert.equal(ws.length, 1);
  assert.equal(ws[0].frequency, 'weekly');

  // paused subscription (3-month gap) → rejected (regularity < 60%)
  const paused = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-06-01', '2026-07-01', '2026-08-01'].map((date) => r({ date, payeeId: 'p3', categoryId: 'c3' }));
  assert.equal(detectSuggestions(paused, PAYEES, TODAY).length, 0);

  // ended subscription (recency guard) → rejected
  const ended = ['2025-09-01', '2025-10-01', '2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01'].map((date) => r({ date, payeeId: 'p3', categoryId: 'c3' }));
  assert.equal(detectSuggestions(ended, PAYEES, TODAY).length, 0);

  // split parents excluded (no subcount field here — covered by the route's row mapping)

  // mixed signs (refund) → rejected
  const mixed = ['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01'].map((date) => r({ date, payeeId: 'p5', amount: date === '2026-05-01' ? 5000 : -20000 }));
  assert.equal(detectSuggestions(mixed, PAYEES, TODAY).length, 0);

  // uncleared-only stream → rejected
  const uncleared = ['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01'].map((date) => r({ date, cleared: 'uncleared' }));
  assert.equal(detectSuggestions(uncleared, PAYEES, TODAY).length, 0);

  // adjustment payees excluded
  const adj = ['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01'].map((date) => r({ date, payeeId: 'p4' }));
  assert.equal(detectSuggestions(adj, PAYEES, TODAY).length, 0);

  // yearly with 3 occurrences + recency → suggested
  const yearly = ['2023-09-01', '2024-09-01', '2025-09-01'].map((date) => r({ date, payeeId: 'p6', amount: -60000, categoryId: 'c6' }));
  const ys = detectSuggestions(yearly, PAYEES, TODAY);
  assert.equal(ys.length, 1);
  assert.equal(ys[0].frequency, 'yearly');
  assert.equal(ys[0].nextDate, '2026-09-01');

  // dedupe: exact (payeeId, accountId, date, amount) duplicates collapse
  const dup = [...monthly31, r({ date: '2026-07-31' })];
  assert.equal(detectSuggestions(dup, PAYEES, TODAY).length, 1);

  // varying amounts → flagged varies, modal amount
  const varying = ['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01'].map((date, i) => r({ date, amount: -20000 - i * 1000 }));
  const vs = detectSuggestions(varying, PAYEES, TODAY);
  assert.equal(vs.length, 1);
  assert.equal(vs[0].varies, true);
  assert.equal(vs[0].amount, -20000);
}

test();
console.log('suggestions: ok');
