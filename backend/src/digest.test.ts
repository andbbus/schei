// Tests for the digest email builder (pure). Run via `npm test`.

import { strict as assert } from 'node:assert';
import { buildDigest, DigestData } from './digest';

const data: DigestData = {
  budgetName: 'Test Budget',
  currency: { symbol: '€', digits: 2, locale: 'it-IT' },
  month: '2026-08-01',
  rta: 6217840,
  ageOfMoney: 12,
  overspent: [{ name: 'Eating Out', available: -15000 }],
  underfunded: [{ name: 'Rent', needed: 359900 }],
  upcoming: [
    { date: '2026-08-28', payee: 'Netflix', amount: -1790 },
    { date: '2026-09-01', payee: 'Rent', amount: -359900 },
  ],
  anomalies: [{ date: '2026-08-25', payeeName: 'Coop', amount: -89000, mean: -0, direction: 'increase' }],
  trend: [
    { month: '2026-06-01', income: 3000000, expense: -2800000 },
    { month: '2026-07-01', income: 3000000, expense: -3100000 },
  ],
  netWorth: 15000000,
};

const d = buildDigest(data);
assert.match(d.subject, /Budget digest — Test Budget \(2026-08\)/);
assert.match(d.text, /Ready to Assign: €6217,84/);
assert.match(d.text, /Overspent categories:\n  • Eating Out: -€15,00/);
assert.match(d.text, /Underfunded targets:\n  • Rent: needs €359,90/);
assert.match(d.text, /Next 7 days:\n  • 2026-08-28 Netflix: -€1,79/);
assert.match(d.text, /Unusual charges \(last 7 days\):\n  • 2026-08-25 Coop: -€89,00/);
assert.match(d.text, /2026-07: €3000,00 \/ €3100,00/);
assert.match(d.text, /Age of Money: 12 days/);
assert.match(d.html, /<h2>Budget "Test Budget" — 2026-08<\/h2>/);
assert.match(d.html, /<li>Eating Out: <b>-€15,00<\/b><\/li>/);
assert.ok(!d.html.includes('<script'));

// empty sections are omitted entirely
const empty = buildDigest({ ...data, overspent: [], underfunded: [], upcoming: [], anomalies: [] });
assert.ok(!empty.text.includes('Overspent'), 'no overspent section when empty');
assert.ok(!empty.html.includes('Next 7 days'), 'no upcoming section when empty');
assert.ok(empty.text.includes('Ready to Assign'), 'RTA line always present');

console.log('digest: ok');
