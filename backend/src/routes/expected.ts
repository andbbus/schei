// Known future transactions: scheduled occurrences + future-dated ("upcoming")
// real transactions, bucketed by month. Backs the Budget screen's expected-income
// strip and future-month preview. Read-only; does not materialize anything.

import { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { getBudgetOrThrow, today } from '../engineLoad';
import { addMonths, listMonths, monthOf } from '../engine/budget';
import { nextOccurrence, occurrencesInRange } from '../engine/schedule';

export interface ExpectedItem {
  date: string;
  payee: string;
  category: string | null;
  categoryId: string | null;
  amount: number; // signed milliunits, positive = inflow
  source: 'scheduled' | 'upcoming';
  frequency: string | null;
}
export interface ExpectedMonth {
  month: string;
  items: ExpectedItem[];
  net: number;
}

export default function expectedRoutes(app: FastifyInstance) {
  app.get('/expected', async (req, reply) => {
    const q = req.query as { months?: string };
    const months = Number(q.months) || 6;
    if (!Number.isInteger(months) || months < 1 || months > 36) {
      return reply.code(400).send({ error: 'months must be an integer between 1 and 36.' });
    }
    const budget = await getBudgetOrThrow();
    const now = today();
    const currentMonth = monthOf(now);
    const horizonEnd = addMonths(currentMonth, months);
    const window = new Set(listMonths(currentMonth, horizonEnd));

    const [accounts, scheduled, categories, upcoming] = await Promise.all([
      prisma.account.findMany({ where: { budgetId: budget.id }, select: { id: true, onBudget: true } }),
      prisma.scheduledTransaction.findMany({
        where: { budgetId: budget.id, deleted: false },
        include: { payee: true },
      }),
      prisma.category.findMany({ where: { budgetId: budget.id }, select: { id: true, name: true, isInflow: true } }),
      prisma.transaction.findMany({
        where: { budgetId: budget.id, deleted: false, date: { gt: now } },
        include: { payee: true, category: true },
      }),
    ]);

    const onBudget = new Map(accounts.map((a) => [a.id, a.onBudget]));
    const catName = new Map(categories.map((c) => [c.id, c.isInflow ? 'Ready to Assign' : c.name]));

    const byMonth = new Map<string, ExpectedItem[]>();
    const bucket = (date: string, item: ExpectedItem, endMonth?: string | null) => {
      const m = monthOf(date);
      if (!window.has(m)) return;
      if (endMonth && m > endMonth) return; // subscription ended
      const arr = byMonth.get(m) ?? [];
      arr.push(item);
      byMonth.set(m, arr);
    };

    // Scheduled occurrences (its own nextDate first, then the recurrence walk).
    for (const s of scheduled) {
      if (s.transferAccountId && onBudget.get(s.transferAccountId)) continue; // internal transfer
      const payee = s.payee?.name ?? '';
      const categoryId = s.categoryId;
      const category = categoryId ? (catName.get(categoryId) ?? null) : null;
      if (s.nextDate > now) {
        bucket(s.nextDate, { date: s.nextDate, payee, category, categoryId, amount: s.amount, source: 'scheduled', frequency: s.frequency }, s.endMonth);
      }
      let cursor = s.nextDate > now ? s.nextDate : now;
      for (let i = 0; i < 120; i++) {
        const n = nextOccurrence(s.frequency, cursor, s.anchorDay ?? undefined);
        if (!n) break;
        cursor = n;
        if (monthOf(n) > horizonEnd) break;
        if (s.endMonth && monthOf(n) > s.endMonth) break;
        bucket(n, { date: n, payee, category, categoryId, amount: s.amount, source: 'scheduled', frequency: s.frequency }, s.endMonth);
      }
    }

    // Future-dated real transactions.
    for (const t of upcoming) {
      if (t.transferAccountId && onBudget.get(t.transferAccountId)) continue; // internal transfer
      bucket(t.date, {
        date: t.date,
        payee: t.payee?.name ?? '',
        category: t.categoryId ? (catName.get(t.categoryId) ?? null) : null,
        categoryId: t.categoryId,
        amount: t.amount,
        source: 'upcoming',
        frequency: null,
      });
    }

    const monthsOut: ExpectedMonth[] = listMonths(currentMonth, horizonEnd).map((m) => {
      const items = (byMonth.get(m) ?? []).sort((a, b) => (a.date < b.date ? -1 : 1));
      return { month: m, items, net: items.reduce((s, x) => s + x.amount, 0) };
    });

    return { months: monthsOut };
  });

  // Calendar: everything happening on specific days of one month — scheduled
  // occurrences (expanded) + real transactions (including future-dated
  // "upcoming" ones, which is the point of looking at a future month).
  app.get('/calendar', async (req, reply) => {
    const q = req.query as { month?: string };
    const month = (q.month ?? monthOf(today())).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return reply.code(400).send({ error: 'month must be YYYY-MM.' });
    }
    const [y, m] = month.split('-').map(Number);
    const from = `${month}-01`;
    const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);

    const budget = await getBudgetOrThrow();
    const [accounts, scheduled, categories, txns] = await Promise.all([
      prisma.account.findMany({ where: { budgetId: budget.id }, select: { id: true, onBudget: true, name: true } }),
      prisma.scheduledTransaction.findMany({
        where: { budgetId: budget.id, deleted: false },
        include: { payee: true },
      }),
      prisma.category.findMany({ where: { budgetId: budget.id } }),
      prisma.transaction.findMany({
        where: { budgetId: budget.id, deleted: false, date: { gte: from, lte: to } },
        include: { payee: true, account: true, category: true },
      }),
    ]);
    const catName = new Map(categories.map((c) => [c.id, c.isInflow ? 'Ready to Assign' : c.name]));
    const acctName = new Map(accounts.map((a) => [a.id, a.name]));

    type CalItem = {
      id: string;
      date: string;
      payee: string;
      amount: number;
      category: string | null;
      account: string | null;
      source: 'scheduled' | 'txn';
      frequency: string | null;
      scheduledId: string | null;
    };
    const items: CalItem[] = [];

    for (const s of scheduled) {
      if (s.transferAccountId && accounts.find((a) => a.id === s.transferAccountId)?.onBudget) continue;
      for (const date of occurrencesInRange(s.frequency, s.nextDate, from, to, s.anchorDay ?? undefined, s.endMonth)) {
        items.push({
          id: `${s.id}:${date}`,
          date,
          payee: s.payee?.name ?? '?',
          amount: s.amount,
          category: s.categoryId ? (catName.get(s.categoryId) ?? null) : null,
          account: acctName.get(s.accountId) ?? null,
          source: 'scheduled',
          frequency: s.frequency,
          scheduledId: s.id,
        });
      }
    }

    for (const t of txns) {
      items.push({
        id: t.id,
        date: t.date,
        payee: t.payee?.name ?? '?',
        amount: t.amount,
        category: t.categoryId ? (catName.get(t.categoryId) ?? null) : null,
        account: t.account?.name ?? null,
        source: 'txn',
        frequency: null,
        scheduledId: null,
      });
    }

    items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.payee.localeCompare(b.payee)));
    return { month: from, items };
  });
}