import { strict as assert } from 'node:assert';
import { projectCashflow, ScheduledLike } from './cashflow';
import { BudgetComputation } from './types';
import { EngineTxn, EngineAccount } from './types';

const TODAY = '2026-08-14';
const monthCategories = [
  { month: '2026-05-01', categoryId: 'groceries', assigned: 200000, activity: -150000, available: 50000 },
  { month: '2026-06-01', categoryId: 'groceries', assigned: 200000, activity: -180000, available: 70000 },
  { month: '2026-07-01', categoryId: 'groceries', assigned: 200000, activity: -160000, available: 110000 },
  { month: '2026-05-01', categoryId: 'rent', assigned: 500000, activity: -500000, available: 0 },
  { month: '2026-06-01', categoryId: 'rent', assigned: 500000, activity: -500000, available: 0 },
  { month: '2026-07-01', categoryId: 'rent', assigned: 500000, activity: -500000, available: 0 },
];

const comp: BudgetComputation = {
  monthCategories: monthCategories.map((m) => ({ ...m })),
  rtaByMonth: { '2026-07-01': 1000000, '2026-08-01': 800000 },
  incomeByMonth: { '2026-05-01': 300000, '2026-06-01': 310000, '2026-07-01': 290000 },
  assignedByMonth: { '2026-05-01': 700000, '2026-06-01': 700000, '2026-07-01': 700000 },
  activityByMonth: { '2026-05-01': -650000, '2026-06-01': -680000, '2026-07-01': -660000 },
  cashOverspendByMonth: {},
  creditOverspendByMonth: {},
};

const ACCOUNTS: EngineAccount[] = [
  { id: 'cash', onBudget: true, type: 'checking' },
  { id: 'track', onBudget: false, type: 'otherAsset' },
];

const txn = (over: Partial<EngineTxn>): EngineTxn => ({
  id: 'x',
  date: '2026-07-01',
  amount: 0,
  accountId: 'cash',
  categoryId: null,
  cleared: 'cleared',
  ...over,
});

const sched = (over: Partial<ScheduledLike>): ScheduledLike => ({
  id: 's',
  accountId: 'cash',
  payeeId: 'p1',
  payee: 'Rent',
  categoryId: 'rent',
  amount: -500000,
  frequency: 'monthly',
  nextDate: '2026-09-01',
  anchorDay: 1,
  transferAccountId: null,
  ...over,
});

const inflowTxn = (date: string, id: string) =>
  txn({ id, date, amount: 300000, categoryId: 'inflow', payeeId: 'boss' });

const base = {
  comp,
  currentMonth: '2026-08-01',
  horizonMonths: 3,
  today: TODAY,
  accounts: ACCOUNTS,
  txns: [inflowTxn('2026-05-10', 'i1'), inflowTxn('2026-06-10', 'i2'), inflowTxn('2026-07-10', 'i3')] as EngineTxn[],
  inflowCatId: 'inflow',
  paymentCatIds: new Set<string>(),
  systemPayeeIds: new Set<string>(),
  scheduled: [] as ScheduledLike[],
};

