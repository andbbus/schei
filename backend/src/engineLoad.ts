// Bridge between the database and the pure engine. Loads everything for a
// budget, runs computeBudget()/accountBalances()/ageOfMoney(), and returns the
// raw records plus the computation. Recomputed per request — cheap at this size.

import { prisma } from './db';
import { computeBudget, accountBalances, listMonths, monthOf } from './engine/budget';
import { computeAgeOfMoney } from './engine/ageOfMoney';
import { EngineTxn } from './engine/types';

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function getBudgetOrThrow() {
  const budget = await prisma.budget.findFirst();
  if (!budget) throw new Error('No budget found — run `npm run seed`.');
  return budget;
}

// Clamp a date to the budget's month range; default display month.
export function clampMonth(date: string, firstMonth: string, lastMonth: string): string {
  const m = monthOf(date);
  if (m < firstMonth) return firstMonth;
  if (m > lastMonth) return lastMonth;
  return m;
}

export async function loadComputation(budgetId: string, asOf = today()) {
  const [budget, accounts, categories, monthCats, txnRows] = await Promise.all([
    prisma.budget.findUniqueOrThrow({ where: { id: budgetId } }),
    prisma.account.findMany({ where: { budgetId }, orderBy: { sortOrder: 'asc' } }),
    prisma.category.findMany({ where: { budgetId }, orderBy: { sortOrder: 'asc' } }),
    prisma.monthCategory.findMany({ where: { budgetId } }),
    prisma.transaction.findMany({
      where: { budgetId, deleted: false },
      include: { subtransactions: true },
    }),
  ]);

  const txns: EngineTxn[] = txnRows.map((t) => ({
    id: t.id,
    date: t.date,
    amount: t.amount,
    accountId: t.accountId,
    categoryId: t.categoryId,
    cleared: t.cleared as EngineTxn['cleared'],
    transferAccountId: t.transferAccountId,
    subtransactions: t.subtransactions.map((s) => ({
      amount: s.amount,
      categoryId: s.categoryId,
      transferAccountId: s.transferAccountId,
    })),
  }));

  const months = listMonths(budget.firstMonth, budget.lastMonth);
  const comp = computeBudget({
    months,
    categories: categories.map((c) => ({ id: c.id, isInflow: c.isInflow, paymentAccountId: c.paymentAccountId })),
    accounts: accounts.map((a) => ({ id: a.id, onBudget: a.onBudget, type: a.type })),
    assigned: monthCats.map((m) => ({ month: m.month, categoryId: m.categoryId, amount: m.assigned })),
    txns,
    asOf,
  });
  const balances = accountBalances(txns, asOf);
  const ageOfMoney = computeAgeOfMoney(
    txns,
    accounts.map((a) => ({ id: a.id, onBudget: a.onBudget, type: a.type })),
    asOf,
  );

  return { budget, accounts, categories, monthCats, txns, months, comp, balances, ageOfMoney, asOf };
}
