// Bulk-edit route tests: fastify inject against a temp SQLite database.

import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import Fastify, { FastifyInstance } from 'fastify';
import registerRoutes from './register';
import opsRoutes from './ops';

const DB = `/tmp/ynab-bulk-test-${Date.now()}.db`;
process.env.DATABASE_URL = `file:${DB}`;
execSync('npx prisma db push --skip-generate', { cwd: process.cwd() });

import { prisma } from '../db';

let app: FastifyInstance;
let budgetId: string;
let acctA: string;
let acctB: string;
let cat1: string;
let cat2: string;

async function setup() {
  const budget = await prisma.budget.create({ data: { name: 'Test', firstMonth: '2026-01-01', lastMonth: '2026-12-01' } });
  budgetId = budget.id;
  acctA = (await prisma.account.create({ data: { budgetId, name: 'A', type: 'checking', onBudget: true } })).id;
  acctB = (await prisma.account.create({ data: { budgetId, name: 'B', type: 'checking', onBudget: true } })).id;
  const group = await prisma.categoryGroup.create({ data: { budgetId, name: 'G', sortOrder: 0 } });
  cat1 = (await prisma.category.create({ data: { budgetId, groupId: group.id, name: 'C1', sortOrder: 0 } })).id;
  cat2 = (await prisma.category.create({ data: { budgetId, groupId: group.id, name: 'C2', sortOrder: 1 } })).id;

  app = Fastify();
  await app.register(registerRoutes, { prefix: '/api' });
  await app.register(opsRoutes, { prefix: '/api' });
}

const mk = async (over: Record<string, unknown> = {}) =>
  (
    await prisma.transaction.create({
      data: { budgetId, accountId: acctA, date: '2026-08-01', amount: -1000, cleared: 'cleared', ...over },
    })
  ).id;

export async function test() {
  await setup();
  const payee = await prisma.payee.create({ data: { budgetId, name: 'P' } });

  // 1. bulk category on two rows → logged per-row updateTxn, undo restores
  const t1 = await mk({ payeeId: payee.id });
  const t2 = await mk({ payeeId: payee.id });
  const r = await app.inject({
    method: 'POST',
    url: '/api/transactions/bulk',
    payload: { ids: [t1, t2], data: { categoryId: cat1 } },
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json(), { ok: true, updated: 2, skipped: 0 });
  assert.equal((await prisma.transaction.findUnique({ where: { id: t1 } }))?.categoryId, cat1);
  const ops = await prisma.opLog.findMany({ where: { budgetId }, orderBy: { id: 'desc' }, take: 2 });
  assert.equal(ops.length, 2);
  assert.ok(ops.every((o) => o.kind === 'updateTxn'));
  await app.inject({ method: 'POST', url: `/api/ops/${ops[0].id}/undo` });
  await app.inject({ method: 'POST', url: `/api/ops/${ops[1].id}/undo` });
  assert.equal((await prisma.transaction.findUnique({ where: { id: t1 } }))?.categoryId, null);

  // 2. bulk flag
  await app.inject({ method: 'POST', url: '/api/transactions/bulk', payload: { ids: [t1, t2], data: { flagColor: 'red' } } });
  assert.equal((await prisma.transaction.findUnique({ where: { id: t2 } }))?.flagColor, 'red');

  // 3. category changes skip transfers and split parents
  const transferId = await mk({ payeeId: payee.id, transferAccountId: acctB });
  const splitId = await mk({ payeeId: payee.id, categoryId: null });
  await prisma.subtransaction.create({ data: { transactionId: splitId, amount: -500, categoryId: cat1 } });
  const r3 = await app.inject({
    method: 'POST',
    url: '/api/transactions/bulk',
    payload: { ids: [transferId, splitId, t1], data: { categoryId: cat2 } },
  });
  assert.deepEqual(r3.json(), { ok: true, updated: 1, skipped: 2 });
  assert.equal((await prisma.transaction.findUnique({ where: { id: transferId } }))?.categoryId, null);
  assert.equal((await prisma.transaction.findUnique({ where: { id: t1 } }))?.categoryId, cat2);

  // 4. bulk delete + mirror pair, undo restores both
  const t3 = await mk({ payeeId: payee.id });
  const pairId = (
    await prisma.transaction.create({
      data: { budgetId, accountId: acctB, date: '2026-08-01', amount: 1000, cleared: 'cleared', transferAccountId: acctA, payeeId: payee.id },
    })
  ).id;
  await prisma.transaction.update({ where: { id: t3 }, data: { transferTransactionId: pairId } });
  const rd = await app.inject({ method: 'POST', url: '/api/transactions/bulk', payload: { ids: [t1, t3], delete: true } });
  assert.deepEqual(rd.json(), { ok: true, updated: 2, skipped: 0 });
  assert.equal((await prisma.transaction.findUnique({ where: { id: t3 } }))?.deleted, true);
  const deleteOps = await prisma.opLog.findMany({ where: { budgetId, kind: 'deleteTxn' }, orderBy: { id: 'desc' }, take: 1 });
  await app.inject({ method: 'POST', url: `/api/ops/${deleteOps[0].id}/undo` });
  assert.equal((await prisma.transaction.findUnique({ where: { id: t3 } }))?.deleted, false);
  assert.equal((await prisma.transaction.findUnique({ where: { id: pairId } }))?.deleted, false);

  // 5. validation
  assert.equal((await app.inject({ method: 'POST', url: '/api/transactions/bulk', payload: { ids: [], data: {} } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/transactions/bulk', payload: { ids: [t1], data: {} } })).statusCode, 400);

  await app.close();
  await prisma.$disconnect();
  rmSync(DB, { force: true });
  rmSync(DB + '-journal', { force: true });
}

test()
  .then(() => console.log('bulk: ok'))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
