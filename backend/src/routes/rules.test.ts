// Rules-engine route tests: CRUD (field/op/stage/enabled/action), pipeline
// application on create/scheduled, ranked last-wins, rename+notes actions,
// undoable retro-apply, preview, and category-learning gating.

import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import Fastify, { FastifyInstance, type LightMyRequestResponse } from 'fastify';
import registerRoutes from './register';
import opsRoutes from './ops';

const DB = `/tmp/schei-rules-test-${Date.now()}.db`;
process.env.DATABASE_URL = `file:${DB}`;
execSync('npx prisma db push --skip-generate', { cwd: process.cwd() });

import { prisma } from '../db';

let app: FastifyInstance;
let budgetId: string;
let acct: string;
let catA: string;
let catB: string;

async function setup() {
  const budget = await prisma.budget.create({ data: { name: 'Test', firstMonth: '2026-01-01', lastMonth: '2026-12-01' } });
  budgetId = budget.id;
  acct = (await prisma.account.create({ data: { budgetId, name: 'A', type: 'checking', onBudget: true } })).id;
  const group = await prisma.categoryGroup.create({ data: { budgetId, name: 'G', sortOrder: 0 } });
  catA = (await prisma.category.create({ data: { budgetId, groupId: group.id, name: 'Cat A', sortOrder: 0 } })).id;
  catB = (await prisma.category.create({ data: { budgetId, groupId: group.id, name: 'Cat B', sortOrder: 1 } })).id;

  app = Fastify();
  await app.register(registerRoutes, { prefix: '/api' });
  await app.register(opsRoutes, { prefix: '/api' });
}

const post = async (url: string, payload?: Record<string, unknown>): Promise<LightMyRequestResponse> =>
  (await app.inject({ method: 'POST', url: `/api${url}`, payload })) as LightMyRequestResponse;

