// Subscription lifecycle tests: creation must not instantly charge, auto-
// materialized charges carry a sched:<id>:<date> marker, and deleting a
// subscription removes today/future phantom charges while keeping history.

import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import Fastify, { FastifyInstance } from 'fastify';
import registerRoutes from './register';
import { materializeDue, schedMarker } from './register';

const DB = `/tmp/schei-subs-test-${Date.now()}.db`;
process.env.DATABASE_URL = `file:${DB}`;
execSync('npx prisma db push --skip-generate', { cwd: process.cwd() });

import { prisma } from '../db';

let app: FastifyInstance;
let budgetId: string;
let acct: string;
let cat: string;

const today = () => new Date().toISOString().slice(0, 10);
const dayStr = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
const post = async (url: string, payload?: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api${url}`, payload });

async function setup() {
  const budget = await prisma.budget.create({ data: { name: 'T', firstMonth: '2026-01-01', lastMonth: '2026-12-01' } });
  budgetId = budget.id;
  acct = (await prisma.account.create({ data: { budgetId, name: 'A', type: 'checking', onBudget: true } })).id;
  const group = await prisma.categoryGroup.create({ data: { budgetId, name: 'G' } });
  cat = (await prisma.category.create({ data: { budgetId, groupId: group.id, name: 'Fees' } })).id;

  app = Fastify();
  await app.register(registerRoutes, { prefix: '/api' });
}

export async function test() {
  await setup();
  const curMonth = today().slice(0, 7);

  // ---- 1. creating a subscription starting THIS month never charges today ----
  const r1 = (await post('/scheduled', {
    accountId: acct, payeeName: 'Netflix', categoryId: cat, amount: -1099,
    frequency: 'monthly', startMonth: `${curMonth}-01`,
  })).json();
  assert.equal(r1.nextDate > today(), true, `derived nextDate must be strictly future, got ${r1.nextDate}`);
  await materializeDue(budgetId);
  assert.equal(await prisma.transaction.count({ where: { budgetId, payeeId: r1.payeeId, deleted: false } }), 0, 'no phantom charge at creation');

  // ...and if startMonth is ahead, the exact startMonth-01 is kept
  const futureMonth = dayStr(45).slice(0, 7);
  const r2 = (await post('/scheduled', {
    accountId: acct, payeeName: 'Future Gym', categoryId: cat, amount: -2000,
    frequency: 'monthly', startMonth: `${futureMonth}-01`,
  })).json();
  assert.equal(r2.nextDate, `${futureMonth}-01`);

  // ---- 2. explicit nextDate = today is deliberate and materializes with a marker ----
  const r3 = (await post('/scheduled', {
    accountId: acct, payeeName: 'Cloud Now', categoryId: cat, amount: -500,
    frequency: 'monthly', nextDate: today(),
  })).json();
  await materializeDue(budgetId);
  const spawnedToday = await prisma.transaction.findFirst({
    where: { budgetId, importId: schedMarker(r3.id, today()), deleted: false },
  });
  assert.ok(spawnedToday, 'today charge materialized with sched marker');
  const advanced = await prisma.scheduledTransaction.findUniqueOrThrow({ where: { id: r3.id } });
  assert.equal(advanced.nextDate > today(), true, 'nextDate advanced past today');

  // ---- 3. history backfill keeps past spawns unmarked-deleted ----
  const r4 = (await post('/scheduled', {
    accountId: acct, payeeName: 'Old Sub', categoryId: cat, amount: -700,
    frequency: 'monthly', nextDate: dayStr(-35),
  })).json();
  await materializeDue(budgetId);
  const history = await prisma.transaction.findMany({
    where: { budgetId, importId: { startsWith: `sched:${r4.id}:` }, deleted: false },
  });
  assert.equal(history.length, 2, 'two past occurrences backfilled');
  assert.ok(history.every((t) => t.date < today()), 'backfilled spawns are strictly history');

  // ---- 4. deleting a subscription removes today/future spawns, keeps history ----
  const delToday = await app.inject({ method: 'DELETE', url: `/api/scheduled/${r3.id}` });
  assert.equal(delToday.statusCode, 200);
  assert.equal(delToday.json().removedUpcoming, 1);
  assert.equal(
    await prisma.transaction.count({ where: { id: spawnedToday!.id, deleted: false } }),
    0,
    'phantom today-charge removed with the subscription',
  );

  const delHistory = await app.inject({ method: 'DELETE', url: `/api/scheduled/${r4.id}` });
  assert.equal(delHistory.json().removedUpcoming, 0, 'history untouched');
  assert.equal(
    await prisma.transaction.count({ where: { importId: { startsWith: `sched:${r4.id}:` }, deleted: false } }),
    2,
    'past charges stay in the register',
  );

  // ---- 5. endMonth still terminates the schedule on materialization ----
  const r5 = (await post('/scheduled', {
    accountId: acct, payeeName: 'Ending Sub', categoryId: cat, amount: -300,
    frequency: 'monthly', nextDate: dayStr(-35), endMonth: curMonth,
  })).json();
  void r5;
  await materializeDue(budgetId);
  // occurrences beyond endMonth are never spawned; schedule marked deleted once past end
  const s5 = await prisma.scheduledTransaction.findUniqueOrThrow({ where: { id: (await prisma.scheduledTransaction.findFirstOrThrow({ where: { budgetId, deleted: true, memo: null, payee: { name: 'Ending Sub' } } })).id } });
  assert.equal(s5.deleted, true);
}

test()
  .then(() => console.log('subscriptions: ok'))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
