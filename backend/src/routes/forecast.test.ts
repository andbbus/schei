// Forecast tests: GET /api/forecast returns per-category moving-average spending
// over the trailing N completed months. Temp SQLite DB, never touches dev.db.

import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import Fastify, { FastifyInstance } from 'fastify';
import forecastRoutes from './forecast';
import opsRoutes from './ops';
import { today } from '../engineLoad';

const DB = `/tmp/schei-forecast-test-${Date.now()}.db`;
process.env.DATABASE_URL = `file:${DB}`;
execSync('npx prisma db push --skip-generate', { cwd: process.cwd() });

import { prisma } from '../db';

let app: FastifyInstance;
let budgetId: string;
let acct: string;
let groceriesId: string;
let rentId: string;

function monthStart(date: string, back: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - back);
  return d.toISOString().slice(0, 10);
}

async function setup() {
  const budget = await prisma.budget.create({
    data: { name: 'Test', firstMonth: '2025-01-01', lastMonth: '2027-12-01' },
  });
  budgetId = budget.id;
  acct = (await prisma.account.create({ data: { budgetId, name: 'A', type: 'checking', onBudget: true } })).id;
  const group = await prisma.categoryGroup.create({ data: { budgetId, name: 'G', sortOrder: 0 } });
  groceriesId = (await prisma.category.create({ data: { budgetId, groupId: group.id, name: 'Groceries', sortOrder: 0 } })).id;
  rentId = (await prisma.category.create({ data: { budgetId, groupId: group.id, name: 'Rent', sortOrder: 1 } })).id;
  const payee = await prisma.payee.create({ data: { budgetId, name: 'Lidl' } });

  // Spending in the previous 4 completed months (back 1..4 relative to today).
  for (let back = 1; back <= 4; back++) {
    const m = monthStart(today(), back);
    await prisma.transaction.create({
      data: { budgetId, accountId: acct, payeeId: payee.id, categoryId: groceriesId, date: m, amount: -100000 - back * 20000, cleared: 'cleared' },
    });
    await prisma.transaction.create({
      data: { budgetId, accountId: acct, payeeId: payee.id, categoryId: rentId, date: m, amount: -500000, cleared: 'cleared' },
    });
  }

  app = Fastify();
  await app.register(forecastRoutes, { prefix: '/api' });
  await app.register(opsRoutes, { prefix: '/api' });
}

