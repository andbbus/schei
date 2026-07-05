import { FastifyInstance } from 'fastify';
import { getBudgetOrThrow, loadComputation, today } from '../engineLoad';
import { monthOf } from '../engine/budget';
import { computeAgeOfMoney } from '../engine/ageOfMoney';

export default async function reportRoutes(app: FastifyInstance) {
  // Spending totals by category + group over a month range (donut + breakdown).
  app.get('/reports/spending', async (req) => {
    const q = req.query as { from?: string; to?: string };
    const budget = await getBudgetOrThrow();
    const { txns, categories } = await loadComputation(budget.id);
    const from = q.from ?? budget.firstMonth;
    const to = q.to ?? budget.lastMonth;

    const catMeta = new Map(categories.map((c) => [c.id, c]));
    const byCat = new Map<string, number>();
    for (const t of txns) {
      if (t.date > today()) continue;
      const m = monthOf(t.date);
      if (m < from || m > to) continue;
      if (!t.categoryId) continue;
      const c = catMeta.get(t.categoryId);
      if (!c || c.isInflow) continue;
      if (t.amount >= 0) continue; // spending only
      byCat.set(t.categoryId, (byCat.get(t.categoryId) ?? 0) + -t.amount);
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
  app.get('/reports/income-expense', async () => {
    const budget = await getBudgetOrThrow();
    const { comp, months } = await loadComputation(budget.id);
    return months.map((m) => ({
      month: m,
      income: comp.incomeByMonth[m] ?? 0,
      expense: -(comp.activityByMonth[m] ?? 0), // activity is negative; expense is positive
    }));
  });

  // Net worth per month: assets (positive balances) vs debts (negative).
  app.get('/reports/net-worth', async () => {
    const budget = await getBudgetOrThrow();
    const { txns, accounts, months } = await loadComputation(budget.id);
    const cutoff = today();

    const delta: Record<string, Record<string, number>> = {};
    for (const t of txns) {
      if (t.date > cutoff) continue;
      const m = monthOf(t.date);
      (delta[t.accountId] ??= {})[m] = (delta[t.accountId]?.[m] ?? 0) + t.amount;
    }

    const running: Record<string, number> = {};
    for (const a of accounts) running[a.id] = 0;
    return months.map((m) => {
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

  // Age of Money trend (computed at each month-end).
  app.get('/reports/age-of-money', async () => {
    const budget = await getBudgetOrThrow();
    const { txns, accounts, months } = await loadComputation(budget.id);
    const eng = accounts.map((a) => ({ id: a.id, onBudget: a.onBudget, type: a.type }));
    return months
      .filter((m) => m <= today())
      .map((m) => {
        // month-end ≈ first of next month minus a day; use next month start as exclusive bound.
        const [y, mm] = m.split('-').map(Number);
        const end = new Date(Date.UTC(y, mm, 0)).toISOString().slice(0, 10);
        return { month: m, age: computeAgeOfMoney(txns, eng, end) };
      });
  });
}
