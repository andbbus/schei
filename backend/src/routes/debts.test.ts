// DebtPlan route tests: fastify inject against a temp SQLite database.

import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import Fastify, { FastifyInstance } from 'fastify';
import debtRoutes from './debts';
import registerRoutes from './register';

const DB = `/tmp/schei-debts-test-${Date.now()}.db`;
process.env.DATABASE_URL = `file:${DB}`;
execSync('npx prisma db push --skip-generate', { cwd: process.cwd() });

import { prisma } from '../db';

let app: FastifyInstance;
let budgetId: string;
let cashAcct: string;
let loanAcct: string;
let categoryId: string;

async function setup() {
  const budget = await prisma.budget.create({
    data: { name: 'Test', firstMonth: '2026-01-01', lastMonth: '2026-12-01' },
  });
  budgetId = budget.id;
  cashAcct = (await prisma.account.create({ data: { budgetId, name: 'Cash', type: 'checking', onBudget: true } })).id;
  loanAcct = (await prisma.account.create({ data: { budgetId, name: 'Loan', type: 'otherLiability', onBudget: false } })).id;
  const group = await prisma.categoryGroup.create({ data: { budgetId, name: 'G', sortOrder: 0 } });
  categoryId = (await prisma.category.create({ data: { budgetId, groupId: group.id, name: 'Student loans', sortOrder: 0 } })).id;

  app = Fastify();
  await app.register(debtRoutes, { prefix: '/api' });
  await app.register(registerRoutes, { prefix: '/api' });
}

export async function test() {
  await setup();

  // 1. create + list with manual balance
  const created = await app.inject({
    method: 'POST',
    url: '/api/debt-plans',
    payload: { name: 'Manual plan', balance: 2500000, tanBps: 300, payment: 200000, startMonth: '2026-09-01' },
  });
  assert.equal(created.statusCode, 200, created.body);
  const plan = created.json();
  assert.equal(plan.balance, 2500000);
  let list = (await app.inject({ method: 'GET', url: '/api/debt-plans' })).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].effectiveBalance, 2500000);
  assert.equal(list[0].hasPaymentSchedule, false);

  // 2. linked plan syncs balance from the tracking account (-working)
  const linked = await app.inject({
    method: 'POST',
    url: '/api/debt-plans',
    payload: { name: 'Linked plan', accountId: loanAcct, balance: 999999, tanBps: 300, payment: 100000, startMonth: '2026-09-01' },
  });
  assert.equal(linked.statusCode, 200, linked.body);
  list = (await app.inject({ method: 'GET', url: '/api/debt-plans' })).json();
  const linkedPlan = list.find((p: { name: string }) => p.name === 'Linked plan');
  assert.equal(linkedPlan.effectiveBalance, 0); // loan account has no transactions yet

  // give the loan account a negative balance
  await prisma.transaction.create({
    data: { budgetId, accountId: loanAcct, date: '2026-08-01', amount: -2500000, cleared: 'cleared' },
  });
  list = (await app.inject({ method: 'GET', url: '/api/debt-plans' })).json();
  assert.equal(list.find((p: { name: string }) => p.name === 'Linked plan').effectiveBalance, 2500000);

  // 3. validation: bad account, bad tanBps, missing name
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/debt-plans', payload: { name: 'x', accountId: 'nope', tanBps: 300, startMonth: '2026-09-01' } })).statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/debt-plans', payload: { name: 'x', tanBps: 99999, startMonth: '2026-09-01' } })).statusCode,
    400,
  );
  assert.equal((await app.inject({ method: 'POST', url: '/api/debt-plans', payload: { tanBps: 300, startMonth: '2026-09-01' } })).statusCode, 400);

  // 4. patch
  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/debt-plans/${plan.id}`,
    payload: { payment: 300000, tanBps: 350 },
  });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(patched.json().payment, 300000);

  // 5. linked payment schedule → scheduled transfer + memo marker
  const sched = await app.inject({
    method: 'POST',
    url: `/api/debt-plans/${linkedPlan.id}/payment-schedule`,
    payload: { accountId: cashAcct },
  });
  assert.equal(sched.statusCode, 200, sched.body);
  const s = sched.json();
  assert.equal(s.transferAccountId, loanAcct);
  assert.equal(s.amount, -100000);
  assert.equal(s.frequency, 'monthly');
  assert.equal(s.anchorDay, 1);
  list = (await app.inject({ method: 'GET', url: '/api/debt-plans' })).json();
  assert.equal(list.find((p: { id: string }) => p.id === linkedPlan.id).hasPaymentSchedule, true);

  // idempotent: second call returns the same schedule
  const again = await app.inject({
    method: 'POST',
    url: `/api/debt-plans/${linkedPlan.id}/payment-schedule`,
    payload: { accountId: cashAcct },
  });
  assert.equal(again.json().id, s.id);

  // 6. manual plan schedule → plain expense with category + memo marker
  const manual = await app.inject({
    method: 'POST',
    url: `/api/debt-plans/${plan.id}/payment-schedule`,
    payload: { accountId: cashAcct, categoryId },
  });
  assert.equal(manual.statusCode, 200, manual.body);
  assert.equal(manual.json().transferAccountId, null);
  assert.equal(manual.json().categoryId, categoryId);
  assert.equal(manual.json().amount, -300000); // patched payment

  // 7. delete
  const del = await app.inject({ method: 'DELETE', url: `/api/debt-plans/${plan.id}` });
  assert.equal(del.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/debt-plans' })).json().length, 1);

  // 8. startMonth in the past → nextDate moves to next month
  const past = await app.inject({
    method: 'POST',
    url: '/api/debt-plans',
    payload: { name: 'Past', balance: 100000, tanBps: 0, payment: 50000, startMonth: '2026-01-01' },
  });
  const pastSched = await app.inject({
    method: 'POST',
    url: `/api/debt-plans/${past.json().id}/payment-schedule`,
    payload: { accountId: cashAcct },
  });
  const nextMonth = new Date();
  nextMonth.setMonth(nextMonth.getMonth() + 1);
  const expectFirst = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}-01`;
  assert.equal(pastSched.json().nextDate, expectFirst);

  await app.close();
  await prisma.$disconnect();
  rmSync(DB, { force: true });
  rmSync(DB + '-journal', { force: true });
}

test()
  .then(() => console.log('debts: ok'))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
