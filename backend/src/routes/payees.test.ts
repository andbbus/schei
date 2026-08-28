// Payee management route tests: manage counts, rename, merge (+undo).

import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import Fastify, { FastifyInstance } from 'fastify';
import registerRoutes from './register';
import opsRoutes from './ops';

const DB = `/tmp/schei-payees-test-${Date.now()}.db`;
process.env.DATABASE_URL = `file:${DB}`;
execSync('npx prisma db push --skip-generate', { cwd: process.cwd() });

import { prisma } from '../db';

let app: FastifyInstance;
let budgetId: string;
let acct: string;

async function setup() {
  const budget = await prisma.budget.create({ data: { name: 'Test', firstMonth: '2026-01-01', lastMonth: '2026-12-01' } });
  budgetId = budget.id;
  acct = (await prisma.account.create({ data: { budgetId, name: 'A', type: 'checking', onBudget: true } })).id;
  const group = await prisma.categoryGroup.create({ data: { budgetId, name: 'G', sortOrder: 0 } });
  const cat1 = await prisma.category.create({ data: { budgetId, groupId: group.id, name: 'C1', sortOrder: 0 } });
  const cat2 = await prisma.category.create({ data: { budgetId, groupId: group.id, name: 'C2', sortOrder: 1 } });
  await prisma.category.create({ data: { budgetId, groupId: group.id, name: 'C3', sortOrder: 2 } });

  app = Fastify();
  await app.register(registerRoutes, { prefix: '/api' });
  await app.register(opsRoutes, { prefix: '/api' });

  return { cat1, cat2 };
}

export async function test() {
  const { cat1, cat2 } = await setup();
  const from = await prisma.payee.create({ data: { budgetId, name: 'LIDL SAGT DANKE' } });
  const to = await prisma.payee.create({ data: { budgetId, name: 'Lidl' } });
  const transferPayee = await prisma.payee.create({ data: { budgetId, name: 'Transfer : A', transferAccountId: acct } });

  // seed transactions
  const mk = async (payeeId: string, categoryId: string | null) =>
    (
      await prisma.transaction.create({
        data: { budgetId, accountId: acct, date: '2026-08-01', amount: -1000, cleared: 'cleared', payeeId, categoryId },
      })
    ).id;
  const t1 = await mk(from.id, cat1.id);
  const t2 = await mk(from.id, cat2.id);
  await mk(to.id, cat1.id);

  // 0. create payee (used by the Payee Rules picker)
  const created = await app.inject({ method: 'POST', url: '/api/payees', payload: { name: '  Jane Doe ' } });
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.json().name, 'Jane Doe');
  const dup = await app.inject({ method: 'POST', url: '/api/payees', payload: { name: 'Lidl' } });
  assert.equal(dup.statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/api/payees', payload: { name: '  ' } })).statusCode, 400);

  // 1. manage list: counts + per-category breakdown
  let manage = (await app.inject({ method: 'GET', url: '/api/payees/manage' })).json();
  const fromRow = manage.find((p: { id: string }) => p.id === from.id);
  assert.equal(fromRow.txnCount, 2);
  assert.equal(fromRow.categories.length, 2);
  assert.ok(fromRow.categories.some((c: { categoryId: string; count: number }) => c.categoryId === cat1.id && c.count === 1));
  const transferRow = manage.find((p: { id: string }) => p.id === transferPayee.id);
  assert.equal(transferRow.isTransfer, true);

  // 2. rename (and clash with an existing name → 409)
  const renamed = await app.inject({ method: 'POST', url: `/api/payees/${from.id}/rename`, payload: { name: 'LIDL DANKE' } });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal(renamed.json().name, 'LIDL DANKE');
  const clash = await app.inject({ method: 'POST', url: `/api/payees/${from.id}/rename`, payload: { name: 'Lidl' } });
  assert.equal(clash.statusCode, 409);

  // transfer payees can't be renamed
  assert.equal(
    (await app.inject({ method: 'POST', url: `/api/payees/${transferPayee.id}/rename`, payload: { name: 'X' } })).statusCode,
    400,
  );

  // 3. merge moves txns + schedules, deletes the source
  await prisma.scheduledTransaction.create({
    data: { budgetId, accountId: acct, payeeId: from.id, amount: -5000, frequency: 'monthly', nextDate: '2026-09-01' },
  });
  const merged = await app.inject({ method: 'POST', url: '/api/payees/merge', payload: { fromId: from.id, toId: to.id } });
  assert.equal(merged.statusCode, 200, merged.body);
  assert.equal(merged.json().moved, 2);
  assert.equal((await prisma.transaction.findUnique({ where: { id: t1 } }))?.payeeId, to.id);
  assert.equal((await prisma.payee.count({ where: { id: from.id } })), 0);
  assert.equal((await prisma.scheduledTransaction.findFirst({ where: { budgetId } }))?.payeeId, to.id);

  // transfer payees can't be merged
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/payees/merge', payload: { fromId: transferPayee.id, toId: to.id } })).statusCode,
    400,
  );

  // 4. merge is undoable: source recreated, txns moved back
  const op = await prisma.opLog.findFirst({ where: { budgetId, kind: 'mergePayees' } });
  assert.ok(op);
  const undo = await app.inject({ method: 'POST', url: `/api/ops/${op.id}/undo` });
  assert.equal(undo.statusCode, 200, undo.body);
  assert.equal((await prisma.payee.findUnique({ where: { id: from.id } }))?.name, 'LIDL DANKE');
  assert.equal((await prisma.transaction.findUnique({ where: { id: t2 } }))?.payeeId, from.id);
  // undo is one-shot
  assert.equal((await app.inject({ method: 'POST', url: `/api/ops/${op.id}/undo` })).statusCode, 404);

  await app.close();
  await prisma.$disconnect();
  rmSync(DB, { force: true });
  rmSync(DB + '-journal', { force: true });
}

test()
  .then(() => console.log('payees: ok'))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
