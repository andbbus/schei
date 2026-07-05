// Engine self-check. No framework: plain asserts, run with `npm test`.
// Fails loud (non-zero exit) if any budgeting invariant breaks.

import assert from 'node:assert/strict';
import { computeBudget, accountBalances } from './budget';
import { nextOccurrence } from './schedule';
import { computeTarget } from './targets';
import { computeAgeOfMoney } from './ageOfMoney';
import { autoAssignAmount } from './autoAssign';
import { EngineAccount, EngineCategory } from './types';

const accounts: EngineAccount[] = [{ id: 'check', onBudget: true, type: 'checking' }];
const cats: EngineCategory[] = [
  { id: 'inflow', isInflow: true },
  { id: 'groc', isInflow: false },
  { id: 'rent', isInflow: false },
];
const months = ['2026-06-01', '2026-07-01'];

// Scenario: €1000 income June; assign €200 groceries June; spend €250 groceries June.
const r = computeBudget({
  months,
  categories: cats,
  accounts,
  assigned: [{ month: '2026-06-01', categoryId: 'groc', amount: 200_000 }],
  txns: [
    { id: 'i1', date: '2026-06-05', amount: 1_000_000, accountId: 'check', categoryId: 'inflow', cleared: 'cleared' },
    { id: 's1', date: '2026-06-20', amount: -250_000, accountId: 'check', categoryId: 'groc', cleared: 'cleared' },
  ],
});
const avail = (m: string, c: string) =>
  r.monthCategories.find((x) => x.month === m && x.categoryId === c)!.available;

assert.equal(avail('2026-06-01', 'groc'), -50_000, 'June groceries overspent by 50');
assert.equal(r.rtaByMonth['2026-06-01'], 800_000, 'June RTA = 1000 - 200');
assert.equal(avail('2026-07-01', 'groc'), 0, 'cash overspend does NOT carry forward');
assert.equal(r.rtaByMonth['2026-07-01'], 750_000, 'July RTA reduced by June cash overspend');
console.log('✓ cash overspend → next-month RTA, no negative carry');

// Scenario: positive available carries forward.
const r2 = computeBudget({
  months,
  categories: cats,
  accounts,
  assigned: [{ month: '2026-06-01', categoryId: 'rent', amount: 300_000 }],
  txns: [{ id: 'i', date: '2026-06-01', amount: 300_000, accountId: 'check', categoryId: 'inflow', cleared: 'cleared' }],
});
const rentJul = r2.monthCategories.find((x) => x.month === '2026-07-01' && x.categoryId === 'rent')!.available;
assert.equal(rentJul, 300_000, 'positive available carries into next month');
assert.equal(r2.rtaByMonth['2026-06-01'], 0, 'all money assigned → RTA 0');
console.log('✓ positive carryover + RTA = income − assigned');

// Account balances: cleared vs uncleared.
const bal = accountBalances([
  { id: 't1', date: '2026-06-01', amount: 100_000, accountId: 'check', categoryId: 'inflow', cleared: 'cleared' },
  { id: 't2', date: '2026-06-02', amount: -40_000, accountId: 'check', categoryId: 'groc', cleared: 'uncleared' },
]);
assert.equal(bal['check'].cleared, 100_000);
assert.equal(bal['check'].uncleared, -40_000);
assert.equal(bal['check'].working, 60_000);
console.log('✓ account balances: cleared / uncleared / working');

// Targets: Monthly funding underfunded.
const t = computeTarget(
  { goalType: 'MF', goalTarget: 50_000, goalCadence: 'monthly', goalDay: null, goalTargetMonth: null, goalNeedsWholeAmount: true },
  { month: '2026-06-01', assignedThisMonth: 30_000, available: 30_000 },
);
assert.equal(t.underfunded, 20_000, 'MF target underfunded by 20');
assert.equal(t.state, 'underfunded');
assert.ok(Math.abs(t.progress - 0.6) < 1e-9, 'progress 60%');
console.log('✓ target (MF) underfunded math');

// Age of money: spent 10 days after earning.
const age = computeAgeOfMoney(
  [
    { id: 'in', date: '2026-06-01', amount: 100_000, accountId: 'check', categoryId: 'inflow', cleared: 'cleared' },
    { id: 'out', date: '2026-06-11', amount: -100_000, accountId: 'check', categoryId: 'groc', cleared: 'cleared' },
  ],
  accounts,
);
assert.equal(age, 10, 'age of money = 10 days');
console.log('✓ age of money FIFO');

