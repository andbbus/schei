// Route-level undo tests: fastify inject against a temp SQLite database.
// Run via `npm test` (tsx). Never touches dev.db.

import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import Fastify, { FastifyInstance } from 'fastify';
import budgetRoutes from './budget';
import registerRoutes from './register';
import opsRoutes from './ops';

const DB = `/tmp/ynab-ops-test-${Date.now()}.db`;
process.env.DATABASE_URL = `file:${DB}`;
execSync('npx prisma db push --skip-generate', { cwd: process.cwd() });

import { prisma } from '../db';

let app: FastifyInstance;
let budgetId: string;
let catA: string;
let catB: string;
let acct: string;

const month = '2026-08-01';

async function setup() {
  const budget = await prisma.budget.create({
    data: {
      name: 'Test',
      firstMonth: '2026-01-01',
      lastMonth: '2026-12-01',
      currencySymbol: '€',
      locale: 'it-IT',
    },
  });
  budgetId = budget.id;
  const group = await prisma.categoryGroup.create({ data: { budgetId, name: 'G', sortOrder: 0 } });
  const a = await prisma.category.create({ data: { budgetId, groupId: group.id, name: 'A', sortOrder: 0 } });
  const b = await prisma.category.create({ data: { budgetId, groupId: group.id, name: 'B', sortOrder: 1 } });
  catA = a.id;
  catB = b.id;
  const account = await prisma.account.create({ data: { budgetId, name: 'Acct', type: 'checking', onBudget: true } });
  acct = account.id;

  app = Fastify();
  await app.register(budgetRoutes, { prefix: '/api' });
  await app.register(registerRoutes, { prefix: '/api' });
  await app.register(opsRoutes, { prefix: '/api' });
}

const assigned = async (categoryId: string) =>
  (await prisma.monthCategory.findUnique({ where: { categoryId_month: { categoryId, month } } }))?.assigned ?? 0;
const ops = async () => (await prisma.opLog.findMany({ where: { budgetId }, orderBy: { id: 'desc' } })).map((o) => JSON.parse(o.payload));

async function undoLatest() {
  const last = await prisma.opLog.findFirst({ where: { budgetId }, orderBy: { id: 'desc' } });
  assert.ok(last, 'expected an op to undo');
  const r = await app.inject({ method: 'POST', url: `/api/ops/${last.id}/undo` });
  return r;
}

