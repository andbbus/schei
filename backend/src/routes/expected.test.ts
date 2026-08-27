// Expected-transactions tests: GET /api/expected buckets scheduled + upcoming
// transactions by month, skips internal transfers, honours the horizon. Temp
// SQLite DB, never touches dev.db.

import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import Fastify, { FastifyInstance } from 'fastify';
import registerRoutes from './expected';
import { today } from '../engineLoad';

const DB = `/tmp/ynab-expected-test-${Date.now()}.db`;
process.env.DATABASE_URL = `file:${DB}`;
execSync('npx prisma db push --skip-generate', { cwd: process.cwd() });

import { prisma } from '../db';

let app: FastifyInstance;
let budgetId: string;
let acct: string;
let acct2: string;
let acctTrack: string;
let inflowCat: string;
let payeeGrant: string;
let payeeUni: string;
let payeeInt: string;

// Deterministic date helpers around engineLoad.today().
function addDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function nextMonth(date: string): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}
function monthOf(date: string): string {
  return date.slice(0, 7) + '-01';
}

async function setup() {
  const budget = await prisma.budget.create({
    data: { name: 'Test', firstMonth: '2026-01-01', lastMonth: '2027-12-01' },
  });
  budgetId = budget.id;
  acct = (await prisma.account.create({ data: { budgetId, name: 'A', type: 'checking', onBudget: true } })).id;
  acct2 = (await prisma.account.create({ data: { budgetId, name: 'B', type: 'checking', onBudget: true } })).id;
  acctTrack = (await prisma.account.create({ data: { budgetId, name: 'T', type: 'otherAsset', onBudget: false } })).id;
  const group = await prisma.categoryGroup.create({ data: { budgetId, name: 'G', sortOrder: 0 } });
  inflowCat = (await prisma.category.create({ data: { budgetId, groupId: group.id, name: 'Inflow: Ready to Assign', isInflow: true, sortOrder: 0 } })).id;
  await prisma.category.create({ data: { budgetId, groupId: group.id, name: 'Spesa', sortOrder: 1 } });

  payeeGrant = (await prisma.payee.create({ data: { budgetId, name: 'ACME' } })).id;
  payeeUni = (await prisma.payee.create({ data: { budgetId, name: 'Universitaet' } })).id;
  payeeInt = (await prisma.payee.create({ data: { budgetId, name: 'Internal Xfer' } })).id;

  app = Fastify();
  await app.register(registerRoutes, { prefix: '/api' });
}

export async function test() {
  await setup();
  const now = today();
  const m1 = nextMonth(now); // next month start
  const m2 = monthOf(addDays(m1, 60)); // ~two months out

  // One-off scheduled inflow (the December-grant pattern), +€200, in m2.
  await prisma.scheduledTransaction.create({
    data: { budgetId, accountId: acct, payeeId: payeeGrant, categoryId: inflowCat, amount: 200000, frequency: 'once', nextDate: m2 },
  });
  // Recurring monthly outflow, -€100.
  await prisma.scheduledTransaction.create({
    data: { budgetId, accountId: acct, payeeId: payeeInt, amount: -100000, frequency: 'monthly', nextDate: m1, anchorDay: 1 },
  });
  // Internal on-budget transfer schedule → must be skipped (no cash flow).
  await prisma.scheduledTransaction.create({
    data: { budgetId, accountId: acct, payeeId: payeeInt, amount: -50000, frequency: 'once', nextDate: m1, transferAccountId: acct2 },
  });
  // Transfer to a tracking account → a real outflow, must be kept.
  await prisma.scheduledTransaction.create({
    data: { budgetId, accountId: acct, payeeId: payeeInt, amount: -60000, frequency: 'once', nextDate: m1, transferAccountId: acctTrack },
  });
  // Future-dated real txn (upcoming inflow), +€50, soon.
  await prisma.transaction.create({
    data: { budgetId, accountId: acct, payeeId: payeeUni, categoryId: inflowCat, amount: 50000, cleared: 'uncleared', date: addDays(now, 3) },
  });

  const res = await app.inject({ method: 'GET', url: '/api/expected?months=12' });
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json();

  // 1. one-off scheduled inflow lands in its month
  const m2Row = data.months.find((r: { month: string }) => r.month === m2);
  assert.ok(m2Row, `month ${m2} present`);
  const grant = m2Row.items.find((i: { payee: string }) => i.payee === 'ACME');
  assert.ok(grant, 'grant scheduled inflow present');
  assert.equal(grant.amount, 200000);
  assert.equal(grant.source, 'scheduled');
  assert.equal(grant.category, 'Ready to Assign');

  // 2. recurring monthly outflow appears in at least two months
  const monthlyRows = data.months.filter((r: { items: { payee: string }[] }) =>
    r.items.some((i) => i.payee === 'Internal Xfer' && i.amount === -100000),
  );
  assert.ok(monthlyRows.length >= 2, `monthly schedule should recur (got ${monthlyRows.length})`);

  // 3. upcoming real txn bucketed as upcoming; transfer handling on m1
  const mCur = data.months.find((r: { month: string }) => r.month === monthOf(now));
  const upcoming = mCur.items.find((i: { payee: string; source: string }) => i.payee === 'Universitaet');
  assert.ok(upcoming, 'upcoming real txn present');
  assert.equal(upcoming.source, 'upcoming');
  assert.equal(upcoming.amount, 50000);

  const m1Row = data.months.find((r: { month: string }) => r.month === m1);
  const trackXfer = m1Row.items.find((i: { amount: number }) => i.amount === -60000);
  assert.ok(trackXfer, 'tracking transfer kept');
  assert.ok(!m1Row.items.some((i: { amount: number }) => i.amount === -50000), 'internal transfer skipped');

  // 4. months clamp
  assert.equal((await app.inject({ method: 'GET', url: '/api/expected?months=400' })).statusCode, 400);

  await app.close();
  await prisma.$disconnect();
  rmSync(DB, { force: true });
  rmSync(DB + '-journal', { force: true });
}

test()
  .then(() => console.log('expected: ok'))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });