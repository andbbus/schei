// Oracle: validate the engine against a real YNAB export.
//
// Runs computeBudget() on the transactions + assigned amounts from the export,
// then compares every computed `available` cell to YNAB's own `Available`
// column in Plan.tsv. Exact milliunit match expected for cash/checking budgets.
// (Categories funded by credit-card spending may diverge — v1 has no CC logic.)
//
// Usage: npm run oracle  ["/path/to/YNAB Export dir"]

import fs from 'node:fs';
import path from 'node:path';
import { parseTsv, parseEuroMilli, parseEuDate, parseMonthLabel, clearedFromLabel } from './ynabFormat';
import { computeBudget } from './engine/budget';
import { EngineAccount, EngineCategory, EngineAssigned, EngineTxn } from './engine/types';

const DEFAULT_DIR =
  process.argv[2] ||
  process.env.YNAB_EXPORT_DIR ||
  '/Users/user/Downloads/YNAB Export - My Budget as of 2026-06-28 21-01';

function findFile(dir: string, suffix: string): string {
  const f = fs.readdirSync(dir).find((n) => n.endsWith(suffix));
  if (!f) throw new Error(`No file ending in "${suffix}" found in ${dir}`);
  return path.join(dir, f);
}

const INFLOW = 'Inflow: Ready to Assign';

function load(dir: string) {
  const register = parseTsv(fs.readFileSync(findFile(dir, '- Register.tsv'), 'utf8'));
  const plan = parseTsv(fs.readFileSync(findFile(dir, '- Plan.tsv'), 'utf8'));

  // --- Register → accounts, categories, transactions ---
  const [rHead, ...rRows] = register;
  const ri = (name: string) => rHead.indexOf(name);
  const cAccount = ri('Account');
  const cDate = ri('Date');
  const cPayee = ri('Payee');
  const cCat = ri('Category Group/Category');
  const cOut = ri('Outflow');
  const cIn = ri('Inflow');
  const cCleared = ri('Cleared');

  const accountIds = new Set<string>();
  const categoryIds = new Set<string>();
  const txns: EngineTxn[] = [];
  rRows.forEach((row, idx) => {
    const acct = row[cAccount];
    accountIds.add(acct);
    const catFull = row[cCat]?.trim() || '';
    const payee = row[cPayee]?.trim() || '';
    const isTransfer = payee.startsWith('Transfer :') || payee.startsWith('Transfer:');
    const categoryId = catFull && !isTransfer ? catFull : null;
    if (categoryId) categoryIds.add(categoryId);
    const amount = parseEuroMilli(row[cIn]) - parseEuroMilli(row[cOut]);
    txns.push({
      id: `t${idx}`,
      date: parseEuDate(row[cDate]),
      amount,
      accountId: acct,
      categoryId,
      cleared: clearedFromLabel(row[cCleared] ?? ''),
      transferAccountId: isTransfer ? payee.replace(/^Transfer\s*:\s*/, '') : null,
    });
  });

  // --- Plan → assigned, months, the Available oracle ---
  const [pHead, ...pRows] = plan;
  const pi = (name: string) => pHead.indexOf(name);
  const pMonth = pi('Month');
  const pCat = pi('Category Group/Category');
  const pAssigned = pi('Assigned');
  const pAvailable = pi('Available');

  const assigned: EngineAssigned[] = [];
  const monthsSet = new Set<string>();
  const oracle: { month: string; categoryId: string; available: number }[] = [];
  for (const row of pRows) {
    const month = parseMonthLabel(row[pMonth]);
    const categoryId = row[pCat]?.trim() || '';
    monthsSet.add(month);
    categoryIds.add(categoryId);
    const asg = parseEuroMilli(row[pAssigned]);
    if (asg !== 0) assigned.push({ month, categoryId, amount: asg });
    oracle.push({ month, categoryId, available: parseEuroMilli(row[pAvailable]) });
  }

  const accounts: EngineAccount[] = [...accountIds].map((id) => ({ id, onBudget: true, type: 'checking' }));
  const categories: EngineCategory[] = [...categoryIds].map((id) => ({ id, isInflow: id === INFLOW }));
  const months = [...monthsSet].sort();

  return { accounts, categories, months, assigned, txns, oracle };
}

function main() {
  console.log(`Oracle: ${DEFAULT_DIR}\n`);
  const { accounts, categories, months, assigned, txns, oracle } = load(DEFAULT_DIR);
  // "as of" date from the export name → matches YNAB's upcoming/future-dated cutoff.
  const asOf = DEFAULT_DIR.match(/as of (\d{4}-\d{2}-\d{2})/)?.[1] ?? new Date().toISOString().slice(0, 10);
  console.log(
    `Loaded: ${accounts.length} accounts, ${categories.length} categories, ${months.length} months ` +
      `(${months[0]} … ${months[months.length - 1]}), ${txns.length} transactions. As-of ${asOf}.\n`,
  );

  const result = computeBudget({ months, categories, accounts, assigned, txns, asOf });
  const got = new Map<string, number>();
  for (const mc of result.monthCategories) got.set(`${mc.month}|${mc.categoryId}`, mc.available);

  let checked = 0;
  let matches = 0;
  const mismatches: { month: string; cat: string; expected: number; got: number }[] = [];
  for (const o of oracle) {
    if (o.categoryId === INFLOW) continue; // inflow isn't a budgeted category
    const key = `${o.month}|${o.categoryId}`;
    if (!got.has(key)) continue; // category not in budget set (e.g. internal rows)
    checked++;
    const g = got.get(key)!;
    if (g === o.available) matches++;
    else mismatches.push({ month: o.month, cat: o.categoryId, expected: o.available, got: g });
  }

  const fmt = (m: number) => (m / 1000).toFixed(2);
  const pct = checked ? ((matches / checked) * 100).toFixed(2) : '0';
  console.log(`Available cells checked: ${checked}`);
  console.log(`Exact matches:           ${matches}  (${pct}%)`);
  console.log(`Mismatches:              ${mismatches.length}\n`);

  if (mismatches.length) {
    console.log('First mismatches (month · category · YNAB → engine · diff):');
    for (const m of mismatches.slice(0, 25)) {
      console.log(`  ${m.month}  ${m.cat}\n      YNAB ${fmt(m.expected)}  →  engine ${fmt(m.got)}  (diff ${fmt(m.got - m.expected)})`);
    }
    if (mismatches.length > 25) console.log(`  … and ${mismatches.length - 25} more`);
    // Which categories account for the mismatches (likely credit-card-funded)?
    const byCat = new Map<string, number>();
    for (const m of mismatches) byCat.set(m.cat, (byCat.get(m.cat) ?? 0) + 1);
    console.log('\nMismatches by category:');
    for (const [cat, n] of [...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`  ${n.toString().padStart(3)}  ${cat}`);
    }
  } else {
    console.log('🎯 Engine reproduces YNAB exactly on this budget.');
  }
}

main();
