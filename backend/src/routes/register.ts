import { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { getBudgetOrThrow, loadComputation, today } from '../engineLoad';
import { nextOccurrence } from '../engine/schedule';
import { monthOf } from '../engine/budget';
import { derivePatch, DerivedPatch, matchablePayee, normalizePattern, PayeeRuleRow, SYSTEM_PAYEES, TRANSFER_PREFIX } from '../engine/payeeRules';
import { categoryPostings } from '../engine/postings';
import { logOps } from './ops-helpers';
import { detectSuggestions, suggestionWindow } from '../engine/suggestions';
import { findSimilarPayees } from '../engine/similarity';

type DbClient = Prisma.TransactionClient;

// Find-or-create a normal payee by name.
async function resolvePayee(budgetId: string, name?: string | null, tx: DbClient = prisma): Promise<string | null> {
  const n = (name ?? '').trim();
  if (!n) return null;
  const found = await tx.payee.findFirst({ where: { budgetId, name: n, transferAccountId: null } });
  if (found) return found.id;
  const made = await tx.payee.create({ data: { budgetId, name: n } });
  return made.id;
}

// Load rule rows + live categories for the pipeline.
async function loadRuleInputs(budgetId: string, tx: DbClient = prisma): Promise<{ rules: PayeeRuleRow[]; live: Set<string> }> {
  const [rules, cats] = await Promise.all([
    tx.payeeRule.findMany({ where: { budgetId } }),
    tx.category.findMany({ where: { budgetId, deleted: false }, select: { id: true } }),
  ]);
  return { rules, live: new Set(cats.map((c) => c.id)) };
}

// Resolve the payee NAME for a draft that may carry either a free-text name
// or an already-resolved payee id.
async function payeeNameFor(
  budgetId: string,
  input: { payeeName?: string | null; payeeId?: string | null },
  tx: DbClient = prisma,
): Promise<string | null> {
  if (input.payeeName?.trim()) return input.payeeName;
  if (input.payeeId) {
    const p = await tx.payee.findUnique({ where: { id: input.payeeId }, select: { name: true } });
    return p?.name ?? null;
  }
  return null;
}

const RULE_ACTIONS = new Set(['category', 'payeeName', 'prependNotes', 'appendNotes']);
const RULE_FIELDS = new Set(['payeeName', 'memo', 'account']);
const RULE_OPS = new Set(['is', 'isNot', 'oneOf', 'notOneOf', 'contains', 'doesNotContain', 'regex']);
const RULE_STAGES = new Set(['pre', 'default', 'post']);

function normalizeRuleCondition(raw: string): string | null {
  let v = raw.trim().replace(/\s+/g, ' ').toLowerCase();
  while (v.startsWith('=')) v = v.slice(1).trim(); // legacy "=" prefix → op becomes "is"
  return v || null;
}

// Classify transactions for payee-rule counts / apply. A transaction counts
// for every rule whose conditions match it (pipeline may rank another rule's
// action last). Shared eligibility skips mirror the apply flow.
async function classifyRuleCandidates(
  budgetId: string,
  rules: PayeeRuleRow[],
  opts: { overwrite?: boolean; includeReconciled?: boolean },
) {
  const { live } = await loadRuleInputs(budgetId);
  const rows = await prisma.transaction.findMany({
    where: { budgetId, deleted: false },
    include: { payee: true, subtransactions: { select: { id: true } } },
  });
  const byRule = new Map<string, string[]>();
  for (const r of rules) byRule.set(r.id, []);
  const skipped = { reconciled: 0, splits: 0, transfers: 0, systemPayees: 0, noMatch: 0, alreadyCategorized: 0 };
  const categoryTargets = new Set(rules.filter((r) => r.action === 'category').map((r) => r.categoryId));
  for (const t of rows) {
    if (t.transferAccountId) {
      skipped.transfers++;
      continue;
    }
    if (t.subtransactions.length > 0) {
      skipped.splits++;
      continue;
    }
    if (t.cleared === 'reconciled' && !opts.includeReconciled) {
      skipped.reconciled++;
      continue;
    }
    if (t.categoryId !== null && !(opts.overwrite && categoryTargets.has(t.categoryId))) {
      skipped.alreadyCategorized++;
      continue;
    }
    const name = t.payee?.name ?? '';
    if (!name || SYSTEM_PAYEES.has(name) || name.startsWith(TRANSFER_PREFIX)) {
      skipped.systemPayees++;
      continue;
    }
    const res = derivePatch(
      { payeeName: name, accountId: t.accountId, memo: t.memo, categoryId: t.categoryId },
      rules,
      live,
    );
    if (res.matchedRuleIds.length === 0) {
      skipped.noMatch++;
      continue;
    }
    for (const id of res.matchedRuleIds) if (byRule.has(id)) byRule.get(id)!.push(t.id);
  }
  return { byRule, skipped };
}

// The "Transfer : <account>" payee that represents transfers TO an account.
async function transferPayee(budgetId: string, accountId: string, tx: DbClient = prisma): Promise<string> {
  const existing = await tx.payee.findFirst({ where: { transferAccountId: accountId } });
  if (existing) return existing.id;
  const acct = await tx.account.findUniqueOrThrow({ where: { id: accountId } });
  const made = await tx.payee.create({
    data: { budgetId, name: `Transfer : ${acct.name}`, transferAccountId: accountId },
  });
  return made.id;
}

// Shared register-row serializer (register + category drill-down).
type SubLike = {
  id: string;
  amount: number;
  categoryId: string | null;
  payeeId: string | null;
  memo: string | null;
  transferAccountId: string | null;
};

type TxnLike = {
  id: string;
  date: string;
  payeeId: string | null;
  categoryId: string | null;
  memo: string | null;
  amount: number;
  cleared: string;
  flagColor: string | null;
  transferAccountId: string | null;
  accountId: string;
  subtransactions?: SubLike[];
  scheduledId?: string | null;
  frequency?: string | null;
  anchorDay?: number | null;
};

function serializeTxn(
  t: TxnLike,
  payeeName: Map<string, string>,
  catName: Map<string, string>,
  runningBalance: number,
  upcoming: boolean,
) {
  return {
    id: t.id,
    date: t.date,
    payee: t.payeeId ? payeeName.get(t.payeeId) ?? '' : '',
    payeeId: t.payeeId,
    category: t.subtransactions?.length ? 'Split' : t.categoryId ? catName.get(t.categoryId) ?? '' : '',
    categoryId: t.categoryId,
    memo: t.memo ?? '',
    amount: t.amount,
    cleared: t.cleared,
    flagColor: t.flagColor,
    transferAccountId: t.transferAccountId,
    accountId: t.accountId,
    runningBalance,
    upcoming,
    scheduledId: t.scheduledId ?? null,
    frequency: t.frequency ?? null,
    anchorDay: t.anchorDay ?? null,
    subtransactions: (t.subtransactions ?? []).map((s) => ({
      id: s.id,
      amount: s.amount,
      categoryId: s.categoryId,
      payeeId: s.payeeId,
      memo: s.memo ?? '',
      transferAccountId: s.transferAccountId,
    })),
  };
}

interface TxnBody {
  accountId: string;
  date: string;
  payeeName?: string;
  payeeId?: string | null;
  categoryId?: string | null;
  memo?: string | null;
  amount?: number; // milliunits, signed (+ inflow / - outflow). Or use outflow/inflow.
  outflow?: number;
  inflow?: number;
  cleared?: string;
  flagColor?: string | null;
  transferAccountId?: string | null;
  subtransactions?: SubInput[];
}

export interface SubInput {
  amount: number;
  categoryId: string;
  payeeName?: string | null;
  memo?: string | null;
}

export class SplitValidationError extends Error {}

// Validate a split payload: ≥2 rows, nonzero amounts, live non-inflow
// categories, and the sub-amounts must sum to the parent amount.
async function validateSplits(
  budgetId: string,
  subs: SubInput[],
  parentAmount: number,
  tx: DbClient = prisma,
): Promise<{ error: string } | null> {
  if (!Array.isArray(subs) || subs.length < 2) {
    return { error: 'subtransactions must contain at least 2 rows.' };
  }
  const catIds = [...new Set(subs.map((s) => s.categoryId))];
  const cats = await tx.category.findMany({
    where: { id: { in: catIds }, budgetId, deleted: false },
    select: { id: true, isInflow: true },
  });
  const live = new Map(cats.map((c) => [c.id, c]));
  let sum = 0;
  for (const s of subs) {
    if (!Number.isInteger(s.amount) || s.amount === 0) return { error: 'Each split amount must be a nonzero integer.' };
    const cat = live.get(s.categoryId);
    if (!cat) return { error: 'Split category not found or deleted.' };
    if (cat.isInflow) return { error: 'Ready to Assign cannot be used in a split.' };
    sum += s.amount;
  }
  if (sum !== parentAmount) {
    return { error: `Split amounts must sum to the transaction amount (${parentAmount} vs ${sum}).` };
  }
  return null;
}

// validateSplits errors travel as SplitValidationError so routes can map them
// to a 400 with the friendly message.
async function assertValidSplits(
  budgetId: string,
  subs: SubInput[],
  parentAmount: number,
  tx: DbClient = prisma,
): Promise<void> {
  const err = await validateSplits(budgetId, subs, parentAmount, tx);
  if (err) throw new SplitValidationError(err.error);
}

async function createSubs(tx: DbClient, budgetId: string, parentId: string, subs: SubInput[]) {
  for (const s of subs) {
    const payeeId = s.payeeName ? await resolvePayee(budgetId, s.payeeName, tx) : null;
    await tx.subtransaction.create({
      data: { transactionId: parentId, amount: s.amount, categoryId: s.categoryId, payeeId, memo: s.memo ?? null },
    });
  }
}

function signedAmount(b: TxnBody): number {
  if (typeof b.amount === 'number') return Math.round(b.amount);
  return Math.round((b.inflow ?? 0) - (b.outflow ?? 0));
}

// Create a transaction (or a mirrored transfer pair). Shared by the POST route
// (logged, transactional) and scheduled-transaction materialization (unlogged).
// Rules auto-categorize only the non-transfer branch, and only when the caller
// passed no category.
async function createTransaction(budgetId: string, b: TxnBody, tx: DbClient = prisma) {
  const amount = signedAmount(b);

  if (b.transferAccountId) {
    if (b.subtransactions) throw new SplitValidationError('Transfers cannot be split.');
    // Two linked legs, mirrored amounts. Category null between on-budget
    // accounts; a transfer to a tracking account leaves the budget, so the
    // on-budget leg takes a category like normal spending.
    const target = await tx.account.findUniqueOrThrow({ where: { id: b.transferAccountId } });
    const here = await tx.transaction.create({
      data: {
        budgetId,
        accountId: b.accountId,
        date: b.date,
        amount,
        memo: b.memo ?? null,
        cleared: b.cleared ?? 'uncleared',
        flagColor: b.flagColor ?? null,
        categoryId: target.onBudget ? null : b.categoryId ?? null,
        transferAccountId: b.transferAccountId,
        payeeId: await transferPayee(budgetId, b.transferAccountId, tx),
      },
    });
    const there = await tx.transaction.create({
      data: {
        budgetId,
        accountId: b.transferAccountId,
        date: b.date,
        amount: -amount,
        memo: b.memo ?? null,
        cleared: 'uncleared',
        transferAccountId: b.accountId,
        transferTransactionId: here.id,
        payeeId: await transferPayee(budgetId, b.accountId, tx),
      },
    });
    await tx.transaction.update({ where: { id: here.id }, data: { transferTransactionId: there.id } });
    return here;
  }

  if (b.subtransactions) {
    await assertValidSplits(budgetId, b.subtransactions, amount, tx);
    const payeeId = b.payeeId ?? (await resolvePayee(budgetId, b.payeeName, tx));
    const parent = await tx.transaction.create({
      data: {
        budgetId,
        accountId: b.accountId,
        date: b.date,
        amount,
        memo: b.memo ?? null,
        cleared: b.cleared ?? 'uncleared',
        flagColor: b.flagColor ?? null,
        categoryId: null, // split parent — sub-postings are authoritative
        payeeId,
      },
    });
    await createSubs(tx, budgetId, parent.id, b.subtransactions);
    return parent;
  }

  // Rules pipeline: only worth running when something is unspecified — a
  // materialized schedule with payee + category pinned skips it entirely.
  const draftName = await payeeNameFor(budgetId, { payeeName: b.payeeName, payeeId: b.payeeId }, tx);
  let payeeId = b.payeeId ?? null;
  let categoryId = b.categoryId ?? null;
  let memo = b.memo ?? null;
  if (!(b.payeeId && b.categoryId != null) && (draftName || memo)) {
    const { rules, live } = await loadRuleInputs(budgetId, tx);
    const patch = derivePatch({ payeeName: draftName, accountId: b.accountId, memo }, rules, live);
    if (!b.categoryId && patch.categoryId !== undefined) categoryId = patch.categoryId;
    if (!b.payeeId && patch.payeeName) {
      // rule renamed the payee — resolve (or create) the canonical one
      payeeId = await resolvePayee(budgetId, patch.payeeName, tx);
    }
    if (patch.memo !== undefined) memo = patch.memo;
  }
  if (!payeeId) payeeId = await resolvePayee(budgetId, b.payeeName, tx);
  return tx.transaction.create({
    data: {
      budgetId,
      accountId: b.accountId,
      date: b.date,
      amount,
      memo,
      cleared: b.cleared ?? 'uncleared',
      flagColor: b.flagColor ?? null,
      categoryId,
      payeeId,
    },
  });
}

// Spawn real transactions for every scheduled one that has come due, advancing
// nextDate as we go. Called from GET /budget — the app's first fetch — so due
// schedules land before anything renders. ponytail: single user, no cron.
export async function materializeDue(budgetId: string) {
  const due = await prisma.scheduledTransaction.findMany({
    where: { budgetId, deleted: false, nextDate: { lte: today() } },
  });
  for (const s of due) {
    let date: string | null = s.nextDate;
    // cap covers years of missed occurrences while the app was closed
    for (let i = 0; date && date <= today() && i < 120; i++) {
      if (s.endMonth && monthOf(date) > s.endMonth) {
        date = null; // subscription ended — stop materializing
        break;
      }
      await createTransaction(budgetId, {
        accountId: s.accountId,
        date,
        amount: s.amount,
        memo: s.memo,
        flagColor: s.flagColor,
        categoryId: s.categoryId,
        payeeId: s.payeeId,
        transferAccountId: s.transferAccountId,
        cleared: 'uncleared',
      });
      date = nextOccurrence(s.frequency, date, s.anchorDay ?? undefined);
      if (s.endMonth && date && monthOf(date) > s.endMonth) date = null;
    }
    await prisma.scheduledTransaction.update({
      where: { id: s.id },
      data: date ? { nextDate: date } : { deleted: true },
    });
  }
}

export default async function registerRoutes(app: FastifyInstance) {
  app.get('/payees', async () => {
    const budget = await getBudgetOrThrow();
    return prisma.payee.findMany({
      where: { budgetId: budget.id, transferAccountId: null },
      orderBy: { name: 'asc' },
    });
  });

  app.post('/payees', async (req, reply) => {
    const { name } = req.body as { name?: string };
    const budget = await getBudgetOrThrow();
    const n = name?.trim();
    if (!n) return reply.code(400).send({ error: 'name must not be empty.' });
    const clash = await prisma.payee.findFirst({ where: { budgetId: budget.id, name: n, transferAccountId: null } });
    if (clash) return reply.code(409).send({ error: 'A payee with this name already exists.' });
    return prisma.payee.create({ data: { budgetId: budget.id, name: n } });
  });

  // Transaction rules: one condition (field/op/pattern) + one action per row.
  // Matching is ranked least→most specific through engine/rules.ts; "updated
  // last wins" — see docs on stages (pre/default/post).
  app.get('/payee-rules', async () => {
    const budget = await getBudgetOrThrow();
    const rules = await prisma.payeeRule.findMany({ where: { budgetId: budget.id }, orderBy: { createdAt: 'asc' } });
    const cats = await prisma.category.findMany({ where: { budgetId: budget.id }, select: { id: true, name: true, deleted: true } });
    const catMeta = new Map(cats.map((c) => [c.id, c]));
    const { byRule } = await classifyRuleCandidates(budget.id, rules, {});
    return rules.map((r) => ({
      id: r.id,
      pattern: r.pattern,
      field: r.field,
      op: r.op,
      stage: r.stage,
      enabled: r.enabled,
      action: r.action,
      actionText: r.actionText,
      categoryId: r.categoryId,
      categoryName: r.categoryId ? (catMeta.get(r.categoryId)?.name ?? '') : '',
      categoryDeleted: r.action === 'category' && r.categoryId ? (catMeta.get(r.categoryId)?.deleted ?? true) : false,
      matchCount: byRule.get(r.id)?.length ?? 0,
      createdAt: r.createdAt,
    }));
  });

  const validateRegexPattern = (p: string): string | null => {
    if (p.length > 200) return 'Regex pattern too long (max 200 chars).';
    try {
      new RegExp(p, 'iu');
      return null;
    } catch {
      return 'Invalid regular expression.';
    }
  };

  // Shared body validation for POST/PATCH. Returns {data} or {error}.
  async function validateRuleBody(
    budgetId: string,
    body: Record<string, unknown>,
    current?: { id: string; pattern: string; field: string; op: string; action: string; actionText: string | null } | null,
  ): Promise<{ data?: Record<string, unknown>; error?: { code: number; message: string } }> {
    const data: Record<string, unknown> = {};
    const touchesCondition = body.field !== undefined || body.op !== undefined || body.pattern !== undefined;
    const touchesAction = body.action !== undefined || body.actionText !== undefined || body.categoryId !== undefined;

    if (body.pattern !== undefined || !current) {
      let p = normalizePattern(String(body.pattern ?? ''));
      if (!p || p === '=' || p === '==') return { error: { code: 400, message: 'Pattern must not be empty.' } };
      if (p.startsWith('=')) {
        // legacy "=" prefix encoding → canonical exact-op form
        p = normalizePattern(p.slice(1));
        if (!p) return { error: { code: 400, message: 'Pattern must not be empty.' } };
        if (body.op === undefined) data.op = 'is';
      }
      data.pattern = p;
    }
    if (body.field !== undefined) {
      const f = String(body.field);
      if (!RULE_FIELDS.has(f)) return { error: { code: 400, message: `field must be one of: ${[...RULE_FIELDS].join(', ')}.` } };
      data.field = f;
    }
    if (body.op !== undefined) {
      const op = String(body.op);
      if (!RULE_OPS.has(op)) return { error: { code: 400, message: `op must be one of: ${[...RULE_OPS].join(', ')}.` } };
      data.op = op;
    }
    if (body.stage !== undefined) {
      const s = String(body.stage);
      if (!RULE_STAGES.has(s)) return { error: { code: 400, message: `stage must be one of: ${[...RULE_STAGES].join(', ')}.` } };
      data.stage = s;
    }
    if (body.enabled !== undefined) data.enabled = Boolean(body.enabled);

    // Action side — only validated/written when the payload touches it.
    if (touchesAction) {
      const effAction = String(body.action ?? current?.action ?? 'category');
      if (!RULE_ACTIONS.has(effAction)) {
        return { error: { code: 400, message: `action must be one of: ${[...RULE_ACTIONS].join(', ')}.` } };
      }
      data.action = effAction;
      if (effAction === 'category') {
        if (body.categoryId !== undefined) {
          const cat = await prisma.category.findFirst({ where: { id: String(body.categoryId), budgetId, deleted: false } });
          if (!cat) return { error: { code: 400, message: 'Category not found.' } };
          data.categoryId = cat.id;
        } else if (!current) {
          return { error: { code: 400, message: 'Category not found.' } };
        }
        data.actionText = null;
      } else {
        const text = String(body.actionText ?? current?.actionText ?? '').trim();
        if (!text) return { error: { code: 400, message: `${effAction} requires a value.` } };
        data.actionText = text;
        data.categoryId = null;
      }
    }

    // Regex patterns must compile (and stay bounded).
    const effOp = String(data.op ?? current?.op ?? 'contains');
    if (effOp === 'regex') {
      const pat = data.pattern ?? current?.pattern;
      if (typeof pat === 'string' && pat) {
        const err = validateRegexPattern(pat);
        if (err) return { error: { code: 400, message: err } };
      }
    }
    return { data };
  }

  app.post('/payee-rules', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const budget = await getBudgetOrThrow();
    const v = await validateRuleBody(budget.id, body, null);
    if (v.error) return reply.code(v.error.code).send({ error: v.error.message });
    const clash = await prisma.payeeRule.findUnique({
      where: { budgetId_pattern: { budgetId: budget.id, pattern: v.data!.pattern as string } },
    });
    if (clash) return reply.code(409).send({ error: 'A rule with this pattern already exists.' });
    return prisma.payeeRule.create({ data: { ...(v.data as Prisma.PayeeRuleUncheckedCreateInput), budgetId: budget.id } });
  });

  app.patch('/payee-rules/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const budget = await getBudgetOrThrow();
    const existing = await prisma.payeeRule.findFirst({ where: { id, budgetId: budget.id } });
    if (!existing) return reply.code(404).send({ error: 'Rule not found.' });
    const v = await validateRuleBody(budget.id, body, existing);
    if (v.error) return reply.code(v.error.code).send({ error: v.error.message });
    if (v.data!.pattern !== undefined && v.data!.pattern !== existing.pattern) {
      const clash = await prisma.payeeRule.findUnique({
        where: { budgetId_pattern: { budgetId: budget.id, pattern: v.data!.pattern as string } },
      });
      if (clash && clash.id !== id) return reply.code(409).send({ error: 'A rule with this pattern already exists.' });
    }
    return prisma.payeeRule.update({ where: { id }, data: v.data as Prisma.PayeeRuleUncheckedUpdateInput });
  });

  app.delete('/payee-rules/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const budget = await getBudgetOrThrow();
    const existing = await prisma.payeeRule.findFirst({ where: { id, budgetId: budget.id } });
    if (!existing) return reply.code(404).send({ error: 'Rule not found.' });
    await prisma.payeeRule.delete({ where: { id } });
    return { ok: true };
  });

  // Live preview for the rule editor: which transactions would this
  // condition match? Same eligibility family as apply (transfers/splits/
  // system payees excluded; reconciled/categorized rows included so the user
  // sees what overwrite would touch).
  app.post('/payee-rules/preview', async (req) => {
    const b = req.body as { pattern?: string; field?: string; op?: string };
    const budget = await getBudgetOrThrow();
    const raw = normalizePattern(b.pattern ?? '');
    if (!raw || raw === '=' || raw === '==') return { count: 0, sample: [] };
    const row: PayeeRuleRow = {
      id: '__preview__',
      pattern: raw,
      field: RULE_FIELDS.has(String(b.field)) ? String(b.field) : 'payeeName',
      op: RULE_OPS.has(String(b.op)) ? String(b.op) : 'contains',
      action: 'category',
      // sentinel target kept "live" below so the synthetic rule survives
      // liveRules' dead-category filter and can report matches by id
      categoryId: '__preview__',
    };
    const [{ live }, rows] = await Promise.all([
      loadRuleInputs(budget.id),
      prisma.transaction.findMany({
        where: { budgetId: budget.id, deleted: false },
        include: { payee: { select: { name: true } }, category: { select: { name: true } }, subtransactions: { select: { id: true } } },
        orderBy: { date: 'desc' },
        take: 500,
      }),
    ]);
    const sample: { id: string; date: string; payee: string; memo: string | null; categoryName: string | null; changesPayee: boolean }[] = [];
    let count = 0;
    for (const t of rows) {
      const name = t.payee?.name ?? '';
      if (t.transferAccountId || t.subtransactions.length > 0) continue;
      if (!name || SYSTEM_PAYEES.has(name) || name.startsWith(TRANSFER_PREFIX)) continue;
      const res = derivePatch(
        { payeeName: name, accountId: t.accountId, memo: t.memo },
        [row],
        new Set([...live, '__preview__']),
      );
      if (!res.matchedRuleIds.includes('__preview__')) continue;
      count++;
      if (sample.length < 25) {
        sample.push({
          id: t.id,
          date: t.date,
          payee: name,
          memo: t.memo,
          categoryName: t.category?.name ?? null,
          changesPayee: res.payeeName !== undefined,
        });
      }
    }
    return { count, sample };
  });

  // Re-run rules over existing transactions inside one undoable delta op.
  // Default scope: uncategorized, non-transfer, non-split, non-reconciled,
  // non-system-payee rows. `overwrite` also touches rows whose current
  // category matches one of the target rules' categories.
  app.post('/payee-rules/apply', async (req, reply) => {
    const { ruleId, overwrite = false, includeReconciled = false } = req.body as {
      ruleId?: string;
      overwrite?: boolean;
      includeReconciled?: boolean;
    };
    const budget = await getBudgetOrThrow();
    const rules = await prisma.payeeRule.findMany({
      where: { budgetId: budget.id, enabled: true, ...(ruleId ? { id: ruleId } : {}) },
    });
    if (rules.length === 0) return reply.code(404).send({ error: 'No rules match.' });
    const { byRule, skipped } = await classifyRuleCandidates(budget.id, rules, { overwrite, includeReconciled });

    const candidateIds = new Set<string>();
    for (const ids of byRule.values()) for (const i of ids) candidateIds.add(i);
    if (candidateIds.size === 0) return { applied: 0, perRule: {}, skipped };

    const perRule: Record<string, number> = {};
    const rowsUndo: {
      id: string;
      prev: { categoryId: string | null; payeeId: string | null; memo: string | null };
      next: { categoryId: string | null; payeeId: string | null; memo: string | null };
    }[] = [];
    const appliedCount = await prisma.$transaction(async (tx) => {
      const { rules: allRules, live } = await loadRuleInputs(budget.id, tx);
      const scopeIds = new Set(rules.map((r) => r.id));
      const scoped = allRules.filter((r) => scopeIds.has(r.id));
      const candidates = await tx.transaction.findMany({
        where: { id: { in: [...candidateIds] } },
        include: { payee: true },
      });
      // canonical payees for rename actions, resolved inside the transaction
      const canonical = new Map<string, string>();
      for (const r of scoped) {
        if (r.action === 'payeeName' && r.actionText?.trim()) {
          const pid = await resolvePayee(budget.id, r.actionText.trim(), tx);
          if (pid) canonical.set(r.id, pid);
        }
      }
      let n = 0;
      for (const t of candidates) {
        const res = derivePatch(
          { payeeName: t.payee?.name ?? '', accountId: t.accountId, memo: t.memo, categoryId: t.categoryId },
          scoped,
          live,
        );
        if (res.matchedRuleIds.length === 0) continue;
        const nextCat = res.categoryId !== undefined ? res.categoryId : t.categoryId;
        const nextMemo = res.memo !== undefined ? res.memo : t.memo;
        // payee rename via rule actions: canonical payee of the LAST matched rename rule wins
        let nextPayeeId = t.payeeId;
        for (const rid of [...res.matchedRuleIds].reverse()) {
          const pid = canonical.get(rid);
          if (pid) {
            nextPayeeId = pid;
            break;
          }
        }
        if (nextCat === t.categoryId && nextMemo === t.memo && nextPayeeId === t.payeeId) continue;
        await tx.transaction.update({
          where: { id: t.id },
          data: {
            ...(nextCat !== t.categoryId ? { categoryId: nextCat } : {}),
            ...(nextMemo !== t.memo ? { memo: nextMemo } : {}),
            ...(nextPayeeId !== t.payeeId ? { payeeId: nextPayeeId } : {}),
          },
        });
        rowsUndo.push({
          id: t.id,
          prev: { categoryId: t.categoryId, payeeId: t.payeeId, memo: t.memo },
          next: { categoryId: nextCat, payeeId: nextPayeeId, memo: nextMemo },
        });
        n++;
      }
      if (n > 0) {
        await logOps(tx, budget.id, 'applyRules', { ruleIds: rules.map((r) => r.id), rows: rowsUndo });
      }
      return n;
    });
    void byRule;
    for (const r of rules) {
      const c = (byRule.get(r.id) ?? []).filter((id) => rowsUndo.some((u) => u.id === id)).length;
      if (c > 0) perRule[r.id] = c;
    }
    return { applied: appliedCount, perRule, skipped };
  });

  app.get('/categories', async () => {
    const budget = await getBudgetOrThrow();
    const groups = await prisma.categoryGroup.findMany({
      where: { budgetId: budget.id, deleted: false },
      orderBy: { sortOrder: 'asc' },
      include: { categories: { where: { deleted: false }, orderBy: { sortOrder: 'asc' } } },
    });
    return groups;
  });

  // Recurring-pattern suggestions → proposed scheduled transactions.
  // Per-account scope (optional filter); payees already scheduled are excluded.
  app.get('/scheduled/suggestions', async (req) => {
    const q = req.query as { accountId?: string };
    const budget = await getBudgetOrThrow();
    const windowStart = suggestionWindow(today(), budget.firstMonth);
    const [txns, payees, schedules] = await Promise.all([
      prisma.transaction.findMany({
        where: {
          budgetId: budget.id,
          deleted: false,
          date: { gte: windowStart },
          ...(q.accountId ? { accountId: q.accountId } : {}),
        },
        select: {
          date: true,
          amount: true,
          payeeId: true,
          accountId: true,
          cleared: true,
          categoryId: true,
          transferAccountId: true,
          subtransactions: { select: { id: true } },
        },
      }),
      prisma.payee.findMany({ where: { budgetId: budget.id }, select: { id: true, name: true } }),
      prisma.scheduledTransaction.findMany({
        where: { budgetId: budget.id, deleted: false },
        select: { payeeId: true, accountId: true },
      }),
    ]);
    const payeeNames = new Map(payees.map((p) => [p.id, p.name]));
    const alreadyScheduled = new Set(schedules.map((s) => `${s.payeeId}|${s.accountId}`));
    const dismissed = await prisma.suggestionDismissal.findMany({
      where: { budgetId: budget.id },
      select: { payeeId: true, accountId: true },
    });
    const dismissedSet = new Set(dismissed.map((d) => `${d.payeeId}|${d.accountId}`));
    const rows = txns
      .filter((t) => !t.transferAccountId && t.subtransactions.length === 0)
      .map((t) => ({
        date: t.date,
        amount: t.amount,
        payeeId: t.payeeId ?? '',
        accountId: t.accountId,
        cleared: t.cleared,
        categoryId: t.categoryId,
      }))
      .filter(
        (t) => t.payeeId !== '' && !alreadyScheduled.has(`${t.payeeId}|${t.accountId}`) && !dismissedSet.has(`${t.payeeId}|${t.accountId}`),
      );
    return detectSuggestions(rows, payeeNames, today());
  });

  // Dismiss a suggestion (payee + account pair) so it stops being proposed.
  // Deleting the dismissal row brings it back.
  app.post('/suggestions/dismiss', async (req, reply) => {
    const { payeeId, accountId } = req.body as { payeeId?: string; accountId?: string };
    const budget = await getBudgetOrThrow();
    if (!payeeId || !accountId) return reply.code(400).send({ error: 'payeeId and accountId are required.' });
    await prisma.suggestionDismissal.upsert({
      where: { budgetId_payeeId_accountId: { budgetId: budget.id, payeeId, accountId } },
      update: {},
      create: { budgetId: budget.id, payeeId, accountId },
    });
    return { ok: true };
  });

  app.delete('/suggestions/dismiss', async (req, reply) => {
    const q = req.query as { payeeId?: string; accountId?: string };
    const budget = await getBudgetOrThrow();
    if (!q.payeeId || !q.accountId) return reply.code(400).send({ error: 'payeeId and accountId are required.' });
    await prisma.suggestionDismissal
      .deleteMany({ where: { budgetId: budget.id, payeeId: q.payeeId, accountId: q.accountId } });
    return { ok: true };
  });

  // Dismissed pairs, so the UI can offer a "restore" path.
  app.get('/suggestions/dismissed', async () => {
    const budget = await getBudgetOrThrow();
    const rows = await prisma.suggestionDismissal.findMany({
      where: { budgetId: budget.id },
      select: { payeeId: true, accountId: true, createdAt: true },
    });
    const payees = await prisma.payee.findMany({ where: { budgetId: budget.id }, select: { id: true, name: true } });
    const names = new Map(payees.map((p) => [p.id, p.name]));
    return rows.map((r) => ({ payeeId: r.payeeId, payee: names.get(r.payeeId) ?? '', accountId: r.accountId, createdAt: r.createdAt }));
  });

  // Category drill-down: the transactions behind a category's activity.
  // Posting-aware (split subs expand into their own rows), on-budget only,
  // future-dated excluded, month-of range semantics — mirrors the spending
  // report and budget activity so footer totals match the source cell.
  app.get('/transactions', async (req, reply) => {
    const q = req.query as { categoryId?: string; from?: string; to?: string; accountId?: string };
    if (!q.categoryId) return reply.code(400).send({ error: 'categoryId is required.' });
    const budget = await getBudgetOrThrow();
    const cat = await prisma.category.findUnique({ where: { id: q.categoryId } });
    if (!cat || cat.budgetId !== budget.id) return reply.code(404).send({ error: 'Category not found.' });
    if (cat.isInflow) return reply.code(400).send({ error: 'Ready to Assign has no transaction detail.' });
    if (cat.paymentAccountId) {
      return reply.code(400).send({ error: 'Credit card payment activity is derived, not drillable.' });
    }
    const from = q.from ?? budget.firstMonth;
    const to = q.to ?? budget.lastMonth;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return reply.code(400).send({ error: 'from/to must be YYYY-MM-DD.' });
    }
    if (q.accountId) {
      const acct = await prisma.account.findFirst({ where: { id: q.accountId, budgetId: budget.id } });
      if (!acct) return reply.code(400).send({ error: 'Account not found.' });
    }

    const { txns, accounts } = await loadComputation(budget.id);
    const postings = categoryPostings(txns, accounts, { from, to, accountId: q.accountId, asOf: today() })
      .filter((p) => p.categoryId === q.categoryId)
      .sort((a, b) => (a.date === b.date ? (a.txnId < b.txnId ? 1 : -1) : a.date > b.date ? -1 : 1));

    const [payees, cats] = await Promise.all([
      prisma.payee.findMany({ where: { budgetId: budget.id } }),
      prisma.category.findMany({ where: { budgetId: budget.id } }),
    ]);
    const payeeName = new Map(payees.map((p) => [p.id, p.name]));
    const catName = new Map(cats.map((c) => [c.id, c.isInflow ? 'Ready to Assign' : c.name]));
    const rows = postings.map((p) =>
      serializeTxn(
        {
          id: p.subId ? `${p.txnId}:${p.subId}` : p.txnId,
          date: p.date,
          payeeId: p.payeeId,
          categoryId: p.categoryId,
          memo: p.memo,
          amount: p.amount,
          cleared: p.cleared,
          flagColor: p.flagColor,
          transferAccountId: p.transferAccountId,
          accountId: p.accountId,
          subtransactions: [],
        },
        payeeName,
        catName,
        0,
        false,
      ),
    );
    return { categoryId: q.categoryId, categoryName: cat.name, from, to, txns: rows };
  });

  // Payee management: per-payee usage counts + top categories (for merge UX).
  app.get('/payees/manage', async () => {
    const budget = await getBudgetOrThrow();
    const [payees, txns, cats] = await Promise.all([
      prisma.payee.findMany({ where: { budgetId: budget.id }, orderBy: { name: 'asc' } }),
      prisma.transaction.findMany({
        where: { budgetId: budget.id, deleted: false },
        select: { payeeId: true, categoryId: true },
      }),
      prisma.category.findMany({ where: { budgetId: budget.id }, select: { id: true, name: true } }),
    ]);
    const countByPayee = new Map<string, number>();
    const catsByPayee = new Map<string, Map<string, number>>();
    for (const t of txns) {
      if (!t.payeeId) continue;
      countByPayee.set(t.payeeId, (countByPayee.get(t.payeeId) ?? 0) + 1);
      if (t.categoryId) {
        const row = catsByPayee.get(t.payeeId) ?? new Map<string, number>();
        row.set(t.categoryId, (row.get(t.categoryId) ?? 0) + 1);
        catsByPayee.set(t.payeeId, row);
      }
    }
    const catName = new Map(cats.map((c) => [c.id, c.name]));
    return payees.map((p) => ({
      id: p.id,
      name: p.name,
      isTransfer: p.transferAccountId !== null,
      learnDisabled: p.learnDisabled,
      txnCount: countByPayee.get(p.id) ?? 0,
      categories: [...(catsByPayee.get(p.id) ?? new Map()).entries()]
        .map(([categoryId, count]) => ({ categoryId, name: catName.get(categoryId) ?? '', count }))
        .sort((a, b) => b.count - a.count),
    }));
  });

  // Similar-name payee pairs, for one-click merge suggestions. Pure matcher;
  // merging still goes through POST /payees/merge (undoable).
  app.get('/payees/similar', async () => {
    const budget = await getBudgetOrThrow();
    const payees = await prisma.payee.findMany({ where: { budgetId: budget.id }, select: { id: true, name: true, transferAccountId: true } });
    return findSimilarPayees(payees);
  });

  // ---- Category auto-learning (Actual-style) ------------------------------
  // Server-side gating + modal-category proposal; the UI only renders offers.

  async function ruleCoversName(budgetId: string, name: string): Promise<boolean> {
    const { rules, live } = await loadRuleInputs(budgetId);
    if (rules.length === 0) return false;
    const res = derivePatch({ payeeName: name }, rules, live);
    return res.matchedRuleIds.some((rid) => rules.find((r) => r.id === rid)?.action === 'category');
  }

  app.post('/payees/:id/learn-toggle', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { disabled } = req.body as { disabled?: boolean };
    const budget = await getBudgetOrThrow();
    const p = await prisma.payee.findFirst({ where: { id, budgetId: budget.id } });
    if (!p) return reply.code(404).send({ error: 'Payee not found.' });
    return prisma.payee.update({ where: { id }, data: { learnDisabled: Boolean(disabled) } });
  });

  app.post('/settings/category-learning', async (req, reply) => {
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'enabled (boolean) is required.' });
    const budget = await getBudgetOrThrow();
    await prisma.budget.update({ where: { id: budget.id }, data: { categoryLearning: enabled } });
    return { ok: true };
  });

  // "Always categorize <payee> as <category>?" proposal. Null unless learning
  // is on globally, the payee exists and hasn't opted out, no existing rule
  // already acts on this name, and the modal category is dominant enough
  // (≥3 occurrences and ≥60% of categorized rows).
  app.get('/rules/learning-offer', async (req) => {
    const q = req.query as { payee?: string };
    const name = q.payee?.trim() ?? '';
    const budget = await getBudgetOrThrow();
    if (!budget.categoryLearning || !name || !matchablePayee(name)) return null;
    const payee = await prisma.payee.findFirst({ where: { budgetId: budget.id, name, transferAccountId: null } });
    if (!payee || payee.learnDisabled) return null;
    if (await ruleCoversName(budget.id, name)) return null;
    const txns = await prisma.transaction.findMany({
      where: { budgetId: budget.id, deleted: false, payeeId: payee.id, categoryId: { not: null }, transferAccountId: null },
      select: { subtransactions: { select: { id: true } }, categoryId: true },
      take: 300,
      orderBy: { date: 'desc' },
    });
    const counts = new Map<string, number>();
    let total = 0;
    for (const t of txns) {
      if (t.subtransactions.length > 0 || !t.categoryId) continue;
      counts.set(t.categoryId, (counts.get(t.categoryId) ?? 0) + 1);
      total++;
    }
    if (total === 0) return null;
    const [topId, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topCount < 3 || topCount / total < 0.6) return null;
    const cat = await prisma.category.findFirst({ where: { id: topId, deleted: false }, select: { id: true, name: true } });
    if (!cat) return null;
    return { payeeId: payee.id, pattern: normalizePattern(name), categoryId: cat.id, categoryName: cat.name, count: topCount, total };
  });

  // Create the rename-redirect rule Actual offers after orphaning a payee:
  // future imports whose raw description contains the old name become the
  // canonical payee. Pre-stage so it runs before categorization rules.
  app.post('/rules/auto-rename', async (req, reply) => {
    const { pattern, toName, op = 'contains' } = req.body as { pattern?: string; toName?: string; op?: string };
    const budget = await getBudgetOrThrow();
    const p = normalizePattern(pattern ?? '').replace(/^=+/, '').trim();
    const to = String(toName ?? '').trim();
    if (!p) return reply.code(400).send({ error: 'pattern must not be empty.' });
    if (!to) return reply.code(400).send({ error: 'toName must not be empty.' });
    const effOp = op === 'is' ? 'is' : 'contains';
    const clash = await prisma.payeeRule.findUnique({ where: { budgetId_pattern: { budgetId: budget.id, pattern: p } } });
    if (clash) {
      if (clash.action === 'payeeName' && clash.actionText === to) return { ok: true, id: clash.id };
      return reply.code(409).send({ error: 'A rule with this pattern already exists — edit it instead.' });
    }
    const created = await prisma.payeeRule.create({
      data: {
        budgetId: budget.id,
        pattern: p,
        field: 'payeeName',
        op: effOp,
        stage: 'pre',
        action: 'payeeName',
        actionText: to,
        categoryId: null,
      },
    });
    return { ok: true, id: created.id };
  });

  // Likely duplicate transactions: same account, same date, same |amount|,
  // same payee. The user decides what to delete (bulk delete is undoable).
  app.get('/transactions/duplicates', async (req) => {
    const q = req.query as { accountId?: string };
    const budget = await getBudgetOrThrow();
    const rows = await prisma.transaction.findMany({
      where: { budgetId: budget.id, deleted: false, ...(q.accountId ? { accountId: q.accountId } : {}) },
      include: { payee: { select: { name: true } } },
    });
    const groups = new Map<string, { date: string; amount: number; payeeId: string | null; payee: string; txns: string[] }>();
    for (const t of rows) {
      const k = `${t.accountId}|${t.date}|${Math.abs(t.amount)}|${t.payeeId ?? ''}`;
      const g = groups.get(k) ?? {
        date: t.date,
        amount: t.amount,
        payeeId: t.payeeId,
        payee: t.payee?.name ?? '',
        txns: [],
      };
      g.txns.push(t.id);
      groups.set(k, g);
    }
    return [...groups.values()]
      .filter((g) => g.txns.length > 1 && g.txns.length <= 10)
      .map((g) => ({ date: g.date, amount: g.amount, payeeId: g.payeeId, payee: g.payee, txnIds: g.txns }))
      .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
  });

  app.post('/payees/:id/rename', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { name } = req.body as { name?: string };
    const budget = await getBudgetOrThrow();
    const n = name?.trim();
    if (!n) return reply.code(400).send({ error: 'name must not be empty.' });
    const payee = await prisma.payee.findFirst({ where: { id, budgetId: budget.id } });
    if (!payee) return reply.code(404).send({ error: 'Payee not found.' });
    if (payee.transferAccountId) return reply.code(400).send({ error: 'Transfer payees cannot be renamed.' });
    const clash = await prisma.payee.findFirst({ where: { budgetId: budget.id, name: n, transferAccountId: null } });
    if (clash && clash.id !== id) return reply.code(409).send({ error: 'A payee with this name already exists — merge them instead.' });
    return prisma.payee.update({ where: { id }, data: { name: n } });
  });

  // Merge one payee into another: move transactions, subtransactions and
  // schedules, then delete the source payee. Undoable (mergePayees op).
  app.post('/payees/merge', async (req, reply) => {
    const { fromId, toId } = req.body as { fromId?: string; toId?: string };
    const budget = await getBudgetOrThrow();
    if (!fromId || !toId || fromId === toId) {
      return reply.code(400).send({ error: 'fromId and toId are required and must differ.' });
    }
    const [from, to] = await Promise.all([
      prisma.payee.findFirst({ where: { id: fromId, budgetId: budget.id } }),
      prisma.payee.findFirst({ where: { id: toId, budgetId: budget.id } }),
    ]);
    if (!from || !to) return reply.code(404).send({ error: 'Payee not found.' });
    if (from.transferAccountId || to.transferAccountId) {
      return reply.code(400).send({ error: 'Transfer payees cannot be merged.' });
    }
    const [txns, subs] = await Promise.all([
      prisma.transaction.findMany({ where: { payeeId: fromId, budgetId: budget.id, deleted: false }, select: { id: true } }),
      prisma.subtransaction.findMany({
        where: { payeeId: fromId, transaction: { budgetId: budget.id, deleted: false } },
        select: { id: true },
      }),
    ]);
    await prisma.$transaction(async (tx) => {
      await tx.transaction.updateMany({ where: { id: { in: txns.map((t) => t.id) } }, data: { payeeId: toId } });
      await tx.subtransaction.updateMany({ where: { id: { in: subs.map((s) => s.id) } }, data: { payeeId: toId } });
      await tx.scheduledTransaction.updateMany({ where: { payeeId: fromId }, data: { payeeId: toId } });
      await tx.payee.delete({ where: { id: fromId } });
      await logOps(tx, budget.id, 'mergePayees', {
        fromId,
        toId,
        fromName: from.name,
        txnIds: txns.map((t) => t.id),
        subTxnIds: subs.map((s) => s.id),
      });
    });
    return { ok: true, moved: txns.length + subs.length };
  });

  app.get('/accounts/:id/transactions', async (req) => {
    const { id } = req.params as { id: string };
    const budget = await getBudgetOrThrow();
    const [rows, payees, categories, scheduled] = await Promise.all([
      prisma.transaction.findMany({
        where: { accountId: id, deleted: false },
        include: { subtransactions: true },
      }),
      prisma.payee.findMany({ where: { budgetId: budget.id } }),
      prisma.category.findMany({ where: { budgetId: budget.id } }),
      prisma.scheduledTransaction.findMany({ where: { accountId: id, deleted: false } }),
    ]);
    const payeeName = new Map(payees.map((p) => [p.id, p.name]));
    const catName = new Map(categories.map((c) => [c.id, c.isInflow ? 'Ready to Assign' : c.name]));

    // Running balance: oldest → newest.
    const asc = [...rows].sort((a, b) =>
      a.date === b.date ? (a.createdAt < b.createdAt ? -1 : 1) : a.date < b.date ? -1 : 1,
    );
    const running = new Map<string, number>();
    let bal = 0;
    for (const t of asc) {
      bal += t.amount;
      running.set(t.id, bal);
    }

    // Newest first for display.
    const display = [...rows]
      .sort((a, b) => (a.date === b.date ? (a.createdAt > b.createdAt ? -1 : 1) : a.date > b.date ? -1 : 1))
      .map((t) => serializeTxn(t, payeeName, catName, running.get(t.id) ?? 0, t.date > today()));

    // Scheduled ghost rows: the next occurrence of each schedule, shown as
    // upcoming. Not real transactions — the engine never sees them.
    const ghosts = scheduled.map((s) =>
      serializeTxn(
        {
          id: 'sched:' + s.id,
          date: s.nextDate,
          payeeId: s.payeeId,
          categoryId: s.categoryId,
          memo: s.memo,
          amount: s.amount,
          cleared: 'uncleared' as const,
          flagColor: s.flagColor,
          transferAccountId: s.transferAccountId,
          accountId: s.accountId,
          subtransactions: [],
          scheduledId: s.id,
          frequency: s.frequency,
          anchorDay: s.anchorDay,
        },
        payeeName,
        catName,
        0,
        true,
      ),
    );

    return [...ghosts, ...display].sort((a, b) => (a.date === b.date ? 0 : a.date > b.date ? -1 : 1));
  });

  app.post('/accounts', async (req) => {
    const { name, type, onBudget, balance } = req.body as {
      name: string;
      type: string;
      onBudget?: boolean;
      balance?: number;
    };
    const budget = await getBudgetOrThrow();
    const count = await prisma.account.count({ where: { budgetId: budget.id } });
    const onB = onBudget ?? !['otherAsset', 'otherLiability', 'mortgage', 'autoLoan'].includes(type);
    const account = await prisma.account.create({
      data: { budgetId: budget.id, name, type, onBudget: onB, sortOrder: count },
    });
    // A credit card gets a payment category in the system "Credit Card Payments"
    // group — the engine routes funded card spending into it.
    if (onB && (type === 'creditCard' || type === 'lineOfCredit')) {
      let group = await prisma.categoryGroup.findFirst({
        where: { budgetId: budget.id, name: 'Credit Card Payments', isSystem: true, deleted: false },
      });
      if (!group) {
        group = await prisma.categoryGroup.create({
          data: { budgetId: budget.id, name: 'Credit Card Payments', isSystem: true, sortOrder: -1 },
        });
      }
      const catCount = await prisma.category.count({ where: { groupId: group.id } });
      await prisma.category.create({
        data: { budgetId: budget.id, groupId: group.id, name, paymentAccountId: account.id, sortOrder: catCount },
      });
    }
    // Starting balance → inflow categorized to Ready to Assign (on-budget) so it lands in RTA.
    const start = Math.round(balance ?? 0);
    if (start !== 0) {
      const inflowCat = await prisma.category.findFirst({ where: { budgetId: budget.id, isInflow: true } });
      await prisma.transaction.create({
        data: {
          budgetId: budget.id,
          accountId: account.id,
          date: today(),
          amount: start,
          cleared: 'cleared',
          payeeId: await resolvePayee(budget.id, 'Starting Balance'),
          categoryId: onB && start > 0 ? inflowCat?.id ?? null : null,
        },
      });
    }
    return account;
  });

  app.post('/transactions', async (req, reply) => {
    const b = req.body as TxnBody;
    const budget = await getBudgetOrThrow();
    let created: Awaited<ReturnType<typeof createTransaction>> | undefined;
    try {
      await prisma.$transaction(async (tx) => {
        created = await createTransaction(budget.id, b, tx);
        const transferTxnId = b.transferAccountId
          ? (await tx.transaction.findUnique({
              where: { id: created.id },
              select: { transferTransactionId: true },
            }))?.transferTransactionId ?? null
          : null;
        await logOps(tx, budget.id, 'createTxn', { txnId: created.id, transferTxnId });
      });
    } catch (e) {
      if (e instanceof SplitValidationError) {
        return reply.code(400).send({ error: e.message });
      }
      throw e;
    }
    return created;
  });

  // Bulk edit: reassign category/flag or soft-delete many transactions at once.
  // Transfers keep their category locked and split parents are skipped for
  // category changes (their sub-postings are authoritative). Each affected row
  // logs a regular undo op, so bulk edits are undoable one by one.
  app.post('/transactions/bulk', async (req, reply) => {
    const b = req.body as {
      ids?: string[];
      data?: { categoryId?: string | null; flagColor?: string | null };
      delete?: boolean;
    };
    const budget = await getBudgetOrThrow();
    const ids = [...new Set(b.ids ?? [])];
    if (ids.length === 0 || ids.length > 500) {
      return reply.code(400).send({ error: 'ids must be a non-empty array of at most 500 ids.' });
    }
    const wantDelete = b.delete === true;
    const data: Record<string, unknown> = {};
    if (b.data?.categoryId !== undefined) data.categoryId = b.data.categoryId;
    if (b.data?.flagColor !== undefined) data.flagColor = b.data.flagColor;
    if (!wantDelete && Object.keys(data).length === 0) {
      return reply.code(400).send({ error: 'Nothing to change.' });
    }
    const rows = await prisma.transaction.findMany({
      where: { id: { in: ids }, budgetId: budget.id, deleted: false },
      include: { subtransactions: { select: { id: true } } },
    });
    if (rows.length === 0) return reply.code(404).send({ error: 'No matching transactions.' });

    let skipped = 0;
    await prisma.$transaction(async (tx) => {
      for (const t of rows) {
        if (wantDelete) {
          await tx.transaction.update({ where: { id: t.id }, data: { deleted: true } });
          if (t.transferTransactionId) {
            await tx.transaction.update({ where: { id: t.transferTransactionId }, data: { deleted: true } });
          }
          await logOps(tx, budget.id, 'deleteTxn', { txnId: t.id, transferTxnId: t.transferTransactionId ?? null });
          continue;
        }
        // category changes skip transfers (locked) and split parents (no effect)
        if (data.categoryId !== undefined && (t.transferAccountId || t.subtransactions.length > 0)) {
          skipped++;
          continue;
        }
        const prev: Record<string, unknown> = {};
        if (data.categoryId !== undefined) prev.categoryId = t.categoryId;
        if (data.flagColor !== undefined) prev.flagColor = t.flagColor;
        await tx.transaction.update({ where: { id: t.id }, data });
        await logOps(tx, budget.id, 'updateTxn', {
          txnId: t.id,
          transferTxnId: t.transferTransactionId ?? null,
          prev,
          prevMirror: null,
        });
      }
    });
    return { ok: true, updated: rows.length - skipped, skipped };
  });

  // Scheduled transactions: CRUD. Materialization happens on GET /budget.
  // Used by the Subscriptions view: startMonth/endMonth bound the run.
  app.get('/scheduled', async () => {
    const budget = await getBudgetOrThrow();
    const [rows, payees, categories] = await Promise.all([
      prisma.scheduledTransaction.findMany({ where: { budgetId: budget.id, deleted: false }, orderBy: { nextDate: 'asc' } }),
      prisma.payee.findMany({ where: { budgetId: budget.id } }),
      prisma.category.findMany({ where: { budgetId: budget.id } }),
    ]);
    const payeeName = new Map(payees.map((p) => [p.id, p.name]));
    const catName = new Map(categories.map((c) => [c.id, c.isInflow ? 'Ready to Assign' : c.name]));
    return rows.map((s) => ({
      id: s.id,
      accountId: s.accountId,
      payeeId: s.payeeId,
      payee: s.payeeId ? (payeeName.get(s.payeeId) ?? null) : null,
      categoryId: s.categoryId,
      category: s.categoryId ? (catName.get(s.categoryId) ?? null) : null,
      amount: s.amount,
      memo: s.memo,
      flagColor: s.flagColor,
      frequency: s.frequency,
      nextDate: s.nextDate,
      anchorDay: s.anchorDay,
      startMonth: s.startMonth,
      endMonth: s.endMonth,
      transferAccountId: s.transferAccountId,
    }));
  });

  app.post('/scheduled', async (req) => {
    const b = req.body as TxnBody & {
      frequency: string;
      nextDate?: string;
      anchorDay?: number | null;
      startMonth?: string | null;
      endMonth?: string | null;
    };
    const budget = await getBudgetOrThrow();
    // Rules apply only to plain spending drafts — transfer schedules have no
    // category of their own.
    const { rules, live } = await loadRuleInputs(budget.id);
    let patch: Partial<DerivedPatch> = {};
    if (!b.transferAccountId)
      patch = derivePatch(
        {
          payeeName: await payeeNameFor(budget.id, { payeeName: b.payeeName, payeeId: b.payeeId }),
          accountId: b.accountId,
          memo: b.memo ?? null,
        },
        rules,
        live,
      );
    const payeeId = b.payeeId ?? (await resolvePayee(budget.id, patch.payeeName ?? b.payeeName));
    const categoryId = b.categoryId ?? patch.categoryId ?? null;
    const memo = patch.memo !== undefined ? patch.memo : (b.memo ?? null);
    // New subscriptions: nextDate = first of startMonth, never backdating; monthly pins day 1.
    const nextDate = b.nextDate ?? (b.startMonth ? (b.startMonth < today() ? today() : b.startMonth) : today());
    const anchorDay = b.anchorDay ?? (b.frequency === 'monthly' && !b.nextDate ? 1 : b.anchorDay ?? null);
    return prisma.scheduledTransaction.create({
      data: {
        budgetId: budget.id,
        accountId: b.accountId,
        amount: signedAmount(b),
        memo,
        flagColor: b.flagColor ?? null,
        categoryId,
        transferAccountId: b.transferAccountId ?? null,
        payeeId,
        frequency: b.frequency,
        nextDate,
        anchorDay,
        startMonth: b.startMonth ?? null,
        endMonth: b.endMonth ?? null,
      },
    });
  });

  app.patch('/scheduled/:id', async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as Partial<TxnBody & { frequency: string; nextDate: string; startMonth?: string | null; endMonth?: string | null }>;
    const budget = await getBudgetOrThrow();
    const data: Record<string, unknown> = {};
    if (b.memo !== undefined) data.memo = b.memo;
    if (b.flagColor !== undefined) data.flagColor = b.flagColor;
    if (b.categoryId !== undefined) data.categoryId = b.categoryId;
    if (b.frequency !== undefined) data.frequency = b.frequency;
    if (b.nextDate !== undefined) data.nextDate = b.nextDate;
    if (b.date !== undefined) data.nextDate = b.date;
    if (b.startMonth !== undefined) data.startMonth = b.startMonth;
    if (b.endMonth !== undefined) data.endMonth = b.endMonth;
    if (b.payeeName !== undefined) data.payeeId = await resolvePayee(budget.id, b.payeeName);
    if (b.amount !== undefined || b.outflow !== undefined || b.inflow !== undefined) {
      data.amount = signedAmount(b as TxnBody);
    }
    return prisma.scheduledTransaction.update({ where: { id }, data });
  });

  app.delete('/scheduled/:id', async (req) => {
    const { id } = req.params as { id: string };
    await prisma.scheduledTransaction.update({ where: { id }, data: { deleted: true } });
    return { ok: true };
  });

  // Skip the next occurrence: advance nextDate without materializing a
  // transaction (e.g. a cancelled subscription month).
  app.post('/scheduled/:id/skip', async (req, reply) => {
    const { id } = req.params as { id: string };
    const budget = await getBudgetOrThrow();
    const s = await prisma.scheduledTransaction.findFirst({ where: { id, budgetId: budget.id, deleted: false } });
    if (!s) return reply.code(404).send({ error: 'Schedule not found.' });
    const n = nextOccurrence(s.frequency, s.nextDate, s.anchorDay ?? undefined);
    if (!n) return reply.code(400).send({ error: 'This schedule has no next occurrence.' });
    return prisma.scheduledTransaction.update({ where: { id }, data: { nextDate: n } });
  });

  app.patch('/transactions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as Partial<TxnBody>;
    const budget = await getBudgetOrThrow();

    // Split payloads are validated against the (possibly new) parent amount
    // before anything is written.
    let subPayload: SubInput[] | null = null;
    if (b.subtransactions !== undefined) {
      const probe = await prisma.transaction.findFirst({
        where: { id, deleted: false },
        select: { transferAccountId: true, amount: true },
      });
      if (!probe) return reply.code(404).send({ error: 'Transaction not found.' });
      if (probe.transferAccountId) return reply.code(400).send({ error: 'Transfers cannot be split.' });
      const parentAmount = b.amount !== undefined || b.outflow !== undefined || b.inflow !== undefined
        ? signedAmount(b as TxnBody)
        : probe.amount;
      const err = await validateSplits(budget.id, b.subtransactions, parentAmount);
      if (err) return reply.code(400).send({ error: err.error });
      subPayload = b.subtransactions;
    }

    const data: Record<string, unknown> = {};
    if (b.date !== undefined) data.date = b.date;
    if (b.memo !== undefined) data.memo = b.memo;
    if (b.cleared !== undefined) data.cleared = b.cleared;
    if (b.flagColor !== undefined) data.flagColor = b.flagColor;
    if (b.categoryId !== undefined) data.categoryId = b.categoryId;
    if (b.payeeName !== undefined) data.payeeId = await resolvePayee(budget.id, b.payeeName);
    if (b.payeeId !== undefined) data.payeeId = b.payeeId;
    if (b.amount !== undefined || b.outflow !== undefined || b.inflow !== undefined) {
      data.amount = signedAmount(b as TxnBody);
    }
    const out = await prisma.$transaction(async (tx) => {
      const existing = await tx.transaction.findFirst({
        where: { id, deleted: false },
        include: { subtransactions: true },
      });
      if (!existing) return null;
      const prev = {
        date: existing.date,
        amount: existing.amount,
        memo: existing.memo,
        cleared: existing.cleared,
        flagColor: existing.flagColor,
        categoryId: existing.categoryId,
        payeeId: existing.payeeId,
      };
      // A split parent's category comes from its sub-postings; keep it null
      // unless the caller explicitly sets one.
      if (subPayload && data.categoryId === undefined) data.categoryId = null;
      const updated = await tx.transaction.update({ where: { id }, data });
      // Keep a transfer's paired leg in sync (mirror amount + date).
      let prevMirror: { date: string; amount: number } | null = null;
      if (updated.transferTransactionId && (data.amount !== undefined || data.date !== undefined)) {
        const mirror = await tx.transaction.findFirst({
          where: { id: updated.transferTransactionId },
          select: { date: true, amount: true },
        });
        if (mirror) {
          prevMirror = mirror;
          await tx.transaction.update({
            where: { id: updated.transferTransactionId },
            data: { amount: -updated.amount, date: updated.date },
          });
        }
      }
      // Replace the split rows (pre-image goes into the undo op).
      let prevSubs: SubLike[] | null = null;
      if (subPayload) {
        prevSubs = existing.subtransactions.map((s) => ({
          id: s.id,
          amount: s.amount,
          categoryId: s.categoryId,
          payeeId: s.payeeId,
          memo: s.memo,
          transferAccountId: s.transferAccountId,
        }));
        await tx.subtransaction.deleteMany({ where: { transactionId: id } });
        await createSubs(tx, budget.id, id, subPayload);
      }
      await logOps(tx, budget.id, 'updateTxn', {
        txnId: id,
        transferTxnId: updated.transferTransactionId ?? null,
        prev,
        prevMirror,
        prevSubs,
      });
      return updated;
    });
    if (!out) return reply.code(404).send({ error: 'Transaction not found.' });
    return out;
  });

  app.delete('/transactions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const budget = await getBudgetOrThrow();
    const t = await prisma.transaction.findFirst({ where: { id, deleted: false } });
    if (!t) return reply.code(404).send({ error: 'Transaction not found.' });
    await prisma.$transaction(async (tx) => {
      await tx.transaction.update({ where: { id }, data: { deleted: true } });
      if (t.transferTransactionId) {
        await tx.transaction.update({ where: { id: t.transferTransactionId }, data: { deleted: true } });
      }
      await logOps(tx, budget.id, 'deleteTxn', { txnId: id, transferTxnId: t.transferTransactionId ?? null });
    });
    return { ok: true };
  });

  // Toggle cleared state. Reconciled lock is advisory (confirm dialog
  // client-side); server enforcement only if multi-user ever exists.
  app.patch('/transactions/:id/cleared', async (req) => {
    const { id } = req.params as { id: string };
    const { cleared } = req.body as { cleared: string };
    return prisma.transaction.update({ where: { id }, data: { cleared } });
  });

  // Reconcile: lock all cleared txns as reconciled; if the actual bank balance
  // differs from the cleared balance, write an adjustment transaction. Cash
  // account adjustments are categorized to Inflow: Ready to Assign (both signs
  // — a negative adjustment just reduces RTA). Credit cards and tracking
  // accounts get no category: an unexplained card diff is debt, not budget money.
  app.post('/accounts/:id/reconcile', async (req) => {
    const { id } = req.params as { id: string };
    const { balance } = req.body as { balance: number };
    const budget = await getBudgetOrThrow();
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });

    const agg = await prisma.transaction.aggregate({
      where: { accountId: id, deleted: false, cleared: { not: 'uncleared' } },
      _sum: { amount: true },
    });
    const clearedBalance = agg._sum.amount ?? 0;

    const diff = Math.round(balance) - clearedBalance;
    const out = await prisma.$transaction(async (tx) => {
      // Capture the pre-flip set so undo can downgrade exactly these rows.
      const flipped = (
        await tx.transaction.findMany({
          where: { accountId: id, deleted: false, cleared: 'cleared' },
          select: { id: true },
        })
      ).map((t) => t.id);
      await tx.transaction.updateMany({
        where: { accountId: id, deleted: false, cleared: 'cleared' },
        data: { cleared: 'reconciled' },
      });

      let adjustmentTxnId: string | null = null;
      if (diff !== 0) {
        const isCash = account.onBudget && account.type !== 'creditCard' && account.type !== 'lineOfCredit';
        const inflowCat = isCash
          ? await tx.category.findFirst({ where: { budgetId: budget.id, isInflow: true } })
          : null;
        const adj = await tx.transaction.create({
          data: {
            budgetId: budget.id,
            accountId: id,
            date: today(),
            amount: diff,
            cleared: 'reconciled',
            payeeId: await resolvePayee(budget.id, 'Reconciliation Balance Adjustment', tx),
            categoryId: inflowCat?.id ?? null,
            memo: 'Entered automatically by reconciliation',
          },
        });
        adjustmentTxnId = adj.id;
      }
      await logOps(tx, budget.id, 'reconcile', { accountId: id, adjustmentTxnId, flipped });
      return { adjusted: diff, adjustmentTxnId, flipped };
    });
    return out;
  });
}
