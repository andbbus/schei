// Import a YNAB TSV export (Register.tsv + Plan.tsv) into the database.
// This doubles as the real-data seed and as the phase-2 CSV/TSV import feature.
//
// Usage: npm run import  ["/path/to/YNAB Export dir"]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { parseTsv, parseEuroMilli, parseEuDate, parseMonthLabel, clearedFromLabel } from './tsvFormat';

const INFLOW = 'Inflow: Ready to Assign';

// The TSV export carries no account type / on-budget flag. Which accounts are
// tracking (off-budget) is user-specific, so the mapping comes from
// backend/.env (`TRACKING_ACCOUNTS` as JSON, e.g.
// {"Rent":"otherLiability"}) — never baked into the repo.
export const DEFAULT_TRACKING: Record<string, string> = (() => {
  try {
    return JSON.parse(process.env.TRACKING_ACCOUNTS || '{}');
  } catch {
    return {};
  }
})();

function findFile(dir: string, suffix: string): string {
  const f = fs.readdirSync(dir).find((n) => n.endsWith(suffix));
  if (!f) throw new Error(`No file ending in "${suffix}" in ${dir}`);
  return path.join(dir, f);
}

export async function importTsvExport(
  dir: string,
  prisma: PrismaClient,
  opts: { trackingAccounts?: Record<string, string> } = {},
): Promise<string> {
  const tracking = opts.trackingAccounts ?? {};
  const register = parseTsv(fs.readFileSync(findFile(dir, '- Register.tsv'), 'utf8'));
  const plan = parseTsv(fs.readFileSync(findFile(dir, '- Plan.tsv'), 'utf8'));
  const [rHead, ...rRows] = register;
  const [pHead, ...pRows] = plan;
  const ri = (n: string) => rHead.indexOf(n);
  const pi = (n: string) => pHead.indexOf(n);

  const months = [...new Set(pRows.map((r) => parseMonthLabel(r[pi('Month')])))].sort();
  const firstMonth = months[0];
  const lastMonth = months[months.length - 1];

  // Groups + categories in YNAB's order (first appearance in Plan).
  const groupOrder: string[] = [];
  const catOrder: { full: string; group: string; name: string }[] = [];
  const seenGroup = new Set<string>();
  const seenCat = new Set<string>();
  for (const r of pRows) {
    const group = r[pi('Category Group')];
    const name = r[pi('Category')];
    const full = r[pi('Category Group/Category')].trim();
    if (!seenGroup.has(group)) { seenGroup.add(group); groupOrder.push(group); }
    if (!seenCat.has(full)) { seenCat.add(full); catOrder.push({ full, group, name }); }
  }
  // Register-only categories — chiefly "Inflow: Ready to Assign", which Plan.tsv omits
  // (you never assign to it). Without this the income category is missing and RTA breaks.
  for (const r of rRows) {
    const full = (r[ri('Category Group/Category')] || '').trim();
    if (!full) continue;
    const group = r[ri('Category Group')];
    const name = r[ri('Category')];
    if (!seenGroup.has(group)) { seenGroup.add(group); groupOrder.push(group); }
    if (!seenCat.has(full)) { seenCat.add(full); catOrder.push({ full, group, name }); }
  }

  const budget = await prisma.budget.create({
    data: {
      name: 'Imported Budget',
      currencyIso: 'EUR',
      currencySymbol: '€',
      decimalDigits: 2,
      dateFormat: 'DD/MM/YYYY',
      locale: 'it-IT',
      firstMonth,
      lastMonth,
    },
  });

  const groupId = new Map<string, string>();
  for (let i = 0; i < groupOrder.length; i++) {
    const g = groupOrder[i];
    const rec = await prisma.categoryGroup.create({
      data: { budgetId: budget.id, name: g, sortOrder: i, isSystem: g === 'Inflow' },
    });
    groupId.set(g, rec.id);
  }

  const catId = new Map<string, string>();
  for (let i = 0; i < catOrder.length; i++) {
    const c = catOrder[i];
    const rec = await prisma.category.create({
      data: { budgetId: budget.id, groupId: groupId.get(c.group)!, name: c.name, sortOrder: i, isInflow: c.full === INFLOW },
    });
    catId.set(c.full, rec.id);
  }

  const acctId = new Map<string, string>();
  const acctNames = [...new Set(rRows.map((r) => r[ri('Account')]))];
  for (let i = 0; i < acctNames.length; i++) {
    const name = acctNames[i];
    const isTracking = name in tracking;
    const rec = await prisma.account.create({
      data: {
        budgetId: budget.id,
        name,
        type: isTracking ? tracking[name] : 'checking',
        onBudget: !isTracking,
        sortOrder: i,
      },
    });
    acctId.set(name, rec.id);
  }

  const payeeId = new Map<string, string>();
  const ensurePayee = async (name: string): Promise<string> => {
    const existing = payeeId.get(name);
    if (existing) return existing;
    const rec = await prisma.payee.create({ data: { budgetId: budget.id, name } });
    payeeId.set(name, rec.id);
    return rec.id;
  };

  const txData: any[] = [];
  for (const r of rRows) {
    const payeeRaw = (r[ri('Payee')] || '').trim();
    const catFull = (r[ri('Category Group/Category')] || '').trim();
    const isTransfer = /^Transfer\s*:/.test(payeeRaw);
    const amount = parseEuroMilli(r[ri('Inflow')]) - parseEuroMilli(r[ri('Outflow')]);
    const flag = (r[ri('Flag')] || '').trim().toLowerCase();

    let pid: string | null = null;
    let transferAccountId: string | null = null;
    if (isTransfer) {
      transferAccountId = acctId.get(payeeRaw.replace(/^Transfer\s*:\s*/, '')) ?? null;
      pid = await ensurePayee(payeeRaw);
    } else if (payeeRaw) {
      pid = await ensurePayee(payeeRaw);
    }

    txData.push({
      budgetId: budget.id,
      accountId: acctId.get(r[ri('Account')])!,
      date: parseEuDate(r[ri('Date')]),
      amount,
      memo: (r[ri('Memo')] || '') || null,
      cleared: clearedFromLabel(r[ri('Cleared')] || ''),
      flagColor: flag || null,
      payeeId: pid,
      categoryId: isTransfer ? null : catFull ? catId.get(catFull) ?? null : null,
      transferAccountId,
    });
  }
  await prisma.transaction.createMany({ data: txData });

  const mcData: { budgetId: string; month: string; categoryId: string; assigned: number }[] = [];
  for (const r of pRows) {
    const assigned = parseEuroMilli(r[pi('Assigned')]);
    if (assigned === 0) continue;
    const cid = catId.get(r[pi('Category Group/Category')].trim());
    if (!cid) continue;
    mcData.push({ budgetId: budget.id, month: parseMonthLabel(r[pi('Month')]), categoryId: cid, assigned });
  }
  await prisma.monthCategory.createMany({ data: mcData });

  console.log(
    `Imported "${budget.name}": ${groupOrder.length} groups, ${catOrder.length} categories, ` +
      `${acctNames.length} accounts, ${txData.length} transactions, ${mcData.length} assigned cells ` +
      `(${firstMonth} … ${lastMonth}).`,
  );
  return budget.id;
}

async function main() {
  const dir = process.argv[2] || process.env.BUDGET_EXPORT_DIR;
  if (!dir) {
    console.error('Usage: npm run import <export-dir>   (or set BUDGET_EXPORT_DIR in backend/.env)');
    process.exit(1);
  }
  const prisma = new PrismaClient();
  await importTsvExport(dir, prisma, { trackingAccounts: DEFAULT_TRACKING });
  await prisma.$disconnect();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
