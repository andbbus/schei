import { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { getBudgetOrThrow, today } from '../engineLoad';
import { nextOccurrence } from '../engine/schedule';

// Find-or-create a normal payee by name.
async function resolvePayee(budgetId: string, name?: string | null): Promise<string | null> {
  const n = (name ?? '').trim();
  if (!n) return null;
  const found = await prisma.payee.findFirst({ where: { budgetId, name: n, transferAccountId: null } });
  if (found) return found.id;
  const made = await prisma.payee.create({ data: { budgetId, name: n } });
  return made.id;
}

// The "Transfer : <account>" payee that represents transfers TO an account.
async function transferPayee(budgetId: string, accountId: string): Promise<string> {
  const existing = await prisma.payee.findFirst({ where: { transferAccountId: accountId } });
  if (existing) return existing.id;
  const acct = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const made = await prisma.payee.create({
    data: { budgetId, name: `Transfer : ${acct.name}`, transferAccountId: accountId },
  });
  return made.id;
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
}

function signedAmount(b: TxnBody): number {
  if (typeof b.amount === 'number') return Math.round(b.amount);
  return Math.round((b.inflow ?? 0) - (b.outflow ?? 0));
}

// Create a transaction (or a mirrored transfer pair). Shared by the POST route
// and scheduled-transaction materialization.
async function createTransaction(budgetId: string, b: TxnBody) {
  const amount = signedAmount(b);

  if (b.transferAccountId) {
    // Two linked legs, mirrored amounts. Category null between on-budget
    // accounts; a transfer to a tracking account leaves the budget, so the
    // on-budget leg takes a category like normal spending.
    const target = await prisma.account.findUniqueOrThrow({ where: { id: b.transferAccountId } });
    const here = await prisma.transaction.create({
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
        payeeId: await transferPayee(budgetId, b.transferAccountId),
      },
    });
    const there = await prisma.transaction.create({
      data: {
        budgetId,
        accountId: b.transferAccountId,
        date: b.date,
        amount: -amount,
        memo: b.memo ?? null,
        cleared: 'uncleared',
        transferAccountId: b.accountId,
        transferTransactionId: here.id,
        payeeId: await transferPayee(budgetId, b.accountId),
      },
    });
    await prisma.transaction.update({ where: { id: here.id }, data: { transferTransactionId: there.id } });
    return here;
  }

  return prisma.transaction.create({
    data: {
      budgetId,
      accountId: b.accountId,
      date: b.date,
      amount,
      memo: b.memo ?? null,
      cleared: b.cleared ?? 'uncleared',
      flagColor: b.flagColor ?? null,
      categoryId: b.categoryId ?? null,
      payeeId: b.payeeId ?? (await resolvePayee(budgetId, b.payeeName)),
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
      date = nextOccurrence(s.frequency, date);
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

  app.get('/categories', async () => {
    const budget = await getBudgetOrThrow();
    const groups = await prisma.categoryGroup.findMany({
      where: { budgetId: budget.id, deleted: false },
      orderBy: { sortOrder: 'asc' },
      include: { categories: { where: { deleted: false }, orderBy: { sortOrder: 'asc' } } },
    });
    return groups;
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
      .map((t) => ({
        id: t.id,
        date: t.date,
        payee: t.payeeId ? payeeName.get(t.payeeId) ?? '' : '',
        payeeId: t.payeeId,
        category: t.subtransactions.length ? 'Split' : t.categoryId ? catName.get(t.categoryId) ?? '' : '',
        categoryId: t.categoryId,
        memo: t.memo ?? '',
        amount: t.amount,
        cleared: t.cleared,
        flagColor: t.flagColor,
        transferAccountId: t.transferAccountId,
        runningBalance: running.get(t.id) ?? 0,
        upcoming: t.date > today(),
        scheduledId: null as string | null,
        frequency: null as string | null,
      }));

    // Scheduled ghost rows: the next occurrence of each schedule, shown as
    // upcoming. Not real transactions — the engine never sees them.
    const ghosts = scheduled.map((s) => ({
      id: 'sched:' + s.id,
      date: s.nextDate,
      payee: s.payeeId ? payeeName.get(s.payeeId) ?? '' : '',
      payeeId: s.payeeId,
      category: s.categoryId ? catName.get(s.categoryId) ?? '' : '',
      categoryId: s.categoryId,
      memo: s.memo ?? '',
      amount: s.amount,
      cleared: 'uncleared',
      flagColor: s.flagColor,
      transferAccountId: s.transferAccountId,
      runningBalance: 0,
      upcoming: true,
      scheduledId: s.id,
      frequency: s.frequency,
    }));

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

  app.post('/transactions', async (req) => {
    const b = req.body as TxnBody;
    const budget = await getBudgetOrThrow();
    return createTransaction(budget.id, b);
  });

  // Scheduled transactions: CRUD. Materialization happens on GET /budget.
  app.post('/scheduled', async (req) => {
    const b = req.body as TxnBody & { frequency: string; nextDate: string };
    const budget = await getBudgetOrThrow();
    return prisma.scheduledTransaction.create({
      data: {
        budgetId: budget.id,
        accountId: b.accountId,
        amount: signedAmount(b),
        memo: b.memo ?? null,
        flagColor: b.flagColor ?? null,
        categoryId: b.categoryId ?? null,
        transferAccountId: b.transferAccountId ?? null,
        payeeId: b.payeeId ?? (await resolvePayee(budget.id, b.payeeName)),
        frequency: b.frequency,
        nextDate: b.nextDate,
      },
    });
  });

  app.patch('/scheduled/:id', async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as Partial<TxnBody & { frequency: string; nextDate: string }>;
    const budget = await getBudgetOrThrow();
    const data: Record<string, unknown> = {};
    if (b.memo !== undefined) data.memo = b.memo;
    if (b.flagColor !== undefined) data.flagColor = b.flagColor;
    if (b.categoryId !== undefined) data.categoryId = b.categoryId;
    if (b.frequency !== undefined) data.frequency = b.frequency;
    if (b.nextDate !== undefined) data.nextDate = b.nextDate;
    if (b.date !== undefined) data.nextDate = b.date;
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

  app.patch('/transactions/:id', async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as Partial<TxnBody>;
    const budget = await getBudgetOrThrow();
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
    const updated = await prisma.transaction.update({ where: { id }, data });
    // Keep a transfer's paired leg in sync (mirror amount + date).
    if (updated.transferTransactionId && (data.amount !== undefined || data.date !== undefined)) {
      await prisma.transaction.update({
        where: { id: updated.transferTransactionId },
        data: { amount: -updated.amount, date: updated.date },
      });
    }
    return updated;
  });

  app.delete('/transactions/:id', async (req) => {
    const { id } = req.params as { id: string };
    const t = await prisma.transaction.update({ where: { id }, data: { deleted: true } });
    if (t.transferTransactionId) {
      await prisma.transaction.update({ where: { id: t.transferTransactionId }, data: { deleted: true } });
    }
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

    await prisma.transaction.updateMany({
      where: { accountId: id, deleted: false, cleared: 'cleared' },
      data: { cleared: 'reconciled' },
    });

    const diff = Math.round(balance) - clearedBalance;
    if (diff !== 0) {
      const isCash = account.onBudget && account.type !== 'creditCard' && account.type !== 'lineOfCredit';
      const inflowCat = isCash
        ? await prisma.category.findFirst({ where: { budgetId: budget.id, isInflow: true } })
        : null;
      await prisma.transaction.create({
        data: {
          budgetId: budget.id,
          accountId: id,
          date: today(),
          amount: diff,
          cleared: 'reconciled',
          payeeId: await resolvePayee(budget.id, 'Reconciliation Balance Adjustment'),
          categoryId: inflowCat?.id ?? null,
          memo: 'Entered automatically by reconciliation',
        },
      });
    }
    return { adjusted: diff };
  });
}
