// Import an Italian bank CSV export (ListaMovimentiCsv) into a specific account.
// Handles the MainBank / BVR CSV format: semicolon-delimited, European numbers,
// DD/MM/YYYY dates, DARE (debit) / AVERE (credit) columns.
//
// Usage: npx tsx src/importCsv.ts <csv-path> <account-name>

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { parseEuroMilli, parseEuDate } from './tsvFormat';
import { derivePatch } from './engine/payeeRules';

interface CsvRow {
  data: string;
  valuta: string;
  dare: string;
  avere: string;
  divisa: string;
  descrizione: string;
  causale: string;
}

function parseCsv(text: string): CsvRow[] {
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = noBom.replace(/\r/g, '').split('\n').filter((l) => l.trim().length > 0);
  const header = lines[0].split(';');
  const idx = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());

  const iData = idx('DATA');
  const iValuta = idx('VALUTA');
  const iDare = idx('DARE');
  const iAvere = idx('AVERE');
  const iDesc = idx('DESCRIZIONE_OPERAZIONE');
  const iCaus = idx('CAUSALE_ABI');

  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(';');
    rows.push({
      data: cells[iData]?.trim() ?? '',
      valuta: cells[iValuta]?.trim() ?? '',
      dare: cells[iDare]?.trim() ?? '',
      avere: cells[iAvere]?.trim() ?? '',
      divisa: cells[idx('DIVISA')]?.trim() ?? '',
      descrizione: cells[iDesc]?.trim() ?? '',
      causale: cells[iCaus]?.trim() ?? '',
    });
  }
  return rows;
}

// Summary rows that are not real transactions.
function isSummaryRow(desc: string): boolean {
  const d = desc.trim().toLowerCase();
  return d === 'saldo iniziale' ||
    d === 'saldo contabile' ||
    d === 'saldo liquido' ||
    d.startsWith('disponibilit');
}

// Extract a clean payee name from the verbose bank description.
function extractPayee(desc: string): string {
  // PAGAMENTO P.O.S. PAGOBANCOMAT DEL ... PRESSO {MERCHANT} CARTA ...
  let m = desc.match(/PRESSO\s+(.+?)\s+CARTA\b/i);
  if (m) return cleanMerchant(m[1]);

  // PAG.TO POS CIRC.INTERNAZIONALE ... PRESSO {MERCHANT} CARTA N. ...
  m = desc.match(/PRESSO\s+(.+?)\s+CARTA\b/i);
  if (m) return cleanMerchant(m[1]);

  // PRE-ADDEBITO POS DEU {MERCHANT}
  m = desc.match(/PRE-ADDEBITO POS\s+(?:DEU\s+)?(.+)/i);
  if (m) return cleanMerchant(m[1]);

  // S.D.D. / R.I.D. ADDEBITO CRED. {NAME} ID.MANDATO
  m = desc.match(/CRED\.\s+(.+?)\s+ID\.MANDATO/i);
  if (m) return cleanMerchant(m[1]);

  // BONIFICO ... A fav: {NAME} - ... or A fav: {NAME} ID.MSG
  m = desc.match(/A fav:\s*(.+?)(?:\s+-\s+|\s+ID\.MSG)/i);
  if (m) return cleanMerchant(m[1]);

  // Ordinante: {NAME} Causale: ... → extract from Causale
  if (/^Ordinante:/i.test(desc)) {
    if (/ANTICIPI MOBILITA/i.test(desc)) return 'ACME';
    if (/SCHOLARSHIP/i.test(desc)) return 'ACME';
    if (/RIMBORSO IRPEF/i.test(desc)) return 'Agenzia delle Entrate';
    // fall back to the ordinante name
    m = desc.match(/Ordinante:\s*(.+?)\s+Causale:/i);
    if (m) return cleanMerchant(m[1]);
  }

  // CANONE MAINBANK
  if (/CANONE MAINBANK/i.test(desc)) return 'MainBank';

  // COMM./SPESE OPERAZIONE ESTERO
  if (/COMM\.\/SPESE OPERAZIONE ESTERO/i.test(desc)) return 'Commissione Estero';

  // IMPOSTA DI BOLLO
  if (/IMPOSTA DI BOLLO/i.test(desc)) return 'Imposta di Bollo';

  // BONIFICO A VS. FAVORE Mangopay ... Marketplace TXI ...
  if (/MARKETPLACE/i.test(desc)) return 'Marketplace (Mangopay)';

  return cleanMerchant(desc.slice(0, 60));
}

