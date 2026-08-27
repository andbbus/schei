// Engine tests for detectAnomalies. Run via `npm test`.

import { strict as assert } from 'node:assert';
import { detectAnomalies, AnomalyInputTxn } from './anomalies';

const t = (id: string, date: string, amount: number, payeeName = 'Netflix'): AnomalyInputTxn => ({
  id,
  date,
  amount,
  payeeId: payeeName,
  payeeName,
  categoryId: 'cat',
  categoryName: 'Subscriptions',
});

// steady history then a spike → flagged once the history threshold is met
const steady = ['2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05', '2026-05-05', '2026-06-05'].map((d, i) =>
  t(`s${i}`, d, -5000),
);
const spike = t('x1', '2026-07-05', -9000);
const anomalies = detectAnomalies([...steady, spike]);
assert.equal(anomalies.length, 1);
assert.equal(anomalies[0].txnId, 'x1');
assert.equal(anomalies[0].direction, 'increase');
assert.equal(anomalies[0].mean, 5000);
assert.equal(anomalies[0].delta, 4000);
assert.ok(anomalies[0].z > 3, 'zero-variance history → infinite z, reported as huge');

// a big drop on a constant payee is flagged too (discount / partial bill)
const drop = t('x2', '2026-07-05', -2000);
assert.equal(detectAnomalies([...steady, drop])[0].direction, 'decrease');

// small wobble (below minDelta) is never flagged
const wobble = t('w', '2026-07-05', -5050);
assert.deepEqual(detectAnomalies([...steady, wobble]), []);

// fewer than minHistory prior samples → nothing flagged, even for a huge spike
assert.deepEqual(detectAnomalies([t('a', '2026-01-05', -5000), t('b', '2026-02-05', -5000), t('c', '2026-06-05', -90000)]), []);

// high-variance history: the 90€ charge is inside the noise band → not flagged
const noisy = [
  -3000, -12000, -4500, -11000, -5200, -9000, -4200, -10500, -6000, -15000,
].map((amount, i) => t(`n${i}`, `2026-0${i + 1}-05`, amount));
assert.deepEqual(detectAnomalies([...noisy, t('noisy-spike', '2026-10-05', -9000)]), []);

// recentFrom: only transactions dated ≥ the window can be reported; history
// still uses every row, so a separate payee proves the exclusion cleanly
const payeeB = (id: string, date: string, amount: number) => t(id, date, amount, 'Spotify');
const oldCase = [
  ...['2025-07-05', '2025-08-05', '2025-09-05', '2025-10-05', '2025-11-05', '2025-12-05'].map((d, i) =>
    payeeB(`b${i}`, d, -5000),
  ),
  payeeB('bold', '2026-01-20', -12000),
];
assert.ok(detectAnomalies([...steady, spike, ...oldCase]).some((a) => a.txnId === 'bold'), 'without a window the old spike is reported');
assert.deepEqual(
  detectAnomalies([...steady, spike, ...oldCase], { recentFrom: '2026-05-01' }).map((a) => a.txnId),
  ['x1'],
);

// payee-less rows are skipped entirely
assert.deepEqual(detectAnomalies([t('p1', '2026-01-05', -5000, '?'), { ...t('p2', '2026-02-05', -5000, '?'), payeeId: null, payeeName: '' }, t('p3', '2026-06-05', -90000, '?')]), []);

// inflows never flagged
assert.deepEqual(detectAnomalies([...steady, t('inc', '2026-07-05', 90000)]), []);

// ranking: biggest z first
const ranked = detectAnomalies([...steady, t('big', '2026-07-05', -90000), spike]);
assert.equal(ranked[0].txnId, 'big');

console.log('anomalies: ok');