// Future-dated (upcoming) transactions are excluded from activity until asOf.
const rFut = computeBudget({
  months,
  categories: cats,
  accounts,
  assigned: [{ month: '2026-06-01', categoryId: 'groc', amount: 100_000 }],
  txns: [
    { id: 'past', date: '2026-06-10', amount: -30_000, accountId: 'check', categoryId: 'groc', cleared: 'cleared' },
    { id: 'future', date: '2026-06-25', amount: -50_000, accountId: 'check', categoryId: 'groc', cleared: 'uncleared' },
  ],
  asOf: '2026-06-15',
});
const grocFut = rFut.monthCategories.find((x) => x.month === '2026-06-01' && x.categoryId === 'groc')!;
assert.equal(grocFut.activity, -30_000, 'future-dated txn (after asOf) excluded from activity');
assert.equal(grocFut.available, 70_000, 'available ignores upcoming spend');
console.log('✓ future-dated transactions excluded until asOf');

// Auto-assign: fund the underfunded amount.
const newAssigned = autoAssignAmount('underfunded', '2026-06-01', { '2026-06-01': { assigned: 30_000, activity: 0, available: 30_000 } }, 20_000);
assert.equal(newAssigned, 50_000, 'auto-assign underfunded → assigned reaches target');
console.log('✓ auto-assign underfunded');

// ---------- Credit-card engine ----------

const ccAccounts: EngineAccount[] = [
  { id: 'check', onBudget: true, type: 'checking' },
  { id: 'card', onBudget: true, type: 'creditCard' },
];
const ccCats: EngineCategory[] = [
  { id: 'inflow', isInflow: true },
  { id: 'groc', isInflow: false },
  { id: 'pay', isInflow: false, paymentAccountId: 'card' },
];
const income = { id: 'i', date: '2026-06-01', amount: 1_000_000, accountId: 'check', categoryId: 'inflow', cleared: 'cleared' as const };
const cell = (res: ReturnType<typeof computeBudget>, m: string, c: string) =>
  res.monthCategories.find((x) => x.month === m && x.categoryId === c)!;

// Conservation with a card: Σ available + RTA + outstanding credit overspend
// = Σ working balances of on-budget NON-card accounts.
const assertConservation = (res: ReturnType<typeof computeBudget>, txns: Parameters<typeof accountBalances>[0], m: string) => {
  const sumAvail = res.monthCategories.filter((x) => x.month === m).reduce((s, x) => s + x.available, 0);
  const balances = accountBalances(txns);
  const cash = ccAccounts.filter((a) => a.onBudget && a.type !== 'creditCard').reduce((s, a) => s + (balances[a.id]?.working ?? 0), 0);
  assert.equal(sumAvail + res.rtaByMonth[m] + res.creditOverspendByMonth[m], cash, `conservation identity holds in ${m}`);
};

// Funded card spend: money moves from the spent category to the payment category.
{
  const txns = [income, { id: 'c1', date: '2026-06-10', amount: -150_000, accountId: 'card', categoryId: 'groc', cleared: 'cleared' as const }];
  const res = computeBudget({
    months,
    categories: ccCats,
    accounts: ccAccounts,
    assigned: [{ month: '2026-06-01', categoryId: 'groc', amount: 200_000 }],
    txns,
  });
  assert.equal(cell(res, '2026-06-01', 'groc').available, 50_000, 'groceries keep the unspent 50');
  assert.equal(cell(res, '2026-06-01', 'pay').activity, 150_000, 'covered spending flows into the payment category');
  assert.equal(cell(res, '2026-06-01', 'pay').available, 150_000, 'payment category holds the 150 set aside');
  assert.equal(res.rtaByMonth['2026-06-01'], 800_000, 'RTA untouched by card spending');
  assertConservation(res, txns, '2026-06-01');
  console.log('✓ CC: funded card spend fills the payment category');
}