function cleanMerchant(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/\s*FRANKFURT\s*/gi, '')
    .replace(/\s*G?TTINGEN\s*/gi, '')
    .replace(/\s*PARIS\s*/gi, '')
    .replace(/\s*WAGENINGEN\s*/gi, '')
    .replace(/\s*WUNSTORF\s*/gi, '')
    .replace(/\s*DELBR\s*CK\s*/gi, '')
    .replace(/\s*GLOC\s*/gi, '')
    .replace(/\s*VAV\s*/gi, '')
    .replace(/\s*\d+\s*$/g, '')
    .trim()
    .replace(/^.+?\s+\*\s*/, '') // "SUMUP *BRATWURST" → "BRATWURST"
    .replace(/\s+/g, ' ')
    .trim();
}

// Short memo: for POS, the location/date; for others, a trimmed description.
function extractMemo(desc: string): string {
  // For POS transactions, try to extract the date/time
  const posDate = desc.match(/DEL\s+(\d{2}-\d{2}-\d{4})\s+(\d{2}\.\d{2})/);
  if (posDate) return `POS ${posDate[1]} ${posDate[2]}`;

  const posDate2 = desc.match(/DATA-ORA\s+(\d{2}-\d{2}-\d{4})\s+(\d{2}\.\d{2}\.\d{2})/);
  if (posDate2) return `POS ${posDate2[1]} ${posDate2[2]}`;

  const posDate3 = desc.match(/DATA-ORA\s+(\d{2}-\d{2}-\d{4})/);
  if (posDate3) return `POS ${posDate3[1]}`;

  // For SDD, extract the reference
  const sddRef = desc.match(/RIF\.\s+(.+?)\s+SCAD/);
  if (sddRef) return sddRef[1];

  // For bonifico, extract the purpose
  const bonRef = desc.match(/RICON\.\.1\.:\s*(.+?)\s*-\s*OWNER/i);
  if (bonRef) return bonRef[1].trim();

  return '';
}

// Giroconti to the owner's own accounts are transfers between accounts, not
// spending. Description marker → counterpart account name (must exist in the
// budget). Each matched row creates a paired transaction on the counterpart.
const TRANSFER_RULES: { match: RegExp; account: string }[] = [
  { match: /giroconto su main bank/i, account: 'MainAccount' },
  { match: /giroconto su traderepublic/i, account: 'Investments' },
];

export interface ImportResult {
  imported: number;
  skipped: number;
  transferPairs: number;
  account: string;
}