export async function test() {
  await setup();

  // 1. assign logs prev/next and undo restores (row-created case → cell back to 0)
  await app.inject({ method: 'PATCH', url: `/api/months/${month}/categories/${catA}`, payload: { assigned: 100000 } });
  assert.equal(await assigned(catA), 100000);
  let [op1] = await ops();
  assert.deepEqual(op1, [{ categoryId: catA, month, prev: 0, next: 100000 }]);
  await undoLatest();
  assert.equal(await assigned(catA), 0);

  // 2. delta composition: 100→200 then 200→300, undo first op → 200 (not 100)
  await app.inject({ method: 'PATCH', url: `/api/months/${month}/categories/${catA}`, payload: { assigned: 100000 } });
  await app.inject({ method: 'PATCH', url: `/api/months/${month}/categories/${catA}`, payload: { assigned: 200000 } });
  await app.inject({ method: 'PATCH', url: `/api/months/${month}/categories/${catA}`, payload: { assigned: 300000 } });
  const [o3, o2, o1] = (await prisma.opLog.findMany({ where: { budgetId }, orderBy: { id: 'asc' } })).slice(-3);
  await app.inject({ method: 'POST', url: `/api/ops/${o1.id}/undo` });
  assert.equal(await assigned(catA), 200000, 'undo of the first op must not clobber newer edits');
  await app.inject({ method: 'POST', url: `/api/ops/${o2.id}/undo` });
  assert.equal(await assigned(catA), 100000);
  await app.inject({ method: 'POST', url: `/api/ops/${o3.id}/undo` });
  assert.equal(await assigned(catA), 0);

  // 3. move with rta sentinel: from rta → catB; undo returns it
  await app.inject({ method: 'POST', url: `/api/months/${month}/move`, payload: { fromCategoryId: 'rta', toCategoryId: catB, amount: 50000 } });
  assert.equal(await assigned(catB), 50000);
  await undoLatest();
  assert.equal(await assigned(catB), 0);

  // 4. move between categories, undo exact
  await app.inject({ method: 'PATCH', url: `/api/months/${month}/categories/${catA}`, payload: { assigned: 90000 } });
  await app.inject({ method: 'POST', url: `/api/months/${month}/move`, payload: { fromCategoryId: catA, toCategoryId: catB, amount: 30000 } });
  assert.equal(await assigned(catA), 60000);
  assert.equal(await assigned(catB), 30000);
  await undoLatest();
  assert.equal(await assigned(catA), 90000);
  assert.equal(await assigned(catB), 0);

  // 5. createTxn + deleteTxn undo restores the pair
  const r = await app.inject({
    method: 'POST',
    url: '/api/transactions',
    payload: { accountId: acct, date: '2026-08-10', payeeName: 'P', amount: -1000, transferAccountId: null },
  });
  const txnId = r.json().id;
  await app.inject({ method: 'DELETE', url: `/api/transactions/${txnId}` });
  await undoLatest();
  assert.equal((await prisma.transaction.findUnique({ where: { id: txnId } }))?.deleted, false);

  // transfer pair: create + delete + undo restores both legs
  const acct2 = await prisma.account.create({ data: { budgetId, name: 'Acct2', type: 'checking', onBudget: true } });
  const r2 = await app.inject({
    method: 'POST',
    url: '/api/transactions',
    payload: { accountId: acct, date: '2026-08-10', payeeName: 'T', amount: -5000, transferAccountId: acct2.id },
  });
  assert.equal(r2.statusCode, 200, 'transfer create: ' + r2.body.slice(0, 400));
  const pair = r2.json();
  await app.inject({ method: 'DELETE', url: `/api/transactions/${pair.id}` });
  await undoLatest();
  const leg = await prisma.transaction.findUnique({ where: { id: pair.id } });
  assert.equal(leg?.deleted, false);
  assert.equal((await prisma.transaction.findUnique({ where: { id: leg!.transferTransactionId! } }))?.deleted, false);

  // 6. deleteCategory / deleteGroup undo restores without touching hidden
  const grp = await prisma.categoryGroup.create({ data: { budgetId, name: 'Empty', sortOrder: 9, hidden: true } });
  const empty = await prisma.category.create({ data: { budgetId, groupId: grp.id, name: 'EmptyCat', sortOrder: 0, hidden: true } });
  await app.inject({ method: 'DELETE', url: `/api/categories/${empty.id}` });
  await app.inject({ method: 'DELETE', url: `/api/category-groups/${grp.id}` });
  await undoLatest();
  await undoLatest();
  assert.equal((await prisma.category.findUnique({ where: { id: empty.id } }))?.deleted, false);
  assert.equal((await prisma.category.findUnique({ where: { id: empty.id } }))?.hidden, true, 'undo must not touch hidden');
  assert.equal((await prisma.categoryGroup.findUnique({ where: { id: grp.id } }))?.deleted, false);

  // 7. reconcile with adjustment + flips, undo restores both
  await prisma.transaction.create({
    data: { budgetId, accountId: acct, date: '2026-08-01', amount: -10000, cleared: 'cleared' },
  });
  await prisma.transaction.create({
    data: { budgetId, accountId: acct, date: '2026-08-02', amount: -20000, cleared: 'cleared' },
  });
  const rc = await app.inject({ method: 'POST', url: `/api/accounts/${acct}/reconcile`, payload: { balance: -40000 } });
  assert.equal(rc.json().adjusted, -10000); // one adjustment txn written
  const reconcileOp = (await ops())[0];
  assert.equal(reconcileOp.flipped.length, 2);
  await undoLatest();
  const rows = await prisma.transaction.findMany({ where: { accountId: acct, deleted: false }, select: { cleared: true } });
  assert.equal(rows.filter((r) => r.cleared === 'cleared').length, 2);
  assert.equal(rows.filter((r) => r.cleared === 'reconciled').length, 0);

  // 8. double-undo → 404
  const last = await prisma.opLog.findFirst({ where: { budgetId }, orderBy: { id: 'desc' } });
  await app.inject({ method: 'POST', url: `/api/ops/${last!.id}/undo` });
  const again = await app.inject({ method: 'POST', url: `/api/ops/${last!.id}/undo` });
  assert.equal(again.statusCode, 404);

  // 8b. split transactions: create with subs, edit subs, undo restores pre-image
  const sp = await app.inject({
    method: 'POST',
    url: '/api/transactions',
    payload: {
      accountId: acct,
      date: '2026-08-20',
      payeeName: 'Supermarket',
      amount: -15000,
      subtransactions: [
        { amount: -10000, categoryId: catA, memo: 'food' },
        { amount: -5000, categoryId: catB, memo: 'hygiene' },
      ],
    },
  });
  assert.equal(sp.statusCode, 200, 'split create: ' + sp.body.slice(0, 400));
  const splitId = sp.json().id;
  const subs0 = await prisma.subtransaction.findMany({ where: { transactionId: splitId } });
  assert.equal(subs0.length, 2);
  assert.equal(subs0[0].amount + subs0[1].amount, -15000);

  // bad split: amounts don't sum → 400, nothing written
  const badSplit = await app.inject({
    method: 'PATCH',
    url: `/api/transactions/${splitId}`,
    payload: { subtransactions: [{ amount: -10000, categoryId: catA }, { amount: -1000, categoryId: catB }] },
  });
  assert.equal(badSplit.statusCode, 400);
  assert.equal((await prisma.subtransaction.count({ where: { transactionId: splitId } })), 2, 'bad split must not write');

  const sp2 = await app.inject({
    method: 'PATCH',
    url: `/api/transactions/${splitId}`,
    payload: {
      amount: -20000,
      subtransactions: [
        { amount: -12000, categoryId: catB, memo: 'moved' },
        { amount: -8000, categoryId: catA },
      ],
    },
  });
  assert.equal(sp2.statusCode, 200, 'split edit: ' + sp2.body.slice(0, 400));
  const subs1 = await prisma.subtransaction.findMany({ where: { transactionId: splitId } });
  assert.equal(subs1.length, 2);
  assert.equal(subs1.reduce((s, x) => s + x.amount, 0), -20000);
  await undoLatest();
  const subs2 = await prisma.subtransaction.findMany({ where: { transactionId: splitId } });
  assert.equal(subs2.length, 2);
  assert.deepEqual(
    subs2.map((s) => [s.amount, s.categoryId, s.memo]).sort(),
    subs0.map((s) => [s.amount, s.categoryId, s.memo]).sort(),
    'undo must restore the original split rows',
  );
  assert.equal((await prisma.transaction.findUnique({ where: { id: splitId } }))?.amount, -15000);

  // split on a transfer → 400
  const trSplit = await app.inject({
    method: 'POST',
    url: '/api/transactions',
    payload: {
      accountId: acct,
      date: '2026-08-21',
      amount: -3000,
      transferAccountId: acct2.id,
      subtransactions: [{ amount: -3000, categoryId: catA }],
    },
  });
  assert.equal(trSplit.statusCode, 400);

  // 9. no-op assigns are not logged
  const countBefore = await prisma.opLog.count({ where: { budgetId } });
  const curVal = await assigned(catA);
  await app.inject({ method: 'PATCH', url: `/api/months/${month}/categories/${catA}`, payload: { assigned: curVal } });
  assert.equal(await prisma.opLog.count({ where: { budgetId } }), countBefore);

  // 10. malformed payload → 409
  const bad = await prisma.opLog.create({ data: { budgetId, kind: 'assign', payload: '{"categoryId":1}' } });
  const malformed = await app.inject({ method: 'POST', url: `/api/ops/${bad.id}/undo` });
  assert.equal(malformed.statusCode, 409);

  // 11. quick-budget: underfunded capped at RTA, largest shortfall first
  await prisma.category.update({ where: { id: catA }, data: { goalType: 'MF', goalTarget: 80000 } });
  await prisma.category.update({ where: { id: catB }, data: { goalType: 'MF', goalTarget: 50000 } });
  await app.inject({ method: 'PATCH', url: `/api/months/${month}/categories/${catA}`, payload: { assigned: 0 } });
  await app.inject({ method: 'PATCH', url: `/api/months/${month}/categories/${catB}`, payload: { assigned: 0 } });
  const before = (await app.inject({ method: 'GET', url: `/api/months/${month}` })).json() as { readyToAssign: number };
  const rtaBefore = before.readyToAssign;
  const qb = await app.inject({
    method: 'POST',
    url: `/api/months/${month}/quick-budget`,
    payload: { mode: 'underfunded', capRta: true },
  });
  assert.equal(qb.statusCode, 200, 'quick-budget: ' + qb.body.slice(0, 400));
  const aVal = await assigned(catA);
  const bVal = await assigned(catB);
  if (rtaBefore >= 130000) {
    assert.equal(aVal, 80000);
    assert.equal(bVal, 50000);
  } else if (rtaBefore >= 80000) {
    assert.equal(aVal, 80000);
    assert.equal(bVal, rtaBefore - 80000);
  } else {
    assert.equal(aVal, Math.max(0, rtaBefore), 'largest shortfall first, capped at RTA');
    assert.equal(bVal, 0);
  }
  const qbBody = qb.json() as { summary: { totalDelta: number }; readyToAssign: number };
  assert.equal(qbBody.summary.totalDelta, aVal + bVal);
  assert.equal(qbBody.readyToAssign, rtaBefore - (aVal + bVal));
  // plain mode without cap applies to every visible category in one op
  const qb2 = await app.inject({
    method: 'POST',
    url: `/api/months/${month}/quick-budget`,
    payload: { mode: 'resetAssigned' },
  });
  assert.equal(qb2.statusCode, 200);
  assert.equal(await assigned(catA), 0);
  assert.equal(await assigned(catB), 0);

  await app.close();
  await prisma.$disconnect();
  rmSync(DB, { force: true });
  rmSync(DB + '-journal', { force: true });
}

test()
  .then(() => console.log('ops: ok'))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
