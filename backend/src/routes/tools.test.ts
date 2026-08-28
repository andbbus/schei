// Register tooling tests: suggestions dismissal, duplicate detection, payee
// similarity, schedule skip. Temp SQLite DB, never touches dev.db.

import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import Fastify, { FastifyInstance } from 'fastify';
import registerRoutes, { materializeDue } from './register';
import { today } from '../engineLoad';
import { addMonths, monthOf } from '../engine/budget';

const DB = `/tmp/schei-tools-test-${Date.now()}.db`;
process.env.DATABASE_URL = `file:${DB}`;
execSync('npx prisma db push --skip-generate', { cwd: process.cwd() });

import { prisma } from '../db';

let app: FastifyInstance;
let budgetId: string;
let acct: string;
let acct2: string;
let catA: string;
let payeeLidl: string;
let payeeLidlLong: string;

async function setup() {
  const budget = await prisma.budget.create({
    data: { name: 'Test', firstMonth: '2026-01-01', lastMonth: '2026-12-01' },
  });
  budgetId = budget.id;
  acct = (await prisma.account.create({ data: { budgetId, name: 'A', type: 'checking', onBudget: true } })).id;
  acct2 = (await prisma.account.create({ data: { budgetId, name: 'B', type: 'checking', onBudget: true } })).id;
  const group = await prisma.categoryGroup.create({ data: { budgetId, name: 'G', sortOrder: 0 } });
  catA = (await prisma.category.create({ data: { budgetId, groupId: group.id, name: 'C1', sortOrder: 0 } })).id;

  app = Fastify();
  await app.register(registerRoutes, { prefix: '/api' });

  const mk = async (payeeId: string, accountId: string, date: string, amount: number) =>
    prisma.transaction.create({ data: { budgetId, accountId, date, amount, cleared: 'cleared', payeeId } });

  const l1 = await prisma.payee.create({ data: { budgetId, name: 'Lidl' } });
  const l2 = await prisma.payee.create({ data: { budgetId, name: 'LIDL SAGT DANKE' } });
  const l3 = await prisma.payee.create({ data: { budgetId, name: 'Lidl Extra' } });
  const tp = await prisma.payee.create({ data: { budgetId, name: 'Transfer : A', transferAccountId: acct } });
  payeeLidl = l1.id;
  payeeLidlLong = l2.id;
  await prisma.payee.create({ data: { budgetId, name: 'Transfer : B', transferAccountId: acct2 } });
  void tp;

  // recurring pattern for the suggestion engine: monthly Lidl spend
  // (fixture kept ≤1 month back from "today" so the engine's 1.5×interval
  // recency guard stays satisfied regardless of when tests run)
  const todaysMonth = new Date().toISOString().slice(0, 7);
  const [ty, tm] = todaysMonth.split('-').map(Number);
  // four monthly rows ending on day 10 of the current month
  const shift = (k: number) => new Date(Date.UTC(ty, tm - 1 + k, 10)).toISOString().slice(0, 10);
  for (const [d, amt] of [[shift(-3), -12000], [shift(-2), -12000], [shift(-1), -12000], [shift(0), -12000]] as const) {
    await mk(l1.id, acct, d, amt);
  }
  // a duplicate: same account/date/amount/payee twice (on acct2 so the Lidl
  // monthly pattern on acct stays clean)
  await mk(l1.id, acct2, '2026-06-15', -5555);
  await mk(l1.id, acct2, '2026-06-15', -5555);
  // a non-duplicate: same day, different payee (on acct)
  await mk(l3.id, acct, '2026-06-15', -5555);
}

