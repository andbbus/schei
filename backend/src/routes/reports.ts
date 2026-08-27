import { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { getBudgetOrThrow, loadComputation, today } from '../engineLoad';
import { monthOf } from '../engine/budget';
import { computeAgeOfMoney } from '../engine/ageOfMoney';
import { categoryPostings } from '../engine/postings';
import { projectCashflow } from '../engine/cashflow';
import { detectAnomalies, AnomalyInputTxn } from '../engine/anomalies';
import { TargetInput } from '../engine/targets';
import { materializeDue } from './register';

export default async function reportRoutes(app: FastifyInstance) {
  // Spending totals by category + group over a month range (donut + breakdown).
  // Optional accountId narrows to a single account's transactions.
  // Posting-aware: split subtransactions count under their own category, and
  // only on-budget accounts feed the budget, so this matches budget activity.
  app.get('/reports/spending', async (req) => {
    const q = req.query as { from?: string; to?: string; accountId?: string };
    const budget = await getBudgetOrThrow();
    const { txns, accounts, categories } = await loadComputation(budget.id);
    const from = q.from ?? budget.firstMonth;
    const to = q.to ?? budget.lastMonth;

    const catMeta = new Map(categories.map((c) => [c.id, c]));
    const byCat = new Map<string, number>();
    for (const p of categoryPostings(txns, accounts, { from, to, accountId: q.accountId, asOf: today() })) {
      const c = catMeta.get(p.categoryId);
      if (!c || c.isInflow) continue;
      if (p.amount >= 0) continue; // spending only
      byCat.set(p.categoryId, (byCat.get(p.categoryId) ?? 0) + -p.amount);
    }
    const totals = [...byCat.entries()]
      .map(([id, amount]) => ({
        categoryId: id,
        name: catMeta.get(id)?.name ?? '',
        amount,
      }))
      .sort((a, b) => b.amount - a.amount);
    return { from, to, total: totals.reduce((s, x) => s + x.amount, 0), categories: totals };
  });

  // Income vs Expense per month (bar chart).
  app.get('/reports/income-expense', async (req) => {
    const q = req.query as { from?: string; to?: string };
    const budget = await getBudgetOrThrow();
    const { comp, months } = await loadComputation(budget.id);
    const from = q.from ?? budget.firstMonth;
    const to = q.to ?? budget.lastMonth;
    return months
      .filter((m) => m >= from && m <= to)
      .map((m) => ({
        month: m,
        income: comp.incomeByMonth[m] ?? 0,
        expense: -(comp.activityByMonth[m] ?? 0), // activity is negative; expense is positive
      }));
  });

  // Net worth per month: assets (positive balances) vs debts (negative).
  // Running balances always start at the first month; the range only trims the series.
  app.get('/reports/net-worth', async (req) => {
    const q = req.query as { from?: string; to?: string };
    const budget = await getBudgetOrThrow();
    const { txns, accounts, months } = await loadComputation(budget.id);
    const cutoff = today();
    const from = q.from ?? budget.firstMonth;
    const to = q.to ?? budget.lastMonth;

    const delta: Record<string, Record<string, number>> = {};
    for (const t of txns) {
      if (t.date > cutoff) continue;
      const m = monthOf(t.date);
      (delta[t.accountId] ??= {})[m] = (delta[t.accountId]?.[m] ?? 0) + t.amount;
    }

    const running: Record<string, number> = {};
    for (const a of accounts) running[a.id] = 0;
    return months
      .filter((m) => m >= from && m <= to)
      .map((m) => {
        let assets = 0;
        let debts = 0;
        for (const a of accounts) {
          running[a.id] += delta[a.id]?.[m] ?? 0;
          if (running[a.id] >= 0) assets += running[a.id];
          else debts += running[a.id];
        }
        return { month: m, assets, debts, netWorth: assets + debts };
      });
  });

  // Anomalies: outflows that deviate sharply from the same payee's own history
  // (spikes and unusual drops). Posting-aware: split subtransactions are
  // separate samples under their own category; transfers excluded.
  app.get('/reports/anomalies', async (req) => {
    const q = req.query as { days?: string };
    const days = Math.max(1, Math.min(365, Number(q.days) || 90));
    const budget = await getBudgetOrThrow();
    const { txns, accounts, categories } = await loadComputation(budget.id);
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

    const [payees] = await Promise.all([
      prisma.payee.findMany({ where: { budgetId: budget.id }, select: { id: true, name: true } }),
    ]);
    const payeeName = new Map(payees.map((p) => [p.id, p.name]));
    const catMeta = new Map(categories.map((c) => [c.id, c]));
    const onBudget = new Map(accounts.map((a) => [a.id, a.onBudget]));

    const samples: AnomalyInputTxn[] = [];
    for (const t of txns) {
      if (t.date > today() || !onBudget.get(t.accountId)) continue;
      if (t.transferAccountId) continue;
      const payee = t.payeeId ? (payeeName.get(t.payeeId) ?? '') : '';
      const subs = t.subtransactions ?? [];
      if (subs.length > 0) {
        for (const s of subs) {
          const c = s.categoryId ? catMeta.get(s.categoryId) : null;
          if (!c || c.isInflow) continue;
          samples.push({
            id: s.id ?? t.id,
            date: t.date,
            amount: s.amount,
            payeeId: t.payeeId ?? null,
            payeeName: payee,
            categoryId: c.id,
            categoryName: c.name,
          });
        }
      } else {
        const c = t.categoryId ? catMeta.get(t.categoryId) : null;
        if (!c || c.isInflow) continue;
        samples.push({
          id: t.id,
          date: t.date,
          amount: t.amount,
          payeeId: t.payeeId ?? null,
          payeeName: payee,
          categoryId: c.id,
          categoryName: c.name,
        });
      }
    }

    const anomalies = detectAnomalies(samples, { recentFrom: cutoff });
    return { days, count: anomalies.length, anomalies };
  });

  // Age of Money trend (computed at each month-end).
  app.get('/reports/age-of-money', async (req) => {
    const q = req.query as { from?: string; to?: string };
    const budget = await getBudgetOrThrow();
    const { txns, accounts, months } = await loadComputation(budget.id);
    const from = q.from ?? budget.firstMonth;
    const to = q.to ?? budget.lastMonth;
    const eng = accounts.map((a) => ({ id: a.id, onBudget: a.onBudget, type: a.type }));
    return months
      .filter((m) => m <= today() && m >= from && m <= to)
      .map((m) => {
        // month-end ≈ first of next month minus a day; use next month start as exclusive bound.
        const [y, mm] = m.split('-').map(Number);
        const end = new Date(Date.UTC(y, mm, 0)).toISOString().slice(0, 10);
        return { month: m, age: computeAgeOfMoney(txns, eng, end) };
      });
  });

  // Cash-flow projection: known schedules + trailing averages → per-future-month
  // income/spending/net and a projected Ready-to-Assign chain.
  app.get('/reports/cashflow', async (req, reply) => {
    const q = req.query as { months?: string };
    const months = Number(q.months) || 6;
    if (!Number.isInteger(months) || months < 1 || months > 36) {
      return reply.code(400).send({ error: 'months must be an integer between 1 and 36.' });
    }
    const budget = await getBudgetOrThrow();
    await materializeDue(budget.id); // schedules due today must land in history first
    return runProjection(budget.id, months);
  });

  // Net-worth forecast: the actual net-worth series extended with the cash-flow
  // projection's expected net — "at this pace you reach X by month M".
  app.get('/reports/networth-forecast', async (req, reply) => {
    const q = req.query as { months?: string };
    const months = Math.max(1, Math.min(36, Number(q.months) || 12));
    const budget = await getBudgetOrThrow();
    await materializeDue(budget.id);
    const { txns, accounts, months: allMonths } = await loadComputation(budget.id);
    const cutoff = today();

    // actual net worth series (same math as /reports/net-worth, untrimmed)
    const delta: Record<string, Record<string, number>> = {};
    for (const t of txns) {
      if (t.date > cutoff) continue;
      const m = monthOf(t.date);
      (delta[t.accountId] ??= {})[m] = (delta[t.accountId]?.[m] ?? 0) + t.amount;
    }
    const running: Record<string, number> = {};
    for (const a of accounts) running[a.id] = 0;
    const history = allMonths.map((m) => {
      let net = 0;
      for (const a of accounts) {
        running[a.id] += delta[a.id]?.[m] ?? 0;
        net += running[a.id];
      }
      return { month: m, netWorth: net };
    });

    const projection = await runProjection(budget.id, months);
    let cum = history[history.length - 1]?.netWorth ?? 0;
    const forecast = projection.rows.map((r) => {
      cum += r.projectedNet;
      return { month: r.month, projected: Math.round(cum), partial: r.partial };
    });

    return {
      history,
      forecast,
      lastNetWorth: history[history.length - 1]?.netWorth ?? 0,
      horizonMonths: months,
      sufficient: projection.sufficient,
    };
  });
}

// Shared input assembly for the cash-flow projection (used by /reports/cashflow
// and /reports/networth-forecast).
async function runProjection(budgetId: string, months: number) {
  const { txns, accounts, categories, comp } = await loadComputation(budgetId);
  const todayStr = today();
  const inflowCatId = categories.find((c) => c.isInflow)?.id ?? null;
  const paymentCatIds = new Set(categories.filter((c) => c.paymentAccountId).map((c) => c.id));
  const payees = await prisma.payee.findMany({ where: { budgetId }, select: { id: true, name: true } });
  const systemPayeeIds = new Set(
    payees
      .filter((p) => ['Starting Balance', 'Manual Balance Adjustment', 'Reconciliation Balance Adjustment'].includes(p.name))
      .map((p) => p.id),
  );
  const scheduled = await prisma.scheduledTransaction.findMany({
    where: { budgetId, deleted: false },
    include: { payee: true },
  });
  const overrides = await prisma.projectedOverride.findMany({ where: { budgetId } });
  const targetCats: TargetInput[] = categories
    .filter((c) => c.goalType)
    .map((c) => ({
      goalType: c.goalType as TargetInput['goalType'],
      goalTarget: c.goalTarget,
      goalCadence: c.goalCadence,
      goalDay: c.goalDay,
      goalTargetMonth: c.goalTargetMonth,
      goalNeedsWholeAmount: c.goalNeedsWholeAmount,
    }));
  return projectCashflow({
    comp,
    currentMonth: monthOf(todayStr),
    horizonMonths: months,
    today: todayStr,
    accounts,
    txns,
    inflowCatId,
    paymentCatIds,
    systemPayeeIds,
    targetCats,
    scheduled: scheduled.map((s) => ({
      id: s.id,
      accountId: s.accountId,
      payeeId: s.payeeId,
      payee: s.payee?.name ?? null,
      categoryId: s.categoryId,
      amount: s.amount,
      frequency: s.frequency,
      nextDate: s.nextDate,
      anchorDay: s.anchorDay,
      endMonth: s.endMonth,
      transferAccountId: s.transferAccountId,
    })),
    overrides: overrides.map((o) => ({ categoryId: o.categoryId, month: o.month, amount: o.amount })),
  });
}
