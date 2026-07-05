import { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { getBudgetOrThrow, loadComputation, clampMonth, today } from '../engineLoad';
import { computeTarget, GoalType } from '../engine/targets';
import { autoAssignAmount, AutoAssignMode, CatMonth } from '../engine/autoAssign';
import { materializeDue } from './register';

// Build the full month view: groups → categories with assigned/activity/available
// + per-category target state, plus Ready-to-Assign for the month.
async function monthPayload(budgetId: string, month: string) {
  const { budget, categories, comp } = await loadComputation(budgetId);

  const cell = new Map<
    string,
    { assigned: number; activity: number; available: number; overspendType?: 'cash' | 'credit' | 'mixed' }
  >();
  for (const mc of comp.monthCategories) {
    if (mc.month === month) cell.set(mc.categoryId, mc);
  }

  const groups = await prisma.categoryGroup.findMany({
    where: { budgetId, deleted: false },
    orderBy: { sortOrder: 'asc' },
  });

  const byGroup = new Map<string, typeof categories>();
  for (const c of categories) {
    if (c.isInflow) continue; // inflow isn't shown as a budget row
    const arr = byGroup.get(c.groupId) ?? [];
    arr.push(c);
    byGroup.set(c.groupId, arr);
  }

  const groupPayloads = groups.map((g) => {
    const cats = (byGroup.get(g.id) ?? []).map((c) => {
      const v = cell.get(c.id) ?? { assigned: 0, activity: 0, available: 0 };
      const target = computeTarget(
        {
          goalType: (c.goalType as GoalType) ?? null,
          goalTarget: c.goalTarget ?? null,
          goalCadence: c.goalCadence ?? null,
          goalDay: c.goalDay ?? null,
          goalTargetMonth: c.goalTargetMonth ?? null,
          goalNeedsWholeAmount: c.goalNeedsWholeAmount ?? null,
        },
        { month, assignedThisMonth: v.assigned, available: v.available },
      );
      return {
        id: c.id,
        name: c.name,
        note: c.note,
        hidden: c.hidden,
        paymentAccountId: c.paymentAccountId,
        overspendType: v.overspendType ?? null,
        goalType: c.goalType,
        goalTarget: c.goalTarget,
        goalCadence: c.goalCadence,
        goalDay: c.goalDay,
        goalTargetMonth: c.goalTargetMonth,
        goalNeedsWholeAmount: c.goalNeedsWholeAmount,
        assigned: v.assigned,
        activity: v.activity,
        available: v.available,
        target,
      };
    });
    const sum = (k: 'assigned' | 'activity' | 'available') => cats.reduce((s, c) => s + c[k], 0);
    return {
      id: g.id,
      name: g.name,
      isSystem: g.isSystem,
      hidden: g.hidden,
      assigned: sum('assigned'),
      activity: sum('activity'),
      available: sum('available'),
      categories: cats,
    };
  });

  return {
    month,
    readyToAssign: comp.rtaByMonth[month] ?? 0,
    income: comp.incomeByMonth[month] ?? 0,
    totalAssigned: comp.assignedByMonth[month] ?? 0,
    totalActivity: comp.activityByMonth[month] ?? 0,
    currency: { symbol: budget.currencySymbol, digits: budget.decimalDigits, locale: budget.locale },
    groups: groupPayloads,
  };
}

export default async function budgetRoutes(app: FastifyInstance) {
  // Budget meta + sidebar accounts (with balances) + month range.
  app.get('/budget', async () => {
    const budget = await getBudgetOrThrow();
    await materializeDue(budget.id); // spawn due scheduled txns before computing
    const { accounts, balances, ageOfMoney, months } = await loadComputation(budget.id);
    return {
      budget: {
        id: budget.id,
        name: budget.name,
        currencySymbol: budget.currencySymbol,
        decimalDigits: budget.decimalDigits,
        locale: budget.locale,
        dateFormat: budget.dateFormat,
        firstMonth: budget.firstMonth,
        lastMonth: budget.lastMonth,
      },
      months,
      currentMonth: clampMonth(today(), budget.firstMonth, budget.lastMonth),
      ageOfMoney,
      accounts: accounts.map((a) => {
        const b = balances[a.id] ?? { cleared: 0, uncleared: 0, working: 0, upcoming: 0 };
        return {
          id: a.id,
          name: a.name,
          type: a.type,
          onBudget: a.onBudget,
          closed: a.closed,
          cleared: b.cleared,
          uncleared: b.uncleared,
          working: b.working,
          upcoming: b.upcoming,
        };
      }),
    };
  });

  app.get('/months/:month', async (req) => {
    const { month } = req.params as { month: string };
    const budget = await getBudgetOrThrow();
    return monthPayload(budget.id, month);
  });

  // Set assigned for a category in a month.
  app.patch('/months/:month/categories/:categoryId', async (req) => {
    const { month, categoryId } = req.params as { month: string; categoryId: string };
    const { assigned } = req.body as { assigned: number };
    const budget = await getBudgetOrThrow();
    await prisma.monthCategory.upsert({
      where: { categoryId_month: { categoryId, month } },
      update: { assigned: Math.round(assigned) },
      create: { budgetId: budget.id, categoryId, month, assigned: Math.round(assigned) },
    });
    return monthPayload(budget.id, month);
  });

  // Auto-assign (inspector quick-fund buttons) for one or more categories.
  app.post('/months/:month/auto-assign', async (req) => {
    const { month } = req.params as { month: string };
    const { categoryIds, mode } = req.body as { categoryIds: string[]; mode: AutoAssignMode };
    const budget = await getBudgetOrThrow();
    const { comp, categories } = await loadComputation(budget.id);

    // history per category: month → {assigned, activity, available}
    const hist = new Map<string, Record<string, CatMonth>>();
    for (const mc of comp.monthCategories) {
      const h = hist.get(mc.categoryId) ?? {};
      h[mc.month] = { assigned: mc.assigned, activity: mc.activity, available: mc.available };
      hist.set(mc.categoryId, h);
    }

    for (const categoryId of categoryIds) {
      const c = categories.find((x) => x.id === categoryId);
      if (!c) continue;
      const h = hist.get(categoryId) ?? {};
      const cur = h[month] ?? { assigned: 0, activity: 0, available: 0 };
      const target = computeTarget(
        {
          goalType: (c.goalType as GoalType) ?? null,
          goalTarget: c.goalTarget ?? null,
          goalCadence: c.goalCadence ?? null,
          goalDay: c.goalDay ?? null,
          goalTargetMonth: c.goalTargetMonth ?? null,
          goalNeedsWholeAmount: c.goalNeedsWholeAmount ?? null,
        },
        { month, assignedThisMonth: cur.assigned, available: cur.available },
      );
      const next = autoAssignAmount(mode, month, h, target.underfunded);
      await prisma.monthCategory.upsert({
        where: { categoryId_month: { categoryId, month } },
        update: { assigned: Math.round(next) },
        create: { budgetId: budget.id, categoryId, month, assigned: Math.round(next) },
      });
    }
    return monthPayload(budget.id, month);
  });

  // Move available money between two categories in a month (adjusts assigned).
  app.post('/months/:month/move', async (req) => {
    const { month } = req.params as { month: string };
    const { fromCategoryId, toCategoryId, amount } = req.body as {
      fromCategoryId: string;
      toCategoryId: string;
      amount: number;
    };
    const budget = await getBudgetOrThrow();
    const amt = Math.round(amount);
    const adjust = async (categoryId: string, delta: number) => {
      const existing = await prisma.monthCategory.findUnique({
        where: { categoryId_month: { categoryId, month } },
      });
      const base = existing?.assigned ?? 0;
      await prisma.monthCategory.upsert({
        where: { categoryId_month: { categoryId, month } },
        update: { assigned: base + delta },
        create: { budgetId: budget.id, categoryId, month, assigned: base + delta },
      });
    };
    // Moving FROM "Ready to Assign" (id null/sentinel) just assigns to the target.
    if (fromCategoryId && fromCategoryId !== 'rta') await adjust(fromCategoryId, -amt);
    if (toCategoryId && toCategoryId !== 'rta') await adjust(toCategoryId, amt);
    return monthPayload(budget.id, month);
  });

  // Category + group management.
  app.post('/category-groups', async (req) => {
    const { name } = req.body as { name: string };
    const budget = await getBudgetOrThrow();
    const count = await prisma.categoryGroup.count({ where: { budgetId: budget.id } });
    return prisma.categoryGroup.create({ data: { budgetId: budget.id, name, sortOrder: count } });
  });

  app.post('/categories', async (req) => {
    const { groupId, name } = req.body as { groupId: string; name: string };
    const budget = await getBudgetOrThrow();
    const count = await prisma.category.count({ where: { groupId } });
    return prisma.category.create({ data: { budgetId: budget.id, groupId, name, sortOrder: count } });
  });

  app.patch('/categories/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const allowed = [
      'name', 'note', 'hidden', 'groupId', 'sortOrder',
      'goalType', 'goalTarget', 'goalCadence', 'goalDay', 'goalTargetMonth', 'goalNeedsWholeAmount',
    ];
    const data: Record<string, unknown> = {};
    for (const k of allowed) if (k in body) data[k] = body[k];
    return prisma.category.update({ where: { id }, data });
  });

  app.patch('/category-groups/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    for (const k of ['name', 'hidden']) if (k in body) data[k] = body[k];
    return prisma.categoryGroup.update({ where: { id }, data });
  });

  // Delete = soft delete, refused while the category still holds data (YNAB
  // forces reassignment; we just say "hide it instead").
  app.delete('/categories/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [txns, subs, assigned] = await Promise.all([
      prisma.transaction.count({ where: { categoryId: id, deleted: false } }),
      prisma.subtransaction.count({ where: { categoryId: id, transaction: { deleted: false } } }),
      prisma.monthCategory.count({ where: { categoryId: id, assigned: { not: 0 } } }),
    ]);
    if (txns + subs + assigned > 0) {
      return reply.code(409).send({ error: 'Category has transactions or assigned money — hide it instead.' });
    }
    return prisma.category.update({ where: { id }, data: { deleted: true } });
  });

  app.delete('/category-groups/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const live = await prisma.category.count({ where: { groupId: id, deleted: false } });
    if (live > 0) return reply.code(409).send({ error: 'Group still has categories — delete or move them first.' });
    return prisma.categoryGroup.update({ where: { id }, data: { deleted: true } });
  });
}
