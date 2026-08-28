// Import a Trade Republic statement CSV into the matching account.
// The CSV is derived from the PDF statement.
// format: DATA;IMPORTO;PAYEE;MEMO  (DD/MM/YYYY, signed EUR with comma decimals).
// Money-market fund buy/sells are internal sweeps and never appear in the CSV
// (they are not cash-ledger rows).
//
// Usage: npx tsx src/importTradeRepublic.ts <csv-path>
//
// The target account name is user-specific — set IMPORT_TR_ACCOUNT in
// backend/.env (e.g. IMPORT_TR_ACCOUNT=Investments).

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { parseEuroMilli, parseEuDate } from './tsvFormat';
import { derivePatch } from './engine/payeeRules';

const ACCOUNT_NAME = process.env.IMPORT_TR_ACCOUNT;

// Rows whose memo starts with SKIP are known duplicates of transactions already
// registered through another importer (e.g. the BVR -> TR giroconto imported as
// a transfer pair by importCsv.ts). They are skipped with a message.
const isSkipRow = (memo: string): boolean => /^SKIP:/i.test(memo);

// Payees that exist in the budget under a different case/wording than the
// statement text; reuse them so the register stays consistent.
const PAYEE_ALIASES: Record<string, string> = {
  'LIDL SAGT DANKE': 'LIDL SAGT DANKE',
  'NETTO MARKEN-DISCOUNT': 'NETTO MARKEN-DISCOUNT',
  ROXX: 'ROXX',
  'ROSSMANN 3710': 'ROSSMANN 3710',
};

interface CsvRow {
  data: string;
  importo: string;
  payee: string;
  memo: string;
}

function parseCsv(text: string): CsvRow[] {
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = noBom.replace(/\r/g, '').split('\n').filter((l) => l.trim().length > 0);
  const header = lines[0].split(';');
  const idx = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const iData = idx('DATA');
  const iImporto = idx('IMPORTO');
  const iPayee = idx('PAYEE');
  const iMemo = idx('MEMO');

  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(';');
    rows.push({
      data: cells[iData]?.trim() ?? '',
      importo: cells[iImporto]?.trim() ?? '',
      payee: cells[iPayee]?.trim() ?? '',
      memo: cells[iMemo]?.trim() ?? '',
    });
  }
  return rows;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  account: string;
}

export async function importTradeRepublicCsv(
  prisma: PrismaClient,
  budgetId: string,
  text: string,
): Promise<ImportResult> {
  if (!ACCOUNT_NAME) throw new Error('Set IMPORT_TR_ACCOUNT in backend/.env to the Trade Republic account name.');
  const account = await prisma.account.findFirst({
    where: { budgetId, name: ACCOUNT_NAME },
  });
  if (!account) throw new Error(`Account "${ACCOUNT_NAME}" not found.`);

  const inflowCat = await prisma.category.findFirst({
    where: { budgetId, isInflow: true },
  });
  if (!inflowCat) throw new Error('No inflow (Ready to Assign) category found.');

  const [ruleRows, liveCats] = await Promise.all([
    prisma.payeeRule.findMany({ where: { budgetId }, orderBy: { createdAt: 'asc' } }),
    prisma.category.findMany({ where: { budgetId, deleted: false }, select: { id: true } }),
  ]);
  const rules = ruleRows;
  const liveCatIds = new Set(liveCats.map((c) => c.id));

  // Existing rows on this account for dedup: importId exact + (date, amount,
  // payee-overlap) — same rules as importCsv.ts.
  const existing = await prisma.transaction.findMany({
    where: { accountId: account.id },
    select: { importId: true, date: true, amount: true, payee: { select: { name: true } } },
  });
  const seen = new Set(existing.map((t) => t.importId).filter((i): i is string => !!i));
  const dbDateAmount = new Map<string, string[]>();
  for (const t of existing) {
    if (!t.payee?.name) continue;
    const k = `${t.date}|${t.amount}`;
    const arr = dbDateAmount.get(k) ?? [];
    arr.push(t.payee.name.toLowerCase());
    dbDateAmount.set(k, arr);
  }
  const runSeen = new Set<string>();

  const payeeCache = new Map<string, string>();
  const ensurePayee = async (name: string): Promise<string> => {
    const cached = payeeCache.get(name);
    if (cached) return cached;
    const found = await prisma.payee.findFirst({
      where: { budgetId, name, transferAccountId: null },
    });
    const id = found?.id ?? (await prisma.payee.create({ data: { budgetId, name } })).id;
    payeeCache.set(name, id);
    return id;
  };

  const rows = parseCsv(text);

  let imported = 0;
  let skipped = 0;
  const txData: any[] = [];

  for (const row of rows) {
    if (!row.data || !/^\d{2}\/\d{2}\/\d{4}$/.test(row.data)) {
      skipped++;
      continue;
    }
    if (isSkipRow(row.memo)) {
      skipped++;
      continue;
    }

    const amount = parseEuroMilli(row.importo);
    if (amount === 0) {
      skipped++;
      continue;
    }
    const date = parseEuDate(row.data);
    const isInflow = amount > 0;
    const payeeName = PAYEE_ALIASES[row.payee] ?? row.payee;
    const memo = row.memo || null;

    // Dedup by (date, amount, payee) — catches the importId scheme's blind spots.
    const payeeKey = payeeName.toLowerCase();
    const names = dbDateAmount.get(`${date}|${amount}`);
    if (names && names.some((n) => n === payeeKey || n.includes(payeeKey) || payeeKey.includes(n))) {
      skipped++;
      continue;
    }

    const baseId = `tr-csv:${date}:${amount}:${payeeName}`;
    const suffixedId = memo ? `${baseId}:${memo}` : null;
    if (seen.has(baseId) || seen.has(suffixedId ?? '')) {
      skipped++;
      continue;
    }
    if (runSeen.has(baseId)) {
      if (!suffixedId || runSeen.has(suffixedId)) {
        skipped++;
        continue;
      }
      runSeen.add(suffixedId);
    } else {
      runSeen.add(baseId);
    }
    const importId = runSeen.has(suffixedId ?? '') && suffixedId ? suffixedId : baseId;

    // Rules pipeline (ranked, last-wins): may canonize the payee name and/or
    // set category + notes. Rule match still beats the inflow fallback.
    const ruleRes = derivePatch(
      { payeeName, accountId: account.id, memo },
      rules,
      liveCatIds,
    );
    const finalName = ruleRes.payeeName ?? payeeName;
    const payeeId = await ensurePayee(finalName);
    txData.push({
      budgetId,
      accountId: account.id,
      date,
      amount,
      memo: ruleRes.memo !== undefined ? ruleRes.memo : memo,
      cleared: 'cleared',
      payeeId,
      categoryId: ruleRes.categoryId ?? (isInflow ? inflowCat.id : null),
      importId,
    });
    imported++;
  }

  if (txData.length > 0) {
    await prisma.transaction.createMany({ data: txData });
  }

  return { imported, skipped, account: account.name };
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('Usage: npx tsx src/importTradeRepublic.ts <csv-path>');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const budget = await prisma.budget.findFirst();
  if (!budget) {
    console.error('No budget found — run `npm run seed` first.');
    await prisma.$disconnect();
    process.exit(1);
  }

  try {
    const r = await importTradeRepublicCsv(prisma, budget.id, fs.readFileSync(csvPath, 'utf8'));
    console.log(`Imported ${r.imported} transactions into "${r.account}" (skipped ${r.skipped} summary/empty/duplicate rows).`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
  await prisma.$disconnect();
}

// Run only when executed directly (npx tsx src/importTradeRepublic.ts ...).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
