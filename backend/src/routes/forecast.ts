// Projected expenses per category for a month: moving average of category activity
// over the trailing N completed months (window = 3 | 6 | 12), optionally overridden
// per (category, month) via ProjectedOverride. Drives the Budget page's forecast panel.

import { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { getBudgetOrThrow, loadComputation, today } from '../engineLoad';
import { monthOf } from '../engine/budget';
import { logOps } from './ops-helpers';

const WINDOWS = [3, 6, 12];
const MONTH_RE = /^\d{4}-\d{2}-01$/;

export default function forecastRoutes(app: FastifyInstance) {
  app.get('/forecast', async (req, reply) => {
    const q = req.query as { month?: string; window?: string };
    const window = Number(q.window) || 6;
    if (!WINDOWS.includes(window)) {
      return reply.code(400).send({ error: 'window must be 3, 6 or 12.' });
    }
    const month = q.month && MONTH_RE.test(q.month) ? q.month : monthOf(today());

    const budget = await getBudgetOrThrow();
    const [{ comp, categories }, overrides] = await Promise.all([
      loadComputation(budget.id),
      prisma.projectedOverride.findMany({ where: { budgetId: budget.id, month } }),
    ]);

    const currentMonth = monthOf(today());
    const completedMonths = [...new Set(comp.monthCategories.map((mc) => mc.month))]
      .filter((m) => m < currentMonth)
      .sort()
      .reverse();
    const windowMonths = new Set(completedMonths.slice(0, window));

    const catName = new Map(categories.map((c) => [c.id, c.isInflow ? 'Ready to Assign' : c.name]));
    const byCat = new Map<string, number[]>();
    for (const mc of comp.monthCategories) {
      if (!windowMonths.has(mc.month)) continue;
      const arr = byCat.get(mc.categoryId) ?? [];
      arr.push(mc.activity);
      byCat.set(mc.categoryId, arr);
    }

    const overrideByCat = new Map(overrides.map((o) => [o.categoryId, o.amount]));

    // effective = override ?? moving average; include override-only categories.
    const avgByCat = new Map(
      [...byCat.entries()].map(([cat, acts]) => [cat, acts.reduce((s, v) => s + v, 0) / acts.length]),
    );
    const effective = new Map<string, number>();
    for (const [cat, avg] of avgByCat) effective.set(cat, overrideByCat.get(cat) ?? avg);
    for (const [cat, amt] of overrideByCat) if (!effective.has(cat)) effective.set(cat, amt);

    const projected = [...effective.entries()]
      .map(([categoryId, amount]) => ({
        categoryId,
        categoryName: catName.get(categoryId) ?? categoryId,
        avg: amount,
        overridden: overrideByCat.has(categoryId),
      }))
      .filter((p) => p.avg < 0) // spending only
      .sort((a, b) => a.avg - b.avg); // biggest spend first
    const projectedTotal = projected.reduce((s, p) => s + -p.avg, 0);

    return {
      window,
      month,
      historyMonths: completedMonths.length,
      projected,
      projectedTotal,
    };
  });

  // Upsert a per-month projected-expense override for a category.
  app.put('/forecast/overrides/:categoryId', async (req, reply) => {
    const { categoryId } = req.params as { categoryId: string };
    const body = req.body as { month?: string; amount?: number };
    if (!body.month || !MONTH_RE.test(body.month)) {
      return reply.code(400).send({ error: 'month must be in YYYY-MM-01 format.' });
    }
    if (!Number.isInteger(body.amount)) {
      return reply.code(400).send({ error: 'amount must be an integer (milliunits).' });
    }
    const budget = await getBudgetOrThrow();
    const cat = await prisma.category.findFirst({ where: { id: categoryId, budgetId: budget.id } });
    if (!cat) return reply.code(404).send({ error: 'Category not found.' });

    await prisma.$transaction(async (tx) => {
      const existing = await tx.projectedOverride.findUnique({
        where: { budgetId_categoryId_month: { budgetId: budget.id, categoryId, month: body.month } },
      });
      await tx.projectedOverride.upsert({
        where: { budgetId_categoryId_month: { budgetId: budget.id, categoryId, month: body.month } },
        create: { budgetId: budget.id, categoryId, month: body.month, amount: body.amount },
        update: { amount: body.amount },
      });
      await logOps(tx, budget.id, 'projectedOverride', {
        categoryId,
        month: body.month,
        prev: existing?.amount ?? null,
        next: body.amount,
      });
    });
    return { ok: true };
  });

  // Remove a per-month override, reverting the category to its moving average.
  app.delete('/forecast/overrides/:categoryId', async (req, reply) => {
    const { categoryId } = req.params as { categoryId: string };
    const q = req.query as { month?: string };
    if (!q.month || !MONTH_RE.test(q.month)) {
      return reply.code(400).send({ error: 'month must be in YYYY-MM-01 format.' });
    }
    const budget = await getBudgetOrThrow();
    await prisma.$transaction(async (tx) => {
      const existing = await tx.projectedOverride.findUnique({
        where: { budgetId_categoryId_month: { budgetId: budget.id, categoryId, month: q.month } },
      });
      await tx.projectedOverride.deleteMany({
        where: { budgetId: budget.id, categoryId, month: q.month },
      });
      if (existing) {
        await logOps(tx, budget.id, 'projectedOverride', {
          categoryId,
          month: q.month,
          prev: existing.amount,
          next: null,
        });
      }
    });
    return { ok: true };
  });
}