// Generic CSV import for sniffed dialects: takes normalized rows (from
// csvSniff.parseCsvRows) and creates transactions with the same guarantees as
// the bank-specific importers — payee rules apply, duplicates are skipped,
// inflows fall back to Ready to Assign.

import { PrismaClient } from '@prisma/client';
import type { CsvRow } from './csvSniff';
import { derivePatch } from './engine/payeeRules';

export interface GenericImportResult {
  imported: number;
  skipped: number;
  account: string;
}

export async function importGenericRows(
  prisma: PrismaClient,
  budgetId: string,
  accountName: string,
  rows: CsvRow[],
): Promise<GenericImportResult> {
  const account = await prisma.account.findFirst({ where: { budgetId, name: accountName } });
  if (!account) throw new Error(`Account "${accountName}" not found in the budget.`);

  const inflowCat = await prisma.category.findFirst({ where: { budgetId, isInflow: true } });

  const [ruleRows, liveCats, existing] = await Promise.all([
    prisma.payeeRule.findMany({ where: { budgetId }, orderBy: { createdAt: 'asc' } }),
    prisma.category.findMany({ where: { budgetId, deleted: false }, select: { id: true } }),
    prisma.transaction.findMany({
      where: { accountId: account.id },
      select: { importId: true, date: true, amount: true, payee: { select: { name: true } } },
    }),
  ]);
  const liveCatIds = new Set(liveCats.map((c) => c.id));

  // Dedup: importId scheme + (date, amount, payee-overlap) fallback.
  const seen = new Set(existing.map((t) => t.importId).filter((i): i is string => !!i));
  const dbDateAmount = new Map<string, string[]>();
  for (const t of existing) {
    if (!t.payee?.name) continue;
    const k = `${t.date}|${t.amount}`;
    (dbDateAmount.get(k) ?? dbDateAmount.set(k, []).get(k)!).push(t.payee.name.toLowerCase());
  }
  const runSeen = new Set<string>();

  const payeeCache = new Map<string, string>();
  const ensurePayee = async (name: string): Promise<string> => {
    const cached = payeeCache.get(name);
    if (cached) return cached;
    const found = await prisma.payee.findFirst({ where: { budgetId, name, transferAccountId: null } });
    const id = found?.id ?? (await prisma.payee.create({ data: { budgetId, name } })).id;
    payeeCache.set(name, id);
    return id;
  };

  const txData: {
    budgetId: string;
    accountId: string;
    date: string;
    amount: number;
    memo: string | null;
    cleared: string;
    payeeId: string;
    categoryId: string | null;
    importId: string;
  }[] = [];
  let imported = 0;
  let skipped = 0;

  for (const row of rows) {
    const payeeName = row.payee.trim() || 'Unknown';
    const payeeKey = payeeName.toLowerCase();
    const names = dbDateAmount.get(`${row.date}|${row.amount}`);
    if (names && names.some((n) => n === payeeKey || n.includes(payeeKey) || payeeKey.includes(n))) {
      skipped++;
      continue;
    }
    const baseId = `gen-csv:${row.date}:${row.amount}:${payeeName}`;
    const dedupId = row.memo ? `${baseId}:${row.memo}` : baseId;
    if (seen.has(baseId) || seen.has(dedupId) || runSeen.has(baseId) || runSeen.has(dedupId)) {
      skipped++;
      continue;
    }
    runSeen.add(dedupId);

    // Rules pipeline: may canonize the payee and/or set category + notes.
    const ruleRes = derivePatch({ payeeName, accountId: account.id, memo: row.memo }, ruleRows, liveCatIds);
    const finalName = ruleRes.payeeName ?? payeeName;
    const payeeId = await ensurePayee(finalName);

    const isInflow = row.amount > 0;
    txData.push({
      budgetId,
      accountId: account.id,
      date: row.date,
      amount: row.amount,
      memo: ruleRes.memo !== undefined ? ruleRes.memo : row.memo || null,
      cleared: 'cleared',
      payeeId,
      categoryId: ruleRes.categoryId ?? (isInflow ? inflowCat?.id ?? null : null),
      importId: dedupId,
    });
    imported++;
  }

  if (txData.length > 0) await prisma.transaction.createMany({ data: txData });
  return { imported, skipped, account: account.name };
}