export async function test() {
  await setup();

  // 1. suggestions appear, then are dismissible and come back on restore
  let sugg = (await app.inject({ method: 'GET', url: `/api/scheduled/suggestions?accountId=${acct}` })).json();
  assert.ok(sugg.some((s: { payeeId: string }) => s.payeeId === payeeLidl), 'Lidl pattern should be suggested');

  const dis = await app.inject({
    method: 'POST',
    url: '/api/suggestions/dismiss',
    payload: { payeeId: payeeLidl, accountId: acct },
  });
  assert.equal(dis.statusCode, 200, dis.body);
  sugg = (await app.inject({ method: 'GET', url: `/api/scheduled/suggestions?accountId=${acct}` })).json();
  assert.ok(!sugg.some((s: { payeeId: string }) => s.payeeId === payeeLidl), 'dismissed suggestion must be hidden');

  const restore = await app.inject({
    method: 'DELETE',
    url: `/api/suggestions/dismiss?payeeId=${payeeLidl}&accountId=${acct}`,
  });
  assert.equal(restore.statusCode, 200, restore.body);
  sugg = (await app.inject({ method: 'GET', url: `/api/scheduled/suggestions?accountId=${acct}` })).json();
  assert.ok(sugg.some((s: { payeeId: string }) => s.payeeId === payeeLidl), 'restored dismissal must resurface the suggestion');

  // dismiss with missing fields → 400
  assert.equal((await app.inject({ method: 'POST', url: '/api/suggestions/dismiss', payload: { payeeId: 'x' } })).statusCode, 400);

  // 2. duplicate detection
  const dups = (await app.inject({ method: 'GET', url: `/api/transactions/duplicates?accountId=${acct2}` })).json();
  const dup = dups.find((g: { payee: string; date: string }) => g.payee === 'Lidl' && g.date === '2026-06-15');
  assert.ok(dup, 'duplicate group expected');
  assert.equal(dup.txnIds.length, 2, 'two identical rows in the group');
  const dupsAcct = (await app.inject({ method: 'GET', url: `/api/transactions/duplicates?accountId=${acct}` })).json();
  assert.ok(!dupsAcct.some((g: { txnIds: string[] }) => g.txnIds.length > 1), 'different payee must not join the group');

  // 3. payee similarity: Lidl variants pair up, transfers excluded
  const sim = (await app.inject({ method: 'GET', url: '/api/payees/similar' })).json();
  assert.ok(sim.some((p: { fromName: string; toName: string }) => p.fromName === 'Lidl' && p.toName === 'LIDL SAGT DANKE' || p.fromName === 'LIDL SAGT DANKE' && p.toName === 'Lidl'), 'Lidl/LIDL SAGT DANKE pair expected');
  assert.ok(!sim.some((p: { fromName: string }) => p.fromName.startsWith('Transfer') || p.toName.startsWith('Transfer')), 'transfer payees excluded');

  // 4. schedule skip advances nextDate without creating a txn
  const sched = await prisma.scheduledTransaction.create({
    data: { budgetId, accountId: acct, payeeId: payeeLidlLong, amount: -100000, frequency: 'monthly', nextDate: '2026-09-01', anchorDay: 1 },
  });
  const skip = await app.inject({ method: 'POST', url: `/api/scheduled/${sched.id}/skip` });
  assert.equal(skip.statusCode, 200, skip.body);
  assert.equal(skip.json().nextDate, '2026-10-01');
  assert.equal(await prisma.transaction.count({ where: { accountId: acct, date: '2026-09-01' } }), 0, 'skip must not materialize');

  // 5. subscriptions: GET /scheduled resolves names; startMonth derives nextDate
  const list = await app.inject({ method: 'GET', url: '/api/scheduled' });
  assert.equal(list.statusCode, 200, list.body);
  assert.ok(list.json().some((s: { payee: string }) => s.payee === 'LIDL SAGT DANKE'), 'scheduled list resolves payee names');

  const start = addMonths(monthOf(today()), 3);
  const created = await app.inject({
    method: 'POST',
    url: '/api/scheduled',
    payload: { accountId: acct, payeeName: 'Netflix', amount: -12990, frequency: 'monthly', startMonth: start },
  });
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.json().nextDate, start, 'nextDate derived from startMonth');
  assert.equal(created.json().anchorDay, 1, 'monthly subscriptions pin day 1');
  assert.equal(created.json().startMonth, start);

  // 6. materialization stops once a schedule passes its endMonth
  const now = today();
  const prevMonth = addMonths(monthOf(now), -1);
  const ended = await prisma.scheduledTransaction.create({
    data: { budgetId, accountId: acct, payeeId: payeeLidlLong, amount: -1000, frequency: 'monthly', nextDate: now, anchorDay: 1, endMonth: prevMonth },
  });
  await materializeDue(budgetId);
  assert.equal((await prisma.scheduledTransaction.findUnique({ where: { id: ended.id } }))?.deleted, true, 'schedule past its endMonth is deleted');
  assert.equal(await prisma.transaction.count({ where: { accountId: acct, payeeId: payeeLidlLong, amount: -1000, date: now } }), 0, 'no transaction materialized for an ended schedule');

  // 7. an active schedule within its endMonth still materializes
  const active = await prisma.scheduledTransaction.create({
    data: { budgetId, accountId: acct, payeeId: payeeLidl, amount: -2000, frequency: 'once', nextDate: now, endMonth: addMonths(monthOf(now), 1) },
  });
  await materializeDue(budgetId);
  assert.equal(await prisma.transaction.count({ where: { accountId: acct, payeeId: payeeLidl, amount: -2000, date: now } }), 1, 'active schedule materializes');
  assert.equal((await prisma.scheduledTransaction.findUnique({ where: { id: active.id } }))?.deleted, true, 'once schedule is consumed');

  await app.close();
  await prisma.$disconnect();
  rmSync(DB, { force: true });
  rmSync(DB + '-journal', { force: true });
}

test()
  .then(() => console.log('tools: ok'))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
