import { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { getBudgetOrThrow, loadComputation, today } from '../engineLoad';
import { addMonths } from '../engine/budget';

// GoalPlan routes — the savings mirror of DebtPlan. Inputs are stored; the
// progress/contribution math is derived on read (frontend payoff.ts).
// Contribution schedules are materialized as monthly ScheduledTransactions
// (memo-marked, idempotent), feeding the budget and the Cash Flow projection.

const nextMonth = (d: string) => addMonths(d.slice(0, 7) + '-01', 1);
const planMemo = (planId: string) => `Piano risparmio: ${planId}`;

function firstNextDate(startMonth: string): { nextDate: string; anchorDay: number } {
  const base = startMonth.slice(0, 7) + '-01';
  return { nextDate: base <= today() ? nextMonth(today()) : base, anchorDay: 1 };
}

export default async function goalRoutes(app: FastifyInstance) {
  app.get('/goal-plans', async () => {
    const budget = await getBudgetOrThrow();
    const { accounts, balances } = await loadComputation(budget.id);
    const [plans, schedules, cats] = await Promise.all([
      prisma.goalPlan.findMany({ where: { budgetId: budget.id }, orderBy: { createdAt: 'asc' } }),
      prisma.scheduledTransaction.findMany({
        where: { budgetId: budget.id, deleted: false },
        select: { memo: true },
      }),
      prisma.category.findMany({ where: { budgetId: budget.id }, select: { id: true, name: true } }),
    ]);
    const scheduledPlanIds = new Set(
      schedules.map((s) => (      s.memo?.startsWith('Piano risparmio: ') ? s.memo.slice(17) : null)).filter((x): x is string => !!x),
    );
    const balanceOf = (accountId: string | null) => (accountId ? (balances[accountId]?.working ?? 0) : null);
    const catName = new Map(cats.map((c) => [c.id, c.name]));
    return plans.map((p) => ({
      id: p.id,
      name: p.name,
      accountId: p.accountId,
      accountName: p.accountId ? (accounts.find((a) => a.id === p.accountId)?.name ?? '') : null,
      categoryId: p.categoryId,
      categoryName: p.categoryId ? (catName.get(p.categoryId) ?? '') : null,
      target: p.target,
      current: p.current,
      effectiveCurrent: balanceOf(p.accountId) ?? p.current,
      monthlyContribution: p.monthlyContribution,
      targetMonth: p.targetMonth,
      startMonth: p.startMonth,
      active: p.active,
      note: p.note,
      hasContributionSchedule: scheduledPlanIds.has(p.id),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));
  });

  app.post('/goal-plans', async (req, reply) => {
    const b = req.body as {
      name?: string;
      accountId?: string | null;
      categoryId?: string | null;
      target?: number;
      current?: number;
      monthlyContribution?: number;
      targetMonth?: string | null;
      startMonth?: string;
      note?: string | null;
      active?: boolean;
    };
    const budget = await getBudgetOrThrow();
    const name = b.name?.trim();
    if (!name) return reply.code(400).send({ error: 'name is required.' });
    if (!b.startMonth || !/^\d{4}-\d{2}-\d{2}$/.test(b.startMonth)) {
      return reply.code(400).send({ error: 'startMonth must be YYYY-MM-01.' });
    }
    if (b.targetMonth && !/^\d{4}-\d{2}-\d{2}$/.test(b.targetMonth)) {
      return reply.code(400).send({ error: 'targetMonth must be YYYY-MM-01.' });
    }
    let accountId: string | null = null;
    if (b.accountId) {
      const acct = await prisma.account.findFirst({ where: { id: b.accountId, budgetId: budget.id } });
      if (!acct) return reply.code(400).send({ error: 'Account not found.' });
      accountId = acct.id;
    }
    let categoryId: string | null = null;
    if (b.categoryId) {
      const cat = await prisma.category.findFirst({ where: { id: b.categoryId, budgetId: budget.id, deleted: false } });
      if (!cat) return reply.code(400).send({ error: 'Category not found.' });
      categoryId = cat.id;
    }
    return prisma.goalPlan.create({
      data: {
        budgetId: budget.id,
        name,
        accountId,
        categoryId,
        target: Math.round(b.target ?? 0),
        current: Math.round(b.current ?? 0),
        monthlyContribution: Math.round(b.monthlyContribution ?? 0),
        targetMonth: b.targetMonth ?? null,
        startMonth: b.startMonth,
        note: b.note ?? null,
        active: b.active ?? true,
      },
    });
  });

  app.patch('/goal-plans/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, unknown>;
    const budget = await getBudgetOrThrow();
    const existing = await prisma.goalPlan.findFirst({ where: { id, budgetId: budget.id } });
    if (!existing) return reply.code(404).send({ error: 'Plan not found.' });
    if (b.name !== undefined && String(b.name).trim() === '') return reply.code(400).send({ error: 'name must not be empty.' });
    const data: Record<string, unknown> = {};
    for (const k of ['name', 'target', 'current', 'monthlyContribution', 'targetMonth', 'startMonth', 'note', 'active'] as const) {
      if (b[k] !== undefined) data[k] = typeof b[k] === 'number' ? Math.round(b[k] as number) : b[k];
    }
    if (b.accountId !== undefined) {
      if (b.accountId === null) data.accountId = null;
      else {
        const acct = await prisma.account.findFirst({ where: { id: String(b.accountId), budgetId: budget.id } });
        if (!acct) return reply.code(400).send({ error: 'Account not found.' });
        data.accountId = acct.id;
      }
    }
    if (b.categoryId !== undefined) {
      if (b.categoryId === null) data.categoryId = null;
      else {
        const cat = await prisma.category.findFirst({
          where: { id: String(b.categoryId), budgetId: budget.id, deleted: false },
        });
        if (!cat) return reply.code(400).send({ error: 'Category not found.' });
        data.categoryId = cat.id;
      }
    }
    return prisma.goalPlan.update({ where: { id }, data });
  });

  app.delete('/goal-plans/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const budget = await getBudgetOrThrow();
    const existing = await prisma.goalPlan.findFirst({ where: { id, budgetId: budget.id } });
    if (!existing) return reply.code(404).send({ error: 'Plan not found.' });
    await prisma.goalPlan.delete({ where: { id } });
    return { ok: true };
  });

  // Materialize the plan's contributions as a monthly ScheduledTransaction on
  // its funding category. Idempotent per plan (memo marker).
  app.post('/goal-plans/:id/contribution-schedule', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { accountId?: string; amount?: number };
    const budget = await getBudgetOrThrow();
    const plan = await prisma.goalPlan.findFirst({ where: { id, budgetId: budget.id } });
    if (!plan) return reply.code(404).send({ error: 'Plan not found.' });
    if (!plan.categoryId) return reply.code(400).send({ error: 'The plan needs a funding category first.' });
    const amount = Math.round(Number(b.amount) || plan.monthlyContribution);
    if (amount <= 0) return reply.code(400).send({ error: 'A positive contribution amount is required.' });
    const source = await prisma.account.findFirst({ where: { id: String(b.accountId ?? ''), budgetId: budget.id } });
    if (!source) return reply.code(400).send({ error: 'Source account not found.' });

    const existing = await prisma.scheduledTransaction.findFirst({
      where: { budgetId: budget.id, deleted: false, memo: planMemo(plan.id) },
    });
    if (existing) return existing;

    const { nextDate, anchorDay } = firstNextDate(plan.startMonth);
    const payee = await prisma.payee.upsert({
      where: { id: `__goal_${plan.id}` },
      create: { id: `__goal_${plan.id}`, budgetId: budget.id, name: `Risparmio: ${plan.name}` },
      update: { name: `Risparmio: ${plan.name}` },
    });
    return prisma.scheduledTransaction.create({
      data: {
        budgetId: budget.id,
        accountId: source.id,
        payeeId: payee.id,
        categoryId: plan.categoryId,
        amount: -amount,
        frequency: 'monthly',
        nextDate,
        anchorDay,
        memo: planMemo(plan.id),
      },
    });
  });
}