// Reusable import entry point (CLI script + POST /import/csv share this).
// Throws an Error with a friendly message on invalid input.
export async function importBankCsv(
  prisma: PrismaClient,
  budgetId: string,
  accountName: string,
  text: string,
): Promise<ImportResult> {
  const account = await prisma.account.findFirst({ where: { budgetId, name: accountName } });
  if (!account) throw new Error(`Account "${accountName}" not found in the budget.`);

  const inflowCat = await prisma.category.findFirst({ where: { budgetId, isInflow: true } });
  if (!inflowCat) throw new Error('No inflow (Ready to Assign) category found.');

  // Payee rules: rule match beats the inflow fallback, so grant/salary rules
  // can catch income rows too.
  const [ruleRows, liveCats] = await Promise.all([
    prisma.payeeRule.findMany({ where: { budgetId }, orderBy: { createdAt: 'asc' } }),
    prisma.category.findMany({ where: { budgetId, deleted: false }, select: { id: true } }),
  ]);
  const rules = ruleRows;
  const liveCatIds = new Set(liveCats.map((c) => c.id));

  const rows = parseCsv(text);

  // Deduplicate: skip transactions already imported.
  // - importIds: exact match (covers the vast majority of overlap rows).
  // - (date, amount) on BOTH DATA and VALUTA with payee overlap: older imports
  //   dated some rows by VALUTA, payees were retitled in the UI, and DATA can
  //   shift between bank exports — so the plain importId scheme alone misses
  //   duplicates. Payee overlap (exact / prefix / suffix) avoids false
  //   positives when two real transactions share date+amount.
  const existing = await prisma.transaction.findMany({
    where: { accountId: account.id },
    select: { importId: true, date: true, amount: true, payee: { select: { name: true } } },
  });
  const seen = new Set(existing.map((t) => t.importId).filter((i): i is string => !!i));
  const dbDateAmount = new Map<string, string[]>(); // "date|amount" -> payee names
  for (const t of existing) {
    if (!t.payee?.name) continue;
    const k = `${t.date}|${t.amount}`;
    const arr = dbDateAmount.get(k) ?? [];
    arr.push(t.payee.name.toLowerCase());
    dbDateAmount.set(k, arr);
  }

  const runSeen = new Set<string>(); // importIds emitted in THIS run

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

  // "Transfer : <Account>" payees carry transferAccountId and are the payee of
  // choice for transfer transactions (mirroring the original app).
  const transferPayeeCache = new Map<string, string>();
  const ensureTransferPayee = async (acct: { id: string }, name: string): Promise<string> => {
    const key = `${acct.id}:${name}`;
    const cached = transferPayeeCache.get(key);
    if (cached) return cached;
    const found = await prisma.payee.findFirst({
      where: { budgetId, name, transferAccountId: acct.id },
    });
    const id = found?.id ?? (await prisma.payee.create({ data: { budgetId, name, transferAccountId: acct.id } })).id;
    transferPayeeCache.set(key, id);
    return id;
  };

  // Create the two sides of a giroconto and link them. Returns true if the
  // pair was created, false if it was a duplicate or the counterpart is missing.
  const importTransferPair = async (
    row: CsvRow,
    amount: number,
    date: string,
    cleared: string,
    memo: string | null,
  ): Promise<boolean> => {
    const rule = TRANSFER_RULES.find((r) => r.match.test(row.descrizione));
    if (!rule) return false;
    const counterpart = await prisma.account.findFirst({
      where: { budgetId, name: rule.account },
    });
    if (!counterpart) return false;
    const importId = `bvr-csv:transfer:${date}:${amount}:${counterpart.name}`;
    if (seen.has(importId) || runSeen.has(importId)) return false;
    seen.add(importId);
    runSeen.add(importId);

    // The payee's transferAccountId points to the TARGET account: on the BVR
    // side "Transfer : MainAccount" (transferAccountId = MainAccount), on the
    // counterpart side "Transfer : BVR" (transferAccountId = BVR).
    const srcPayeeId = await ensureTransferPayee(counterpart, `Transfer : ${counterpart.name}`);
    const cpPayeeId = await ensureTransferPayee(account, `Transfer : ${account.name}`);

    const src = await prisma.transaction.create({
      data: {
        budgetId,
        accountId: account.id,
        date,
        amount,
        memo,
        cleared,
        payeeId: srcPayeeId,
        categoryId: null,
        transferAccountId: counterpart.id,
        importId,
      },
    });
    const cp = await prisma.transaction.create({
      data: {
        budgetId,
        accountId: counterpart.id,
        date,
        amount: -amount,
        memo,
        cleared,
        payeeId: cpPayeeId,
        categoryId: null,
        transferAccountId: account.id,
        transferTransactionId: src.id,
        importId,
      },
    });
    await prisma.transaction.update({ where: { id: src.id }, data: { transferTransactionId: cp.id } });
    return true;
  };

  let imported = 0;
  let skipped = 0;
  let transferPairs = 0;
  const txData: any[] = [];

  for (const row of rows) {
    if (isSummaryRow(row.descrizione)) {
      skipped++;
      continue;
    }
    if (!row.data || !/^\d{2}\/\d{2}\/\d{4}$/.test(row.data)) {
      skipped++;
      continue;
    }

    const dare = parseEuroMilli(row.dare);
    const avere = parseEuroMilli(row.avere);
    if (dare === 0 && avere === 0) {
      skipped++;
      continue;
    }

    const amount = avere - dare; // positive = inflow, negative = outflow
    const date = parseEuDate(row.data);
    const isPending = row.valuta.toLowerCase() === 'prenotata';
    const cleared = isPending ? 'uncleared' : 'cleared';
    const isInflow = amount > 0;

    const payeeName = extractPayee(row.descrizione);
    const memo = extractMemo(row.descrizione);

    // Giroconti to own accounts become transfer pairs, not plain payees.
    if (TRANSFER_RULES.some((r) => r.match.test(row.descrizione))) {
      if (await importTransferPair(row, amount, date, cleared, memo || null)) {
        imported++;
        transferPairs++;
      } else {
        skipped++;
      }
      continue;
    }

    // Dedup by (date, amount) on both DATA and VALUTA with payee overlap.
    // Older imports dated some rows by VALUTA and payees were retitled in the
    // UI, so this catches duplicates the importId scheme alone would miss.
    const payeeKey = payeeName.toLowerCase();
    const matchOn = (d: string | null): boolean => {
      if (!d) return false;
      const names = dbDateAmount.get(`${d}|${amount}`);
      if (!names) return false;
      return names.some((n) => n === payeeKey || n.includes(payeeKey) || payeeKey.includes(n));
    };
    const valutaDate = row.valuta ? parseEuDate(row.valuta) : null;
    if (matchOn(date) || matchOn(valutaDate)) {
      skipped++;
      continue;
    }

    // importId: base scheme, plus a memo (POS timestamp) suffix to
    // disambiguate two physical rows sharing the same day/amount/payee.
    const baseId = `bvr-csv:${date}:${amount}:${payeeName}`;
    const suffixedId = memo ? `${baseId}:${memo}` : null;
    if (seen.has(baseId) || seen.has(suffixedId ?? '')) {
      skipped++;
      continue;
    }
    if (runSeen.has(baseId)) {
      // Collision within this run: a previous row already claimed baseId.
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
      memo: ruleRes.memo !== undefined ? ruleRes.memo : (memo || null),
      cleared,
      payeeId,
      categoryId: ruleRes.categoryId ?? (isInflow ? inflowCat.id : null),
      importId,
    });
    imported++;
  }

  if (txData.length > 0) {
    await prisma.transaction.createMany({ data: txData });
  }

  return { imported, skipped, transferPairs, account: account.name };
}

async function main() {
  const csvPath = process.argv[2];
  const accountName = process.argv[3] || 'BVR';

  if (!csvPath) {
    console.error('Usage: npx tsx src/importCsv.ts <csv-path> [account-name]');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const budget = await prisma.budget.findFirst();
  if (!budget) {
    console.error('No budget found — run `npm run seed` first.');
    await prisma.$disconnect();
    process.exit(1);
  }

  const text = fs.readFileSync(csvPath, 'utf8');
  try {
    const r = await importBankCsv(prisma, budget.id, accountName, text);
    console.log(
      `Imported ${r.imported} transactions into "${r.account}" (${r.transferPairs} transfer pairs; skipped ${r.skipped} summary/empty/duplicate rows).`,
    );
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
  await prisma.$disconnect();
}

// Run only when executed directly (npx tsx src/importCsv.ts ...), not when
// imported by routes/imports.ts — the module-level main() used to kill the
// server on import.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