export async function test() {
  await setup();

  // 1. window=3 → only the 3 most recent completed months
  const r3 = (await app.inject({ method: 'GET', url: '/api/forecast?window=3' })).json();
  assert.equal(r3.window, 3);
  assert.ok(r3.historyMonths >= 4); // at least the 4 data months are completed
  const g3 = r3.projected.find((p: { categoryName: string }) => p.categoryName === 'Groceries');
  const rent3 = r3.projected.find((p: { categoryName: string }) => p.categoryName === 'Rent');
  assert.equal(g3.avg, -140000); // (-120k-140k-160k)/3 = the newest 3 months
  assert.equal(rent3.avg, -500000);
  assert.equal(r3.projectedTotal, 640000); // 140k + 500k

  // 2. window=12 → all 12 newest completed months, zeros included
  const r12 = (await app.inject({ method: 'GET', url: '/api/forecast?window=12' })).json();
  const g12 = r12.projected.find((p: { categoryName: string }) => p.categoryName === 'Groceries');
  assert.equal(g12.avg, -50000); // (-120-140-160-180)/12 — 8 window months are 0

  // 3. biggest spend first
  assert.equal(r12.projected[0].categoryName, 'Rent');

  // 4. only spending categories are listed (avg < 0) — an inflow category is skipped
  const inflow = await prisma.category.create({
    data: { budgetId, groupId: (await prisma.categoryGroup.findFirstOrThrow({ where: { budgetId } })).id, name: 'Inflow: Ready to Assign', isInflow: true, sortOrder: 2 },
  });
  const payee = await prisma.payee.findFirstOrThrow({ where: { budgetId } });
  await prisma.transaction.create({
    data: { budgetId, accountId: acct, payeeId: payee.id, categoryId: inflow.id, date: monthStart(today(), 2), amount: 900000, cleared: 'cleared' },
  });
  const rInc = (await app.inject({ method: 'GET', url: '/api/forecast?window=12' })).json();
  assert.ok(!rInc.projected.some((p: { categoryName: string }) => p.categoryName === 'Ready to Assign'), 'income is not a projected expense');
  // Groceries 50k + Rent (2000k/12 = 166666.67)
  assert.ok(Math.abs(rInc.projectedTotal - 216667) < 1, String(rInc.projectedTotal));

  // 5. invalid window
  assert.equal((await app.inject({ method: 'GET', url: '/api/forecast?window=7' })).statusCode, 400);

  // 6. per-month override supersedes the moving average
  const tgt = monthStart(today(), 1); // next completed month start (any valid month string)
  const put = await app.inject({
    method: 'PUT',
    url: `/api/forecast/overrides/${groceriesId}`,
    payload: { month: tgt, amount: -777000 },
  });
  assert.equal(put.statusCode, 200, put.body);
  const rOv = (await app.inject({ method: 'GET', url: `/api/forecast?window=3&month=${tgt}` })).json();
  const gOv = rOv.projected.find((p: { categoryName: string }) => p.categoryName === 'Groceries');
  assert.equal(gOv.avg, -777000);
  assert.equal(gOv.overridden, true);
  assert.equal(rOv.projectedTotal, 777000 + 500000); // groceries override + rent average

  // upsert is idempotent
  await app.inject({
    method: 'PUT',
    url: `/api/forecast/overrides/${groceriesId}`,
    payload: { month: tgt, amount: -777000 },
  });
  assert.equal((await app.inject({ method: 'GET', url: `/api/forecast?window=3&month=${tgt}` })).json().projected.filter((p: { overridden: boolean }) => p.overridden).length, 1);

  // 6b. the set is logged as an op and undo reverts to the moving average
  let ops = (await app.inject({ method: 'GET', url: '/api/ops?limit=10' })).json();
  const setOp = ops.find((o: { kind: string; summary: string }) => o.kind === 'projectedOverride' && o.summary.startsWith('Set projected Groceries'));
  assert.ok(setOp, 'projectedOverride op logged');
  assert.equal((await app.inject({ method: 'POST', url: `/api/ops/${setOp.id}/undo` })).statusCode, 200);
  const rUndo = (await app.inject({ method: 'GET', url: `/api/forecast?window=3&month=${tgt}` })).json();
  const gUndo = rUndo.projected.find((p: { categoryName: string }) => p.categoryName === 'Groceries');
  assert.equal(gUndo.avg, -140000, 'undo of a set reverts to the average');
  assert.equal(gUndo.overridden, false);

  // 7. override-only category appears even without history
  const solo = await prisma.category.create({
    data: { budgetId, groupId: (await prisma.categoryGroup.findFirstOrThrow({ where: { budgetId } })).id, name: 'Solo', sortOrder: 3 },
  });
  await app.inject({ method: 'PUT', url: `/api/forecast/overrides/${solo.id}`, payload: { month: tgt, amount: -250000 } });
  const rSolo = (await app.inject({ method: 'GET', url: `/api/forecast?window=3&month=${tgt}` })).json();
  assert.ok(rSolo.projected.some((p: { categoryName: string }) => p.categoryName === 'Solo'), 'override-only category must appear');

  // 8. delete reverts to the average; undoing the delete restores the override
  await app.inject({ method: 'PUT', url: `/api/forecast/overrides/${groceriesId}`, payload: { month: tgt, amount: -888000 } });
  const del = await app.inject({ method: 'DELETE', url: `/api/forecast/overrides/${groceriesId}?month=${tgt}` });
  assert.equal(del.statusCode, 200, del.body);
  const rDel = (await app.inject({ method: 'GET', url: `/api/forecast?window=3&month=${tgt}` })).json();
  const gDel = rDel.projected.find((p: { categoryName: string }) => p.categoryName === 'Groceries');
  assert.equal(gDel.avg, -140000);
  assert.equal(gDel.overridden, false);

  ops = (await app.inject({ method: 'GET', url: '/api/ops?limit=10' })).json();
  const delOp = ops.find((o: { kind: string; summary: string }) => o.kind === 'projectedOverride' && o.summary.startsWith('Reverted projected Groceries'));
  assert.ok(delOp, 'delete op logged');
  assert.equal((await app.inject({ method: 'POST', url: `/api/ops/${delOp.id}/undo` })).statusCode, 200);
  const rRestore = (await app.inject({ method: 'GET', url: `/api/forecast?window=3&month=${tgt}` })).json();
  const gRestore = rRestore.projected.find((p: { categoryName: string }) => p.categoryName === 'Groceries');
  assert.equal(gRestore.avg, -888000, 'undo of a delete restores the override');
  assert.equal(gRestore.overridden, true);

  // 9. validation
  assert.equal((await app.inject({ method: 'PUT', url: `/api/forecast/overrides/${groceriesId}`, payload: { month: 'nope', amount: -1 } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/forecast/overrides/${groceriesId}`, payload: { month: tgt, amount: 1.5 } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/forecast/overrides/${groceriesId}` })).statusCode, 400);

  await app.close();
  await prisma.$disconnect();
  rmSync(DB, { force: true });
  rmSync(DB + '-journal', { force: true });
}

test()
  .then(() => console.log('forecast: ok'))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });