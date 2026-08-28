import { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { getBudgetOrThrow, loadComputation, clampMonth, today } from '../engineLoad';
import { computeTarget, GoalType } from '../engine/targets';
import { autoAssignAmount, AutoAssignMode, CatMonth, planUnderfunded } from '../engine/autoAssign';
import { materializeDue } from './register';
import { logOps } from './ops-helpers';

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

// Shared by the POST /months/:month/quick-budget route and the assistant's
// cover_overspending tool. Applies one auto-assign mode to every visible
// category in the month and logs a single autoAssign op.
export async function runQuickBudget(budgetId: string, month: string, mode: AutoAssignMode, capRta: boolean) {
  const { comp, categories } = await loadComputation(budgetId);

  const visible = categories.filter((c) => !c.hidden && !c.isInflow);
  const hist = new Map<string, Record<string, CatMonth>>();
  for (const mc of comp.monthCategories) {
    const h = hist.get(mc.categoryId) ?? {};
    h[mc.month] = { assigned: mc.assigned, activity: mc.activity, available: mc.available };
    hist.set(mc.categoryId, h);
  }

  const underfunded = new Map<string, number>();
  for (const c of visible) {
    const cur = hist.get(c.id)?.[month] ?? { assigned: 0, activity: 0, available: 0 };
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
    underfunded.set(c.id, target.underfunded);
  }

  // Planned absolute next value per category.
  const planned = new Map<string, number>();
  if (mode === 'underfunded' && capRta) {
    const rta = comp.rtaByMonth[month] ?? 0;
    const plan = planUnderfunded(
      [...underfunded.entries()].map(([categoryId, u]) => ({ categoryId, underfunded: u })),
      rta,
    );
    for (const { categoryId, add } of plan) {
      const cur = hist.get(categoryId)?.[month]?.assigned ?? 0;
      planned.set(categoryId, cur + add);
    }
  } else {
    for (const c of visible) {
      const h = hist.get(c.id) ?? {};
      planned.set(c.id, Math.round(autoAssignAmount(mode, month, h, underfunded.get(c.id) ?? 0)));
    }
  }

  const changed: { categoryId: string; month: string; prev: number; next: number }[] = [];
  await prisma.$transaction(async (tx) => {
    for (const [categoryId, next] of planned) {
      const existing = await tx.monthCategory.findUnique({ where: { categoryId_month: { categoryId, month } } });
      const prev = existing?.assigned ?? 0;
      if (prev !== next) {
        await tx.monthCategory.upsert({
          where: { categoryId_month: { categoryId, month } },
          update: { assigned: next },
          create: { budgetId, categoryId, month, assigned: next },
        });
        changed.push({ categoryId, month, prev, next });
      }
    }
    if (changed.length > 0) await logOps(tx, budgetId, 'autoAssign', changed);
  });

  return {
    mode,
    capRta,
    changed: changed.length,
    totalDelta: changed.reduce((s, c) => s + (c.next - c.prev), 0),
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
    const next = Math.round(assigned);
    await prisma.$transaction(async (tx) => {
      const existing = await tx.monthCategory.findUnique({ where: { categoryId_month: { categoryId, month } } });
      const prev = existing?.assigned ?? 0;
      if (prev !== next) {
        await tx.monthCategory.upsert({
          where: { categoryId_month: { categoryId, month } },
          update: { assigned: next },
          create: { budgetId: budget.id, categoryId, month, assigned: next },
        });
        await logOps(tx, budget.id, 'assign', [{ categoryId, month, prev, next }]);
      }
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

    const changed: { categoryId: string; month: string; prev: number; next: number }[] = [];
    await prisma.$transaction(async (tx) => {
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
        const next = Math.round(autoAssignAmount(mode, month, h, target.underfunded));
        const existing = await tx.monthCategory.findUnique({ where: { categoryId_month: { categoryId, month } } });
        const prev = existing?.assigned ?? 0;
        if (prev !== next) {
          await tx.monthCategory.upsert({
            where: { categoryId_month: { categoryId, month } },
            update: { assigned: next },
            create: { budgetId: budget.id, categoryId, month, assigned: next },
          });
          changed.push({ categoryId, month, prev, next });
        }
      }
      if (changed.length > 0) await logOps(tx, budget.id, 'autoAssign', changed);
    });
    return monthPayload(budget.id, month);
  });

  // Quick budget: apply one auto-assign mode to EVERY visible category in the
  // month (the toolbar "Auto-assign" dropdown). With capRta (underfunded mode
  // only) the plan is clamped to Ready-to-Assign, largest shortfall first.
  app.post('/months/:month/quick-budget', async (req) => {
    const { month } = req.params as { month: string };
    const { mode, capRta } = req.body as { mode: AutoAssignMode; capRta?: boolean };
    const budget = await getBudgetOrThrow();
    const result = await runQuickBudget(budget.id, month, mode, !!capRta);
    const payload = await monthPayload(budget.id, month);
    return { ...payload, summary: result };
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
    await prisma.$transaction(async (tx) => {
      const adjust = async (categoryId: string, delta: number) => {
        const existing = await tx.monthCategory.findUnique({
          where: { categoryId_month: { categoryId, month } },
        });
        const base = existing?.assigned ?? 0;
        await tx.monthCategory.upsert({
          where: { categoryId_month: { categoryId, month } },
          update: { assigned: base + delta },
          create: { budgetId: budget.id, categoryId, month, assigned: base + delta },
        });
      };
      // Moving FROM "Ready to Assign" (id null/sentinel) just assigns to the target.
      if (fromCategoryId && fromCategoryId !== 'rta') await adjust(fromCategoryId, -amt);
      if (toCategoryId && toCategoryId !== 'rta') await adjust(toCategoryId, amt);
      if (amt !== 0) {
        await logOps(tx, budget.id, 'move', { month, fromCategoryId, toCategoryId, amount: amt });
      }
    });
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
    if (body.hidden !== undefined) {
      const budget = await getBudgetOrThrow();
      await prisma.$transaction(async (tx) => {
        const existing = await tx.category.findUniqueOrThrow({ where: { id } });
        await tx.category.update({ where: { id }, data });
        await logOps(tx, budget.id, 'hideCategory', { categoryId: id, prevHidden: existing.hidden });
      });
      return prisma.category.findUniqueOrThrow({ where: { id } });
    }
    return prisma.category.update({ where: { id }, data });
  });

  app.patch('/category-groups/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    for (const k of ['name', 'hidden']) if (k in body) data[k] = body[k];
    return prisma.categoryGroup.update({ where: { id }, data });
  });

  // Delete = soft delete, refused while the category still holds data (the app
  // forces reassignment; we just say "hide it instead").
  app.delete('/categories/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const budget = await getBudgetOrThrow();
    const [txns, subs, assigned, rules] = await Promise.all([
      prisma.transaction.count({ where: { categoryId: id, deleted: false } }),
      prisma.subtransaction.count({ where: { categoryId: id, transaction: { deleted: false } } }),
      prisma.monthCategory.count({ where: { categoryId: id, assigned: { not: 0 } } }),
      prisma.payeeRule.count({ where: { categoryId: id } }),
    ]);
    if (rules > 0) {
      return reply.code(409).send({ error: `Category is used by ${rules} payee rule(s) — delete or retarget the rules first.` });
    }
    if (txns + subs + assigned > 0) {
      return reply.code(409).send({ error: 'Category has transactions or assigned money — hide it instead.' });
    }
    await prisma.$transaction(async (tx) => {
      await tx.category.update({ where: { id }, data: { deleted: true } });
      await logOps(tx, budget.id, 'deleteCategory', { id });
    });
    return { ok: true };
  });

  app.delete('/category-groups/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const budget = await getBudgetOrThrow();
    const live = await prisma.category.count({ where: { groupId: id, deleted: false } });
    if (live > 0) return reply.code(409).send({ error: 'Group still has categories — delete or move them first.' });
    await prisma.$transaction(async (tx) => {
      await tx.categoryGroup.update({ where: { id }, data: { deleted: true } });
      await logOps(tx, budget.id, 'deleteGroup', { id });
    });
    return { ok: true };
  });
}