// Credit overspend: carries forward negative, does NOT ding RTA.
{
  const txns = [income, { id: 'c1', date: '2026-06-10', amount: -150_000, accountId: 'card', categoryId: 'groc', cleared: 'cleared' as const }];
  const res = computeBudget({
    months,
    categories: ccCats,
    accounts: ccAccounts,
    assigned: [{ month: '2026-06-01', categoryId: 'groc', amount: 100_000 }],
    txns,
  });
  const juneGroc = cell(res, '2026-06-01', 'groc');
  assert.equal(juneGroc.available, -50_000, 'groceries overspent by 50 on the card');
  assert.equal(juneGroc.overspendType, 'credit');
  assert.equal(cell(res, '2026-06-01', 'pay').available, 100_000, 'only the funded 100 is covered');
  assert.equal(cell(res, '2026-07-01', 'groc').available, -50_000, 'credit overspend carries forward negative');
  assert.equal(res.rtaByMonth['2026-07-01'], 900_000, 'credit overspend does NOT reduce next-month RTA');
  assert.equal(res.cashOverspendByMonth['2026-06-01'], 0);
  assertConservation(res, txns, '2026-06-01');
  assertConservation(res, txns, '2026-07-01');
  console.log('✓ CC: credit overspend carries negative, RTA untouched');
}

// Mixed overspend: cash portion dings RTA, credit portion carries.
{
  const txns = [
    income,
    { id: 'k1', date: '2026-06-09', amount: -120_000, accountId: 'check', categoryId: 'groc', cleared: 'cleared' as const },
    { id: 'c1', date: '2026-06-10', amount: -30_000, accountId: 'card', categoryId: 'groc', cleared: 'cleared' as const },
  ];
  const res = computeBudget({
    months,
    categories: ccCats,
    accounts: ccAccounts,
    assigned: [{ month: '2026-06-01', categoryId: 'groc', amount: 100_000 }],
    txns,
  });
  const juneGroc = cell(res, '2026-06-01', 'groc');
  assert.equal(juneGroc.available, -50_000);
  assert.equal(juneGroc.overspendType, 'mixed');
  assert.equal(res.cashOverspendByMonth['2026-06-01'], 20_000, 'cash portion = 20');
  assert.equal(res.creditOverspendByMonth['2026-06-01'], 30_000, 'credit portion = 30');
  assert.equal(cell(res, '2026-07-01', 'groc').available, -30_000, 'only the credit portion carries');
  assert.equal(res.rtaByMonth['2026-07-01'], 900_000 - 20_000, 'RTA dinged by the cash portion only');
  assertConservation(res, txns, '2026-06-01');
  console.log('✓ CC: mixed overspend splits cash vs credit');
}

// Payment: transfer to the card drains the payment category.
{
  const txns = [
    income,
    { id: 'c1', date: '2026-06-10', amount: -150_000, accountId: 'card', categoryId: 'groc', cleared: 'cleared' as const },
    { id: 'p1', date: '2026-06-15', amount: 150_000, accountId: 'card', categoryId: null, transferAccountId: 'check', cleared: 'cleared' as const },
    { id: 'p2', date: '2026-06-15', amount: -150_000, accountId: 'check', categoryId: null, transferAccountId: 'card', cleared: 'cleared' as const },
  ];
  const res = computeBudget({
    months,
    categories: ccCats,
    accounts: ccAccounts,
    assigned: [{ month: '2026-06-01', categoryId: 'groc', amount: 200_000 }],
    txns,
  });
  assert.equal(cell(res, '2026-06-01', 'pay').activity, 0, 'covered 150 in, payment 150 out');
  assert.equal(cell(res, '2026-06-01', 'pay').available, 0, 'card fully paid');
  assertConservation(res, txns, '2026-06-01');
  console.log('✓ CC: payment transfer drains the payment category');
}

// Overpayment: paying more than was set aside is cash overspending.
{
  const txns = [
    income,
    { id: 'p1', date: '2026-06-15', amount: 100_000, accountId: 'card', categoryId: null, transferAccountId: 'check', cleared: 'cleared' as const },
    { id: 'p2', date: '2026-06-15', amount: -100_000, accountId: 'check', categoryId: null, transferAccountId: 'card', cleared: 'cleared' as const },
  ];
  const res = computeBudget({ months, categories: ccCats, accounts: ccAccounts, assigned: [], txns });
  const junePay = cell(res, '2026-06-01', 'pay');
  assert.equal(junePay.available, -100_000, 'overpaid by 100 with nothing set aside');
  assert.equal(junePay.overspendType, 'cash');
  assert.equal(cell(res, '2026-07-01', 'pay').available, 0, 'payment category resets like cash');
  assert.equal(res.rtaByMonth['2026-07-01'], 1_000_000 - 100_000, 'overpayment dings next-month RTA');
  console.log('✓ CC: overpayment = cash overspend on the payment category');
}