export function test() {
  // 1. baseline: partial row + chain rta0 + income − assigned
  const r1 = projectCashflow(base);
  assert.equal(r1.sufficient, true);
  assert.equal(r1.anchorRta, 800000);
  assert.equal(r1.historyMonths, 3);
  assert.equal(r1.rows[0].partial, true);
  assert.equal(r1.rows[0].projectedRTA, null);
  const sep = r1.rows[1];
  assert.equal(sep.month, '2026-09-01');
  assert.equal(sep.projectedIncome, 0); // known-only: no scheduled/upcoming inflows in Sep
  // spending = avg of groceries (-163.3k) + rent (-500k) → 663333.33
  assert.ok(Math.abs(sep.projectedSpending - 663333) < 1, String(sep.projectedSpending));
  assert.equal(sep.projectedAssigned, 700000); // trailing assigned avg (reported, no longer drives RTA)
  assert.equal(sep.projectedRTA, 800000 + 0 - sep.projectedSpending); // RTA chain: income − activity-based spending

  // 2. user assigned in a horizon month → actual value wins over avg
  const comp2: BudgetComputation = {
    ...comp,
    monthCategories: [...comp.monthCategories, { month: '2026-09-01', categoryId: 'groceries', assigned: 123000, activity: 0, available: 0 }],
  };
  const r2 = projectCashflow({ ...base, comp: comp2 });
  assert.equal(r2.rows[1].projectedAssigned, 123000);

  // 3. scheduled inflow is the known income in its month (grant in December)
  const grant = sched({ id: 'grant', payeeId: 'p9', payee: 'ACME', categoryId: 'inflow', amount: 2000000, nextDate: '2026-12-01', anchorDay: 1 });
  const r3 = projectCashflow({ ...base, scheduled: [grant], horizonMonths: 5 });
  const dec = r3.rows.find((r) => r.month === '2026-12-01')!;
  assert.equal(dec.projectedIncome, 2000000); // known-only: just the grant, no average added

  // 4. hybrid: scheduled category = occurrences + remainder; no double count
  const rentSched = sched({});
  const r4 = projectCashflow({ ...base, scheduled: [rentSched] });
  const sep4 = r4.rows[1];
  // rent: scheduled occurrence (-500k) + remainder (0, rent avg was exactly -500k) = -500k
  // groceries: avg -163.3k → spending = 663333
  assert.ok(Math.abs(sep4.projectedSpending - 663333) < 1, String(sep4.projectedSpending));

  // 5. on-budget transfer leg excluded from known net; tracking transfer counted
  const transfer = sched({ id: 't1', payeeId: 'p5', categoryId: null, amount: -100000, nextDate: '2026-09-05', transferAccountId: 'cash' });
  const r5 = projectCashflow({ ...base, scheduled: [transfer] });
  assert.equal(r5.rows[1].knownScheduledNet, 0);
  const transferTrack = sched({ id: 't2', payeeId: 'p5', categoryId: null, amount: -100000, nextDate: '2026-09-05', transferAccountId: 'track' });
  const r5b = projectCashflow({ ...base, scheduled: [transferTrack] });
  assert.equal(r5b.rows[1].knownScheduledNet, -100000);

  // 6. a future-dated real inflow (upcoming) counts as known income in its month
  const futureInflow = txn({ id: 'fi', date: '2026-12-10', amount: 200000, categoryId: 'inflow', payeeId: 'boss' });
  const r6 = projectCashflow({ ...base, txns: [futureInflow], horizonMonths: 5 });
  const dec6 = r6.rows.find((r) => r.month === '2026-12-01')!;
  assert.equal(dec6.projectedIncome, 200000); // upcoming inflow → known income
  // a past inflow does NOT lift a future month (no averaging of income)
  const r6b = projectCashflow(base);
  assert.equal(r6b.rows[1].projectedIncome, 0);

  // 7. future-dated real txn bucketed as upcoming
  const future = txn({ id: 'f', date: '2026-09-15', amount: -80000, categoryId: 'groceries' });
  const r7 = projectCashflow({ ...base, txns: [future] });
  const sep7 = r7.rows[1];
  assert.equal(sep7.schedules.filter((s) => s.source === 'upcoming').length, 1);
  assert.equal(sep7.knownScheduledNet, -80000);

  // 8. insufficient history
  const thinComp: BudgetComputation = { ...comp, monthCategories: [], incomeByMonth: {}, assignedByMonth: {}, activityByMonth: {} };
  const r8 = projectCashflow({ ...base, comp: thinComp });
  assert.equal(r8.sufficient, false);
  assert.equal(r8.rows[1].projectedIncome, 0);
  assert.equal(r8.rows[1].projectedAssigned, 0);

  // 9. horizon beyond the budget's last month is fine (pure date math)
  const far = projectCashflow({ ...base, horizonMonths: 36 });
  assert.equal(far.rows.length, 37); // partial + 36

  // 10. targets-aware: unassigned months floor the projection at the sum of
  // target requirements (MF 300k + monthly NEED 150k = 450k > assigned avg 700k?
  // No — 450k < 700k, so the avg still wins; raise the target to prove the floor)
  const targetCats = [
    { goalType: 'MF' as const, goalTarget: 900000, goalCadence: null, goalDay: null, goalTargetMonth: null, goalNeedsWholeAmount: null },
    { goalType: 'NEED' as const, goalTarget: 200000, goalCadence: 'monthly', goalDay: null, goalTargetMonth: null, goalNeedsWholeAmount: false },
  ];
  const r10 = projectCashflow({ ...base, targetCats });
  assert.equal(r10.rows[1].projectedAssigned, 1100000); // 900k + 200k floors the 700k avg
  // ...but a user's own assignment in the month always wins
  const comp10: BudgetComputation = {
    ...comp,
    monthCategories: [...comp.monthCategories, { month: '2026-09-01', categoryId: 'groceries', assigned: 500000, activity: 0, available: 0 }],
  };
  const r10b = projectCashflow({ ...base, comp: comp10, targetCats });
  assert.equal(r10b.rows[1].projectedAssigned, 500000);

  // 11. seasonal: a category whose same-calendar-month-last-year value deviates
  // from its average gets a blended factor; flat history stays flat
  const seasonalComp: BudgetComputation = {
    ...comp,
    monthCategories: [
      // groceries: flat ~ -160k across 2025-09..2026-07 (7 months)
      ...['2025-09-01', '2025-10-01', '2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01', '2026-03-01'].map(
        (month, i) => ({ month, categoryId: 'groceries', assigned: 200000, activity: -160000 - i * 0, available: 0 }),
      ),
      ...['2025-09-01', '2025-10-01', '2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01', '2026-03-01'].map((month) => ({
        month,
        categoryId: 'seasonal',
        assigned: 0,
        activity: month === '2025-12-01' ? -1000000 : -200000,
        available: 0,
      })),
    ],
  };
  const r11 = projectCashflow({ ...base, comp: seasonalComp, horizonMonths: 5 });
  // September: both categories have same-calendar-month-last-year samples
  // (2025-09) → seasonal factor 1 for groceries (avg == 160k) and
  // 0.5 + 0.5*(200k/314.3k) ≈ 0.818 for the seasonal category
  const sep11 = r11.rows[1];
  const groceriesAvg = 160000;
  const seasonalAvg = (1000000 + 6 * 200000) / 7;
  const sepSeasonalFactor = 0.5 + 0.5 * (200000 / seasonalAvg);
  assert.ok(Math.abs(sep11.projectedSpending - (groceriesAvg + seasonalAvg * sepSeasonalFactor)) < 1, String(sep11.projectedSpending));
  // December has a same-month-last-year sample: groceries 160k → factor 1;
  // seasonal category: 1M vs avg 314.3k → factor 0.5 + 0.5*(1000/314.3) ≈ 2.09
  const dec11 = r11.rows.find((r) => r.month === '2026-12-01')!;
  assert.equal(dec11.month, '2026-12-01');
  const decFactor = 0.5 + 0.5 * (1000000 / seasonalAvg);
  assert.ok(Math.abs(dec11.projectedSpending - (groceriesAvg + seasonalAvg * decFactor)) < 1, String(dec11.projectedSpending));

  // 12. projected-expense overrides replace the category's spending estimate
  const rentSchedO = sched({});
  const r12 = projectCashflow({
    ...base,
    scheduled: [rentSchedO],
    overrides: [{ categoryId: 'rent', month: '2026-09-01', amount: -700000 }],
  });
  const sep12 = r12.rows[1];
  // rent: override -700k replaces (scheduled -500k + remainder); groceries avg -163.3k
  assert.ok(Math.abs(sep12.projectedSpending - (700000 + 163333.33)) < 1, String(sep12.projectedSpending));
  assert.equal(sep12.overridesUsed, 1);
  // October has no override → scheduled + averages as before
  const oct12 = r12.rows[2];
  assert.ok(Math.abs(oct12.projectedSpending - 663333) < 1, String(oct12.projectedSpending));
  assert.equal(oct12.overridesUsed, 0);

  // 13. a schedule stops recurring after its endMonth
  const r13 = projectCashflow({
    ...base,
    scheduled: [sched({ endMonth: '2026-10-01' })], // rent monthly from 2026-09-01
    horizonMonths: 4,
  });
  assert.ok(r13.rows[1].schedules.some((s) => s.payee === 'Rent'), 'rent scheduled in Sep (within endMonth)');
  assert.ok(r13.rows[2].schedules.some((s) => s.payee === 'Rent'), 'rent scheduled in Oct (endMonth inclusive)');
  assert.ok(!r13.rows[3].schedules.some((s) => s.payee === 'Rent'), 'rent stops after endMonth');
}

test();
console.log('cashflow: ok');
