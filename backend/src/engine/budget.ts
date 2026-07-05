// The budgeting engine — replicates YNAB's per-month/per-category math.
//
// Single source of truth = transactions + assigned amounts. Everything else
// (activity, available, Ready-to-Assign) is DERIVED here, on read. No stored
// denormalized balances to drift out of sync.
//
// Overspending comes in two flavours, exactly like YNAB:
//  - CASH overspend: does not carry negative; reduces next month's RTA.
//  - CREDIT overspend (spending on a credit card past the category's funds):
//    carries forward negative and does NOT touch RTA — the debt just stays
//    uncovered on the card.
// Spending on a card that IS funded moves that money into the card's payment
// category (a category with `paymentAccountId` set); transfers into the card
// account are payments and drain the payment category.

import {
  EngineTxn,
  EngineAccount,
  EngineCategory,
  EngineAssigned,
  MonthCategoryResult,
  AccountBalance,
  BudgetComputation,
} from './types';

export function monthOf(date: string): string {
  return date.slice(0, 7) + '-01';
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

// Inclusive list of month keys from `first` to `last`.
export function listMonths(first: string, last: string): string[] {
  const out: string[] = [];
  let cur = monthOf(first);
  const end = monthOf(last);
  // guard against bad input producing an infinite loop
  for (let i = 0; cur <= end && i < 1200; i++) {
    out.push(cur);
    cur = addMonths(cur, 1);
  }
  return out;
}

interface Posting {
  month: string;
  categoryId: string;
  amount: number;
  accountId: string;
}

// Transactions that affect the budget: on-budget accounts only, with a
// category (or split sub-categories). Transfers between on-budget accounts have
// no category and contribute nothing to the budget.
export function collectPostings(
  txns: EngineTxn[],
  accounts: EngineAccount[],
  asOf?: string,
): Posting[] {
  const onBudget = new Map(accounts.map((a) => [a.id, a.onBudget]));
  const cutoff = asOf ?? '9999-12-31';
  const out: Posting[] = [];
  for (const t of txns) {
    if (t.deleted) continue;
    if (!onBudget.get(t.accountId)) continue;
    if (t.date > cutoff) continue; // future-dated (upcoming) — not counted as activity until it occurs
    const month = monthOf(t.date);
    if (t.subtransactions && t.subtransactions.length) {
      for (const s of t.subtransactions) {
        if (s.categoryId) out.push({ month, categoryId: s.categoryId, amount: s.amount, accountId: t.accountId });
      }
    } else if (t.categoryId) {
      out.push({ month, categoryId: t.categoryId, amount: t.amount, accountId: t.accountId });
    }
  }
  return out;
}

export function isCreditAccount(a: EngineAccount): boolean {
  return a.onBudget && (a.type === 'creditCard' || a.type === 'lineOfCredit');
}

// What carries into this month: positive available carries as-is; a negative
// month resets to 0 except for its CREDIT portion, which stays negative.
function carryForward(prevAvailable: number, prevCreditOverspend = 0): number {
  return prevAvailable > 0 ? prevAvailable : -prevCreditOverspend;
}

export function computeBudget(params: {
  months: string[];
  categories: EngineCategory[];
  assigned: EngineAssigned[];
  txns: EngineTxn[];
  accounts: EngineAccount[];
  asOf?: string; // "today" — transactions dated after this are upcoming, not yet activity
}): BudgetComputation {
  const { categories, assigned, txns, accounts } = params;
  const asOf = params.asOf ?? new Date().toISOString().slice(0, 10);
  const months = [...params.months].sort();
  const inflowCat = categories.find((c) => c.isInflow);
  const budgetCats = categories.filter((c) => !c.isInflow && !c.paymentAccountId);
  const paymentCats = categories.filter((c) => !c.isInflow && c.paymentAccountId);

  const cardIds = accounts.filter(isCreditAccount).map((a) => a.id);
  const cardSet = new Set(cardIds);
  const onBudget = new Map(accounts.map((a) => [a.id, a.onBudget]));

  const postings = collectPostings(txns, accounts, asOf);

  // activity[categoryId][month] — total (cash + card), used for income + display
  const activity = new Map<string, Map<string, number>>();
  // cashActivity[categoryId][month] and ccActivity[categoryId][month][cardId]
  const cashActivity = new Map<string, Map<string, number>>();
  const ccActivity = new Map<string, Map<string, Map<string, number>>>();
  const bump = (map: Map<string, Map<string, number>>, cat: string, m: string, v: number) => {
    let row = map.get(cat);
    if (!row) map.set(cat, (row = new Map()));
    row.set(m, (row.get(m) ?? 0) + v);
  };
  for (const p of postings) {
    bump(activity, p.categoryId, p.month, p.amount);
    if (cardSet.has(p.accountId)) {
      let byMonth = ccActivity.get(p.categoryId);
      if (!byMonth) ccActivity.set(p.categoryId, (byMonth = new Map()));
      let byCard = byMonth.get(p.month);
      if (!byCard) byMonth.set(p.month, (byCard = new Map()));
      byCard.set(p.accountId, (byCard.get(p.accountId) ?? 0) + p.amount);
    } else {
      bump(cashActivity, p.categoryId, p.month, p.amount);
    }
  }

  // paymentsIn[cardId][month]: transfers between the card and another on-budget
  // account, seen from the CARD side (positive = payment into the card;
  // negative = cash advance). Card-side leg only — avoids double counting.
  // ponytail: split-subtransaction transfers and card→card transfers ignored.
  const paymentsIn = new Map<string, Map<string, number>>();
  for (const t of txns) {
    if (t.deleted || t.date > asOf) continue;
    if (!cardSet.has(t.accountId)) continue;
    if (!t.transferAccountId || !onBudget.get(t.transferAccountId)) continue;
    if (cardSet.has(t.transferAccountId)) continue;
    bump(paymentsIn, t.accountId, monthOf(t.date), t.amount);
  }

  // coveredIn[cardId][month]: budgeted money moved into the card's payment
  // category by funded card spending (negative for refunds). Filled in pass 1.
  const coveredIn = new Map<string, Map<string, number>>();

  // assigned[categoryId][month]
  const assignedMap = new Map<string, Map<string, number>>();
  for (const a of assigned) {
    let row = assignedMap.get(a.categoryId);
    if (!row) assignedMap.set(a.categoryId, (row = new Map()));
    row.set(a.month, (row.get(a.month) ?? 0) + a.amount);
  }

  const monthCategories: MonthCategoryResult[] = [];
  const cashOverspendByMonth: Record<string, number> = {};
  const creditOverspendByMonth: Record<string, number> = {};
  const assignedByMonth: Record<string, number> = {};
  const activityByMonth: Record<string, number> = {};
  for (const m of months) {
    cashOverspendByMonth[m] = 0;
    creditOverspendByMonth[m] = 0;
    assignedByMonth[m] = 0;
    activityByMonth[m] = 0;
  }

  // Pass 1 — regular categories. Split each month's overspend into cash
  // (dings next month's RTA) and credit (carries forward negative), and record
  // how much funded card spending is "covered" (flows to payment categories).
  for (const cat of budgetCats) {
    let prevAvail = 0;
    let prevCreditOver = 0;
    const aRow = assignedMap.get(cat.id);
    const cashRow = cashActivity.get(cat.id);
    const ccByMonth = ccActivity.get(cat.id);
    for (const m of months) {
      const asg = aRow?.get(m) ?? 0;
      const cashAct = cashRow?.get(m) ?? 0;
      const carriedCredit = prevAvail > 0 ? 0 : prevCreditOver;
      const base = carryForward(prevAvail, prevCreditOver) + asg + cashAct;

      let ccNetTotal = 0;
      let uncovered = 0;
      let remaining = Math.max(0, base);
      const byCard = ccByMonth?.get(m);
      if (byCard) {
        // ponytail: greedy per-card coverage in account order; proportional
        // split only matters for partially-funded multi-card months.
        for (const card of cardIds) {
          const net = byCard.get(card) ?? 0;
          if (!net) continue;
          ccNetTotal += net;
          if (net < 0) {
            const spend = -net;
            const cov = Math.min(spend, remaining);
            remaining -= cov;
            uncovered += spend - cov;
            bump(coveredIn, card, m, cov);
          } else {
            bump(coveredIn, card, m, -net); // refund pulls money back out of the payment category
          }
        }
      }

      const act = cashAct + ccNetTotal;
      const available = base + ccNetTotal;
      let creditOver = 0;
      let cashOver = 0;
      if (available < 0) {
        creditOver = Math.min(-available, uncovered + carriedCredit);
        cashOver = -available - creditOver;
      }
      monthCategories.push({
        month: m,
        categoryId: cat.id,
        assigned: asg,
        activity: act,
        available,
        ...(available < 0
          ? {
              overspendType: (cashOver > 0 && creditOver > 0
                ? 'mixed'
                : creditOver > 0
                  ? 'credit'
                  : 'cash') as MonthCategoryResult['overspendType'],
            }
          : {}),
      });
      assignedByMonth[m] += asg;
      activityByMonth[m] += act;
      cashOverspendByMonth[m] += cashOver;
      creditOverspendByMonth[m] += creditOver;
      prevAvail = available;
      prevCreditOver = creditOver;
    }
  }

  // Pass 2 — credit-card payment categories. Activity = covered spending in,
  // payments out. Cash rule applies: overpaying the card past what was set
  // aside is real cash overspending. Assigned counts toward RTA; activity is
  // internal reallocation, so it stays out of the spending totals.
  for (const cat of paymentCats) {
    const card = cat.paymentAccountId!;
    let prevAvail = 0;
    const aRow = assignedMap.get(cat.id);
    const covRow = coveredIn.get(card);
    const payRow = paymentsIn.get(card);
    for (const m of months) {
      const asg = aRow?.get(m) ?? 0;
      const act = (covRow?.get(m) ?? 0) - (payRow?.get(m) ?? 0);
      const available = carryForward(prevAvail) + asg + act;
      monthCategories.push({
        month: m,
        categoryId: cat.id,
        assigned: asg,
        activity: act,
        available,
        ...(available < 0 ? { overspendType: 'cash' as const } : {}),
      });
      assignedByMonth[m] += asg;
      if (available < 0) cashOverspendByMonth[m] += -available;
      prevAvail = available;
    }
  }

  // Income = inflows to the "Ready to Assign" category, per month.
  const incomeByMonth: Record<string, number> = {};
  for (const m of months) incomeByMonth[m] = 0;
  if (inflowCat) {
    const inflowRow = activity.get(inflowCat.id);
    if (inflowRow) for (const [m, v] of inflowRow) if (m in incomeByMonth) incomeByMonth[m] += v;
  }

  // Ready to Assign shown on month M:
  //   Σ income(≤M) − Σ assigned(≤M) − Σ cash-overspend(months < M)
  // (overspend in month M reduces RTA starting the FOLLOWING month).
  const rtaByMonth: Record<string, number> = {};
  let cumIncome = 0;
  let cumAssigned = 0;
  let cumOverspendBefore = 0;
  for (const m of months) {
    cumIncome += incomeByMonth[m];
    cumAssigned += assignedByMonth[m];
    rtaByMonth[m] = cumIncome - cumAssigned - cumOverspendBefore;
    cumOverspendBefore += cashOverspendByMonth[m];
  }

  return {
    monthCategories,
    rtaByMonth,
    incomeByMonth,
    assignedByMonth,
    activityByMonth,
    cashOverspendByMonth,
    creditOverspendByMonth,
  };
}

// Account balances for the sidebar / register (all accounts, on- or off-budget).
// Future-dated transactions are split into `upcoming` (YNAB shows them separately).
export function accountBalances(txns: EngineTxn[], asOf?: string): Record<string, AccountBalance> {
  const cutoff = asOf ?? '9999-12-31';
  const out: Record<string, AccountBalance> = {};
  for (const t of txns) {
    if (t.deleted) continue;
    const b = (out[t.accountId] ??= { accountId: t.accountId, cleared: 0, uncleared: 0, working: 0, upcoming: 0 });
    if (t.date > cutoff) {
      b.upcoming += t.amount;
      continue;
    }
    b.working += t.amount;
    if (t.cleared === 'uncleared') b.uncleared += t.amount;
    else b.cleared += t.amount;
  }
  return out;
}