// Refund on the card reduces what needs to be paid.
{
  const txns = [
    income,
    { id: 'c1', date: '2026-06-10', amount: -150_000, accountId: 'card', categoryId: 'groc', cleared: 'cleared' as const },
    { id: 'r1', date: '2026-06-12', amount: 50_000, accountId: 'card', categoryId: 'groc', cleared: 'cleared' as const },
  ];
  const res = computeBudget({
    months,
    categories: ccCats,
    accounts: ccAccounts,
    assigned: [{ month: '2026-06-01', categoryId: 'groc', amount: 200_000 }],
    txns,
  });
  assert.equal(cell(res, '2026-06-01', 'groc').available, 100_000, 'net 100 spent from groceries');
  assert.equal(cell(res, '2026-06-01', 'pay').available, 100_000, 'only the net 100 set aside for the card');
  assertConservation(res, txns, '2026-06-01');
  console.log('✓ CC: refund nets against card spending');
}

// Regression: an unused card account changes nothing for all-cash budgets.
{
  const res = computeBudget({
    months,
    categories: [...cats, { id: 'pay', isInflow: false, paymentAccountId: 'card' }],
    accounts: ccAccounts,
    assigned: [{ month: '2026-06-01', categoryId: 'groc', amount: 200_000 }],
    txns: [
      { id: 'i1', date: '2026-06-05', amount: 1_000_000, accountId: 'check', categoryId: 'inflow', cleared: 'cleared' },
      { id: 's1', date: '2026-06-20', amount: -250_000, accountId: 'check', categoryId: 'groc', cleared: 'cleared' },
    ],
  });
  assert.equal(cell(res, '2026-06-01', 'groc').available, -50_000);
  assert.equal(cell(res, '2026-06-01', 'groc').overspendType, 'cash');
  assert.equal(res.rtaByMonth['2026-07-01'], 750_000, 'identical to the all-cash scenario');
  assert.equal(cell(res, '2026-06-01', 'pay').available, 0);
  console.log('✓ CC: unused card account is a no-op');
}

// Reconciliation adjustment: an inflow-categorized reconciled txn moves RTA and
// the account balance by exactly the diff — the conservation identity survives.
{
  for (const diff of [25_000, -25_000]) {
    const txns = [
      income,
      { id: 'adj', date: '2026-06-20', amount: diff, accountId: 'check', categoryId: 'inflow', cleared: 'reconciled' as const },
    ];
    const res = computeBudget({ months, categories: ccCats, accounts: ccAccounts, assigned: [], txns });
    assert.equal(res.rtaByMonth['2026-06-01'], 1_000_000 + diff, `adjustment of ${diff} moves RTA`);
    assert.equal(accountBalances(txns)['check'].working, 1_000_000 + diff, 'and the account balance');
    assertConservation(res, txns, '2026-06-01');
  }
  console.log('✓ reconciliation adjustment keeps RTA + balances consistent');
}

// Scheduled-transaction recurrence date math.
{
  assert.equal(nextOccurrence('once', '2026-06-15'), null);
  assert.equal(nextOccurrence('weekly', '2026-06-15'), '2026-06-22');
  assert.equal(nextOccurrence('everyOtherWeek', '2026-06-25'), '2026-07-09', 'crosses month end');
  assert.equal(nextOccurrence('monthly', '2026-01-31'), '2026-02-28', 'day clamped to month length');
  assert.equal(nextOccurrence('monthly', '2026-12-15'), '2027-01-15', 'crosses year end');
  assert.equal(nextOccurrence('yearly', '2028-02-29'), '2029-02-28', 'leap day clamped');
  assert.equal(nextOccurrence('yearly', '2026-07-04'), '2027-07-04');
  console.log('✓ scheduled recurrence date math');
}

console.log('\nALL ENGINE TESTS PASSED');
