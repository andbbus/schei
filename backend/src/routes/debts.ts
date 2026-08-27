import { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { getBudgetOrThrow, loadComputation, today } from '../engineLoad';
import { addMonths } from '../engine/budget';

// DebtPlan routes: persisted amortization plans. The schedule itself is
// derived on read (frontend payoff.ts); the server stores inputs and can
// materialize the plan's payments as a monthly ScheduledTransaction so the
// budget and cash-flow projection see them.

const nextMonth = (d: string) => addMonths(d.slice(0, 7) + '-01', 1);
const planMemo = (planId: string) => `Piano ammortamento: ${planId}`;

// A schedule due on the 1st of startMonth (or next month if it already passed).
function firstNextDate(startMonth: string): { nextDate: string; anchorDay: number } {
  const base = startMonth.slice(0, 7) + '-01';
  return { nextDate: base <= today() ? nextMonth(today()) : base, anchorDay: 1 };
}

export default async function debtRoutes(app: FastifyInstance) {
  // list with effective balance (linked-account sync) + payment-schedule state
  app.get('/debt-plans', async () => {
    const budget = await getBudgetOrThrow();
    const { accounts, balances } = await loadComputation(budget.id);
    const [plans, schedules] = await Promise.all([
      prisma.debtPlan.findMany({ where: { budgetId: budget.id }, orderBy: { createdAt: 'asc' } }),
      prisma.scheduledTransaction.findMany({
        where: { budgetId: budget.id, deleted: false },
        select: { memo: true },
      }),
    ]);
    const scheduledPlanIds = new Set(
      schedules.map((s) => s.memo?.startsWith('Piano ammortamento: ') ? s.memo.slice(20) : null).filter((x): x is string => !!x),
    );
    const balanceOf = (accountId: string | null) => {
      if (!accountId) return null;
      const b = balances[accountId]?.working ?? 0;
      return -b;
    };
    return plans.map((p) => ({
      id: p.id,
      name: p.name,
      accountId: p.accountId,
      accountName: p.accountId ? (accounts.find((a) => a.id === p.accountId)?.name ?? '') : null,
      balance: p.balance,
      effectiveBalance: balanceOf(p.accountId) ?? p.balance,
      tanBps: p.tanBps,
      payment: p.payment,
      targetMonth: p.targetMonth,
      extraPayment: p.extraPayment,
      startMonth: p.startMonth,
      active: p.active,
      note: p.note,
      hasPaymentSchedule: scheduledPlanIds.has(p.id),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));
  });

  app.post('/debt-plans', async (req, reply) => {
    const b = req.body as {
      name?: string;
      accountId?: string | null;
      balance?: number;
      tanBps?: number;
      payment?: number;
      targetMonth?: string | null;
      extraPayment?: number;
      startMonth?: string;
      note?: string | null;
      active?: boolean;
    };
    const budget = await getBudgetOrThrow();
    const name = b.name?.trim();
    if (!name) return reply.code(400).send({ error: 'name is required.' });
    if (b.tanBps !== undefined && (b.tanBps < 0 || b.tanBps > 5000)) {
      return reply.code(400).send({ error: 'tanBps must be between 0 and 5000 (0-50%).' });
    }
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
    return prisma.debtPlan.create({
      data: {
        budgetId: budget.id,
        name,
        accountId,
        balance: Math.round(b.balance ?? 0),
        tanBps: Math.round(b.tanBps ?? 0),
        payment: Math.round(b.payment ?? 0),
        targetMonth: b.targetMonth ?? null,
        extraPayment: Math.round(b.extraPayment ?? 0),
        startMonth: b.startMonth,
        note: b.note ?? null,
        active: b.active ?? true,
      },
    });
  });

  app.patch('/debt-plans/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, unknown>;
    const budget = await getBudgetOrThrow();
    const existing = await prisma.debtPlan.findFirst({ where: { id, budgetId: budget.id } });
    if (!existing) return reply.code(404).send({ error: 'Plan not found.' });
    if (b.name !== undefined && String(b.name).trim() === '') return reply.code(400).send({ error: 'name must not be empty.' });
    if (b.tanBps !== undefined && (Number(b.tanBps) < 0 || Number(b.tanBps) > 5000)) {
      return reply.code(400).send({ error: 'tanBps must be between 0 and 5000 (0-50%).' });
    }
    const data: Record<string, unknown> = {};
    for (const k of ['name', 'balance', 'tanBps', 'payment', 'targetMonth', 'extraPayment', 'startMonth', 'note', 'active'] as const) {
      if (b[k] !== undefined) data[k] = typeof b[k] === 'number' ? Math.round(b[k] as number) : b[k];
    }
    if (b.accountId !== undefined) {
      if (b.accountId === null) {
        data.accountId = null;
      } else {
        const acct = await prisma.account.findFirst({ where: { id: String(b.accountId), budgetId: budget.id } });
        if (!acct) return reply.code(400).send({ error: 'Account not found.' });
        data.accountId = acct.id;
      }
    }
    return prisma.debtPlan.update({ where: { id }, data });
  });

  app.delete('/debt-plans/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const budget = await getBudgetOrThrow();
    const existing = await prisma.debtPlan.findFirst({ where: { id, budgetId: budget.id } });
    if (!existing) return reply.code(404).send({ error: 'Plan not found.' });
    await prisma.debtPlan.delete({ where: { id } });
    return { ok: true };
  });

  // Materialize the plan's payments as a ScheduledTransaction (monthly by
  // default, 'once' for single lump sums). Linked plans become scheduled
  // transfers to the tracking account; manual plans become plain expenses.
  // Idempotent per plan (memo marker): a second call returns the schedule.
  app.post('/debt-plans/:id/payment-schedule', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { accountId?: string; categoryId?: string | null; amount?: number; frequency?: string };
    const budget = await getBudgetOrThrow();
    const plan = await prisma.debtPlan.findFirst({ where: { id, budgetId: budget.id } });
    if (!plan) return reply.code(404).send({ error: 'Plan not found.' });
    const amount = -Math.round(Number(b.amount) || plan.payment);
    if (amount >= 0) return reply.code(400).send({ error: 'A positive payment amount is required.' });
    const frequency = b.frequency === 'once' ? 'once' : 'monthly';
    const source = await prisma.account.findFirst({ where: { id: String(b.accountId ?? ''), budgetId: budget.id } });
    if (!source) return reply.code(400).send({ error: 'Source account not found.' });

    const existing = await prisma.scheduledTransaction.findFirst({
      where: { budgetId: budget.id, deleted: false, memo: planMemo(plan.id) },
    });
    if (existing) return existing;

    const { nextDate, anchorDay } = firstNextDate(plan.startMonth);
    if (plan.accountId) {
      const target = await prisma.account.findUniqueOrThrow({ where: { id: plan.accountId } });
      const payee = await prisma.payee.findFirst({ where: { transferAccountId: target.id } });
      const payeeId = payee
        ? payee.id
        : (
            await prisma.payee.create({
              data: { budgetId: budget.id, name: `Transfer : ${target.name}`, transferAccountId: target.id },
            })
          ).id;
      return prisma.scheduledTransaction.create({
        data: {
          budgetId: budget.id,
          accountId: source.id,
          transferAccountId: target.id,
          payeeId,
          categoryId: null,
          amount,
          frequency,
          nextDate,
          anchorDay: frequency === 'monthly' ? anchorDay : null,
          memo: planMemo(plan.id),
        },
      });
    }
    return prisma.scheduledTransaction.create({
      data: {
        budgetId: budget.id,
        accountId: source.id,
        payeeId: (
          await prisma.payee.upsert({
            where: { id: `__plan_${plan.id}` },
            create: { id: `__plan_${plan.id}`, budgetId: budget.id, name: plan.name },
            update: { name: plan.name },
          })
        ).id,
        categoryId: b.categoryId ?? null,
        amount,
        frequency,
        nextDate,
        anchorDay: frequency === 'monthly' ? anchorDay : null,
        memo: planMemo(plan.id),
      },
    });
  });
}
