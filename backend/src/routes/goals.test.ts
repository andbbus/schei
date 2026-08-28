// GoalPlan route tests: CRUD, account sync, contribution schedules.

import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import Fastify, { FastifyInstance } from 'fastify';
import goalRoutes from './goals';

const DB = `/tmp/schei-goals-test-${Date.now()}.db`;
process.env.DATABASE_URL = `file:${DB}`;
execSync('npx prisma db push --skip-generate', { cwd: process.cwd() });

import { prisma } from '../db';

let app: FastifyInstance;
let budgetId: string;
let cashAcct: string;
let savingsAcct: string;
let categoryId: string;

async function setup() {
  const budget = await prisma.budget.create({
    data: { name: 'Test', firstMonth: '2026-01-01', lastMonth: '2026-12-01' },
  });
  budgetId = budget.id;
  cashAcct = (await prisma.account.create({ data: { budgetId, name: 'Cash', type: 'checking', onBudget: true } })).id;
  savingsAcct = (await prisma.account.create({ data: { budgetId, name: 'Savings', type: 'savings', onBudget: true } })).id;
  const group = await prisma.categoryGroup.create({ data: { budgetId, name: 'G', sortOrder: 0 } });
  categoryId = (await prisma.category.create({ data: { budgetId, groupId: group.id, name: 'Emergency', sortOrder: 0 } })).id;

  app = Fastify();
  await app.register(goalRoutes, { prefix: '/api' });
}

export async function test() {
  await setup();

  // 1. create + list with manual current
  const created = await app.inject({
    method: 'POST',
    url: '/api/goal-plans',
    payload: { name: 'Emergency fund', target: 3000000, current: 500000, monthlyContribution: 200000, startMonth: '2026-09-01' },
  });
  assert.equal(created.statusCode, 200, created.body);
  const plan = created.json();
  let list = (await app.inject({ method: 'GET', url: '/api/goal-plans' })).json();
  assert.equal(list[0].effectiveCurrent, 500000);
  assert.equal(list[0].hasContributionSchedule, false);

  // 2. linked account syncs current from its working balance
  await prisma.transaction.create({
    data: { budgetId, accountId: savingsAcct, date: '2026-08-01', amount: 1200000, cleared: 'cleared' },
  });
  const linked = await app.inject({
    method: 'POST',
    url: '/api/goal-plans',
    payload: { name: 'Trip', accountId: savingsAcct, target: 5000000, monthlyContribution: 300000, startMonth: '2026-09-01' },
  });
  assert.equal(linked.statusCode, 200, linked.body);
  list = (await app.inject({ method: 'GET', url: '/api/goal-plans' })).json();
  assert.equal(list.find((p: { id: string }) => p.id === linked.json().id).effectiveCurrent, 1200000);

  // 3. contribution schedule requires a funding category, is idempotent
  const noCat = await app.inject({
    method: 'POST',
    url: `/api/goal-plans/${linked.json().id}/contribution-schedule`,
    payload: { accountId: cashAcct },
  });
  assert.equal(noCat.statusCode, 400);

  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/goal-plans/${plan.id}`,
    payload: { categoryId },
  });
  assert.equal(patched.statusCode, 200, patched.body);
  const sched = await app.inject({
    method: 'POST',
    url: `/api/goal-plans/${plan.id}/contribution-schedule`,
    payload: { accountId: cashAcct },
  });
  assert.equal(sched.statusCode, 200, sched.body);
  const s = sched.json();
  assert.equal(s.amount, -200000);
  assert.equal(s.categoryId, categoryId);
  assert.equal(s.frequency, 'monthly');
  const again = await app.inject({
    method: 'POST',
    url: `/api/goal-plans/${plan.id}/contribution-schedule`,
    payload: { accountId: cashAcct },
  });
  assert.equal(again.json().id, s.id);
  list = (await app.inject({ method: 'GET', url: '/api/goal-plans' })).json();
  assert.equal(list.find((p: { id: string }) => p.id === plan.id).hasContributionSchedule, true);

  // 4. validation + delete
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/goal-plans', payload: { target: 100, startMonth: '2026-09-01' } })).statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/goal-plans', payload: { name: 'x', accountId: 'nope', startMonth: '2026-09-01' } })).statusCode,
    400,
  );
  const del = await app.inject({ method: 'DELETE', url: `/api/goal-plans/${plan.id}` });
  assert.equal(del.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/goal-plans' })).json().length, 1);

  await app.close();
  await prisma.$disconnect();
  rmSync(DB, { force: true });
  rmSync(DB + '-journal', { force: true });
}

test()
  .then(() => console.log('goals: ok'))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