export async function test() {
  await setup();

  // ---- 1. CRUD with the new columns ----
  // legacy "=" prefix becomes op:"is" with a stripped pattern
  const exact = await post('/payee-rules', { pattern: '=Lidl', categoryId: catA });
  assert.equal(exact.statusCode, 200, exact.body);
  assert.equal(exact.json().op, 'is');
  assert.equal(exact.json().pattern, 'lidl');

  // broad substring on memo field + append action
  const tagger = await post('/payee-rules', { pattern: 'POS ', field: 'memo', op: 'contains', action: 'appendNotes', actionText: '[card]' });
  assert.equal(tagger.statusCode, 200, tagger.body);

  const badRegex = await post('/payee-rules', { pattern: '(unclosed', op: 'regex', categoryId: catB });
  assert.equal(badRegex.statusCode, 400);
  const badStage = await post('/payee-rules', { pattern: 'x', stage: 'middle', categoryId: catB });
  assert.equal(badStage.statusCode, 400);
  const payeeNoText = await post('/payee-rules', { pattern: 'y', action: 'payeeName' });
  assert.equal(payeeNoText.statusCode, 400);

  // duplicate normalized pattern → 409
  const dup = await post('/payee-rules', { pattern: 'LIDL', categoryId: catB });
  assert.equal(dup.statusCode, 409);

  // disable toggle via PATCH
  const enabledPatch = await app.inject({ method: 'PATCH', url: `/api/payee-rules/${exact.json().id}`, payload: { enabled: false } });
  assert.equal(enabledPatch.statusCode, 200, enabledPatch.body);
  await app.inject({ method: 'PATCH', url: `/api/payee-rules/${exact.json().id}`, payload: { enabled: true } });

  // ---- 2. Ranked last-wins on transaction creation ----
  await post('/payee-rules', { pattern: 'lid', categoryId: catA }); // broad contains
  // (=lidl rule exists too — is beats contains: specific runs LAST and wins)
  const t1 = await post('/transactions', {
    accountId: acct, date: '2026-08-01', outflow: 1200, payeeName: 'LIDL SAGT DANKE',
  });
  assert.equal(t1.statusCode, 200, t1.body);
  assert.equal(t1.json().categoryId, catA); // both rules agree here; explicit-check below

  // conflicting categories: contains→catA vs exact→catB → exact wins
  const exactId = exact.json().id as string;
  const upd = await app.inject({ method: 'PATCH', url: `/api/payee-rules/${exactId}`, payload: { categoryId: catB } });
  assert.equal(upd.statusCode, 200);
  const t2 = await post('/transactions', {
    accountId: acct, date: '2026-08-02', outflow: 1000, payeeName: 'lidl',
  });
  assert.equal(t2.json().categoryId, catB, 'most-specific rule must win');
  // ...but a longer name that only satisfies "lid" falls to catA
  const t3 = await post('/transactions', {
    accountId: acct, date: '2026-08-03', outflow: 500, payeeName: 'LIDLISH MARKT',
  });
  assert.equal(t3.json().categoryId, catA);

  // ---- 3. Rename + notes actions through creation ----
  await post('/rules/auto-rename', { pattern: 'AMZN.COM/BILL', toName: 'Amazon' });
  const amz = await post('/transactions', {
    accountId: acct, date: '2026-08-04', inflow: -3000, payeeName: 'PURCHASE AMZN.COM/BILL #9', memo: 'pos 12:00',
  });
  assert.equal(amz.statusCode, 200, amz.body);
  const createdPayees = (await app.inject({ method: 'GET', url: '/api/payees' })).json() as { name: string }[];
  assert.ok(createdPayees.some((p) => p.name === 'Amazon'), 'rule renamed the payee');
  assert.equal(amz.json().memo, 'pos 12:00 [card]', 'memo-append rule composed');

  // ---- 4. POST /scheduled auto-categorizes like createTransaction ----
  const sched = await post('/scheduled', {
    accountId: acct, amount: -1500, frequency: 'monthly', nextDate: '2026-09-01', payeeName: 'LIDL SAGT DANKE',
  });
  assert.equal(sched.statusCode, 200, sched.body);
  assert.equal(sched.json().categoryId, catA ?? sched.json().categoryId); // 'lid' applies ('=' needs exact)
  // hmm: full string doesn't contain... it DOES contain 'lid' → catA unless exact matched.
  assert.notEqual(sched.json().categoryId, null);

  // ---- 5. Preview endpoint counts matching rows ----
  const preview = await post('/payee-rules/preview', { pattern: 'lidl' });
  assert.equal(preview.statusCode, 200, preview.body);
  const pv = preview.json();
  assert.ok(pv.count >= 3, `expected ≥3 lidl matches, got ${pv.count}`);
  assert.ok(Array.isArray(pv.sample) && pv.sample.length > 0 && pv.sample.length <= 25);

  // ---- 6. Retro-apply is one undoable delta op ----
  const stray = await post('/transactions', {
    accountId: acct, date: '2026-08-05', outflow: 700, payeeName: 'LIDL EXPRESS',
  });
  assert.equal(stray.json().categoryId, catA, 'creation already categorized');
  // uncategorized row that apply should pick up:
  const raw = await prisma.transaction.create({
    data: { budgetId, accountId: acct, date: '2026-08-06', amount: -900, cleared: 'cleared', payeeId: (await prisma.payee.findFirstOrThrow({ where: { name: 'LIDL SAGT DANKE' } })).id, categoryId: null },
  });
  const before = await prisma.transaction.findUniqueOrThrow({ where: { id: raw.id } });
  const applyRes = await post('/payee-rules/apply', {});
  assert.equal(applyRes.statusCode, 200, applyRes.body);
  assert.ok(applyRes.json().applied >= 1, JSON.stringify(applyRes.json()));
  const after = await prisma.transaction.findUniqueOrThrow({ where: { id: raw.id } });
  assert.equal(after.categoryId, catA);
  // op logged + undo restores prev values exactly
  const lastOp = await prisma.opLog.findFirstOrThrow({ where: { budgetId }, orderBy: { id: 'desc' } });
  assert.equal(lastOp.kind, 'applyRules');
  const undoRes = await app.inject({ method: 'POST', url: `/api/ops/${lastOp.id}/undo` });
  assert.equal(undoRes.statusCode, 200, undoRes.body);
  const restored = await prisma.transaction.findUniqueOrThrow({ where: { id: raw.id } });
  assert.equal(restored.categoryId, before.categoryId);

  // ---- 7. Learning offer gating ----
  // dominant modal category for LIDL SAGT DANKE rows → but a rule covers the name already
  const offerCovered = await app.inject({ method: 'GET', url: '/api/rules/learning-offer?payee=LIDL%20SAGT%20DANKE' });
  assert.equal(offerCovered.json(), null, 'existing category rules suppress learning offers');

  // fresh payee with strong modal signal
  const p2 = await prisma.payee.create({ data: { budgetId, name: 'COOP ALLE GRU' } });
  for (let i = 0; i < 4; i++) {
    await prisma.transaction.create({
      data: { budgetId, accountId: acct, date: `2026-07-${10 + i}`, amount: -2200, cleared: 'cleared', payeeId: p2.id, categoryId: catB },
    });
  }
  const offer = (await app.inject({ method: 'GET', url: '/api/rules/learning-offer?payee=COOP%20ALLE%20GRU' })).json();
  assert.ok(offer, 'expected an offer');
  assert.equal(offer.categoryId, catB);
  assert.equal(offer.count, 4);

  // weak modal signal → no offer
  const p3 = await prisma.payee.create({ data: { budgetId, name: 'SPARSAM BANK' } });
  await prisma.transaction.create({ data: { budgetId, accountId: acct, date: '2026-07-20', amount: -100, cleared: 'cleared', payeeId: p3.id, categoryId: catA } });
  await prisma.transaction.create({ data: { budgetId, accountId: acct, date: '2026-07-21', amount: -110, cleared: 'cleared', payeeId: p3.id, categoryId: catB } });
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/rules/learning-offer?payee=SPARSAM%20BANK' })).json(),
    null,
  );

  // global off switch
  await post('/settings/category-learning', { enabled: false });
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/rules/learning-offer?payee=COOP%20ALLE%20GRU' })).json(),
    null,
  );
  await post('/settings/category-learning', { enabled: true });

  // per-payee opt-out
  const toggle = await post(`/payees/${p2.id}/learn-toggle`, { disabled: true });
  assert.equal(toggle.statusCode, 200);
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/rules/learning-offer?payee=COOP%20ALLE%20GRU' })).json(),
    null,
  );
  const manage = (await app.inject({ method: 'GET', url: '/api/payees/manage' })).json() as { id: string; learnDisabled?: boolean }[];
  assert.equal(manage.find((p) => p.id === p2.id)?.learnDisabled, true);

  // accept the offer by creating the rule through the standard endpoint
  const learned = await post('/payee-rules', { pattern: '=coop alle gru', categoryId: catB, stage: 'default' });
  assert.equal(learned.statusCode, 200, learned.body);
  const newTxn = await post('/transactions', {
    accountId: acct, date: '2026-08-20', outflow: 2300, payeeName: 'Coop Alle Gru',
  });
  assert.equal(newTxn.json().categoryId, catB, 'learned rule categorizes future imports');
}

test()
  .then(() => console.log('routes/rules: ok'))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
