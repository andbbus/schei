// Import a Trade Republic "Transaction export" CSV (TR app → Profile →
// Transaction export) into the IMPORT_TR_ACCOUNT account. Comma-separated,
// quoted, ISO dates, dot decimals, one row per cash movement with TR's own
// transaction_id. Replaces the old hand-built DATA;IMPORTO;PAYEE;MEMO CSV.
//
// Cash effect of a row = amount + fee + tax (interest and dividends land net
// of withholding; stamp-duty rows carry amount 0 and the charge in `tax`).
//
// Rows already in the register are recognised, in this order:
//   1. importId `tr-export:<transaction_id>` (written by an earlier run)
//   2. same amount on the account within ±4 days, any payee — hand-entered or
//      schedule-materialized rows drift in name and date, not in amount
//   3. two card rows summing to one register row (±2 days, similar payee):
//      two payments at the same shop entered as one
//   4. similar payee, amount within 3%, ±3 days: FX card charges vs estimates
// Everything else is new. Payee = merchant / counterparty (an existing payee
// is reused case-insensitively), then payee rules (rename / category / notes);
// category = rule → the payee's dominant past category (≥3 rows, ≥60%, the
// same gate as the learning offer) → Ready to Assign for inflows → none.
// Transfers whose description (it carries the counterparty IBAN) matches
// IMPORT_TRANSFER_RULES become linked transfer pairs.
//
// Usage: npx tsx src/importTradeRepublic.ts <csv-path>

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { splitLine } from './csvSniff';
import { normalizePayeeName } from './engine/similarity';
import { derivePatch, SYSTEM_PAYEES } from './engine/payeeRules';
import { TRANSFER_RULES } from './importCsv';
import { createTransaction } from './routes/register';

const DAY = 86_400_000;
const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / DAY;
const shift = (d: string, k: number) => new Date(Date.parse(d) + k * DAY).toISOString().slice(0, 10);

export interface TrRow {
  id: string;
  date: string;
  type: string;
  name: string;
  net: number; // milliunits, signed
  description: string;
  counterparty: string;
  reference: string;
}

const REQUIRED = ['date', 'type', 'name', 'amount', 'fee', 'tax', 'description', 'transaction_id'];

// "-21.420000" → -21420. Exact decimal parse (no float), 3 fractional digits kept.
function milli(s: string): number {
  const m = s.trim().match(/^(-?)(\d*)(?:\.(\d*))?$/);
  if (!m || (!m[2] && !m[3])) return 0;
  return (m[1] ? -1 : 1) * (Number(m[2] || 0) * 1000 + Number((m[3] ?? '').padEnd(3, '0').slice(0, 3)));
}

export function parseTrExport(text: string): TrRow[] {
  const lines = text.replace(/^﻿/, '').replace(/\r/g, '').split('\n').filter((l) => l.trim());
  if (lines.length === 0) return [];
  const header = splitLine(lines[0], ',');
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const missing = REQUIRED.filter((c) => col[c] === undefined);
  if (missing.length) throw new Error(`Not a Trade Republic transaction export (missing column: ${missing.join(', ')}).`);
  return lines.slice(1).map((line) => {
    const c = splitLine(line, ',');
    const get = (k: string) => (col[k] === undefined ? '' : c[col[k]] ?? '');
    return {
      id: get('transaction_id'),
      date: get('date'),
      type: get('type'),
      name: get('name'),
      net: milli(get('amount')) + milli(get('fee')) + milli(get('tax')),
      description: get('description'),
      counterparty: get('counterparty_name'),
      reference: get('payment_reference'),
    };
  });
}

export function payeeOf(r: TrRow): string {
  if (r.type === 'INTEREST_PAYMENT') return 'Trade Republic Interest';
  // direct debits list the account holder as counterparty; the creditor is in the text
  const dd = r.description.match(/^Sepa Direct Debit transfer to (.+)$/i);
  if (dd) return dd[1].replace(/\s*\([A-Z]{2}\d{2}[A-Z0-9]{8,}\)$/, '').trim(); // drop the trailing (IBAN)
  return r.name || r.counterparty || 'Trade Republic';
}

export function memoOf(r: TrRow): string | null {
  if (r.type.startsWith('CARD')) {
    // FX card rows: "MERCHANT, 10,00 $, exchange rate: …" → keep the FX details
    const i = r.description.indexOf(', ');
    return i > 0 ? r.description.slice(i + 2) : null;
  }
  if (r.type.startsWith('TRANSFER')) return r.reference || null;
  if (r.type === 'INTEREST_PAYMENT') return null;
  return r.description || null;
}

export function similarPayee(a: string, b: string): boolean {
  const x = normalizePayeeName(a);
  const y = normalizePayeeName(b);
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x) || x.split(/[\s*]/)[0] === y.split(/[\s*]/)[0];
}

export interface ExistingRow {
  id: string;
  date: string;
  amount: number;
  payee: string;
  importId: string | null;
}

// The CSV rows NOT already in the register (see the header for the passes).
export function matchExisting(rows: TrRow[], existing: ExistingRow[]): TrRow[] {
  const done = new Set(existing.map((e) => e.importId).filter((i) => i?.startsWith('tr-export:')));
  // rows this importer wrote are matched by id only — never claimed by another CSV row
  const pool = existing.filter((e) => !SYSTEM_PAYEES.has(e.payee) && !e.importId?.startsWith('tr-export:'));
  const claimed = new Set<string>();
  const claim = (r: TrRow, ok: (e: ExistingRow) => boolean) => {
    const hit = pool
      .filter((e) => !claimed.has(e.id) && ok(e))
      .sort((a, b) => days(a.date, r.date) - days(b.date, r.date))[0];
    if (hit) claimed.add(hit.id);
    return !!hit;
  };

  let open = rows.filter((r) => r.net !== 0 && !done.has(`tr-export:${r.id}`));
  open = open.filter((r) => !claim(r, (e) => e.amount === r.net && days(e.date, r.date) <= 4));

  // ponytail: O(pool × open²) pair search; fine for monthly exports (~100 rows)
  const paired = new Set<string>();
  for (const e of pool) {
    if (claimed.has(e.id)) continue;
    const near = open.filter((r) => !paired.has(r.id) && days(r.date, e.date) <= 2 && similarPayee(payeeOf(r), e.payee));
    outer: for (let i = 0; i < near.length; i++)
      for (let j = i + 1; j < near.length; j++)
        if (near[i].net + near[j].net === e.amount) {
          claimed.add(e.id);
          paired.add(near[i].id).add(near[j].id);
          break outer;
        }
  }
  open = open.filter((r) => !paired.has(r.id));

  return open.filter(
    (r) =>
      !claim(
        r,
        (e) =>
          Math.sign(e.amount) === Math.sign(r.net) &&
          Math.abs(e.amount - r.net) <= Math.abs(r.net) * 0.03 &&
          days(e.date, r.date) <= 3 &&
          similarPayee(e.payee, payeeOf(r)),
      ),
  );
}

export interface ImportResult {
  imported: number;
  skipped: number; // already in the register, or zero-amount rows
  uncategorized: number;
  account: string;
}

export async function importTradeRepublicCsv(prisma: PrismaClient, budgetId: string, text: string): Promise<ImportResult> {
  const accountName = process.env.IMPORT_TR_ACCOUNT;
  if (!accountName) throw new Error('Set IMPORT_TR_ACCOUNT in backend/.env to the Trade Republic account name.');
  const account = await prisma.account.findFirst({ where: { budgetId, name: accountName } });
  if (!account) throw new Error(`Account "${accountName}" not found.`);
  const inflowCat = await prisma.category.findFirst({ where: { budgetId, isInflow: true } });
  if (!inflowCat) throw new Error('No inflow (Ready to Assign) category found.');

  const rows = parseTrExport(text);
  if (rows.length === 0) return { imported: 0, skipped: 0, uncategorized: 0, account: account.name };
  const dates = rows.map((r) => r.date).sort();
  const existing = await prisma.transaction.findMany({
    where: { accountId: account.id, deleted: false, date: { gte: shift(dates[0], -4), lte: shift(dates[dates.length - 1], 4) } },
    select: { id: true, date: true, amount: true, importId: true, payee: { select: { name: true } } },
  });
  const fresh = matchExisting(
    rows,
    existing.map((e) => ({ id: e.id, date: e.date, amount: e.amount, importId: e.importId, payee: e.payee?.name ?? '' })),
  );

  const [ruleRows, liveCats, payees, history, accounts] = await Promise.all([
    prisma.payeeRule.findMany({ where: { budgetId } }),
    prisma.category.findMany({ where: { budgetId, deleted: false }, select: { id: true } }),
    prisma.payee.findMany({ where: { budgetId, transferAccountId: null }, select: { id: true, name: true } }),
    prisma.transaction.groupBy({
      by: ['payeeId', 'categoryId'],
      where: { budgetId, deleted: false, transferAccountId: null, payeeId: { not: null }, categoryId: { not: null } },
      _count: { _all: true },
    }),
    prisma.account.findMany({ where: { budgetId }, select: { id: true, name: true } }),
  ]);
  const liveIds = new Set(liveCats.map((c) => c.id));
  const byName = new Map<string, { id: string; name: string }>();
  for (const p of payees) if (!byName.has(p.name.toLowerCase())) byName.set(p.name.toLowerCase(), p);
  // dominant past category per payee: ≥3 rows and ≥60% (same gate as /rules/learning-offer)
  const counts = new Map<string, Map<string, number>>();
  for (const h of history) {
    const m = counts.get(h.payeeId!) ?? new Map<string, number>();
    m.set(h.categoryId!, h._count._all);
    counts.set(h.payeeId!, m);
  }
  const dominant = (payeeId: string): string | null => {
    const m = counts.get(payeeId);
    if (!m) return null;
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const [top, n] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    return n >= 3 && n / total >= 0.6 && liveIds.has(top) ? top : null;
  };

  let uncategorized = 0;
  await prisma.$transaction(
    async (tx) => {
      for (const r of fresh) {
        const importId = `tr-export:${r.id}`;
        const memo = memoOf(r);
        const rule = r.type.startsWith('TRANSFER') ? TRANSFER_RULES.find((t) => t.match.test(r.description)) : undefined;
        if (rule) {
          const target = accounts.find((a) => a.name === rule.account);
          if (!target) throw new Error(`Transfer account "${rule.account}" not found.`);
          await createTransaction(
            budgetId,
            { accountId: account.id, date: r.date, amount: r.net, memo, cleared: 'cleared', transferAccountId: target.id, importId },
            tx,
          );
          continue;
        }
        const raw = payeeOf(r);
        const name = byName.get(raw.toLowerCase())?.name ?? raw;
        const patch = derivePatch({ payeeName: name, accountId: account.id, memo }, ruleRows, liveIds);
        const finalName = patch.payeeName ? byName.get(patch.payeeName.toLowerCase())?.name ?? patch.payeeName : name;
        let payee = byName.get(finalName.toLowerCase());
        if (!payee) {
          payee = await tx.payee.create({ data: { budgetId, name: finalName }, select: { id: true, name: true } });
          byName.set(finalName.toLowerCase(), payee);
        }
        const categoryId = patch.categoryId ?? dominant(payee.id) ?? (r.net > 0 ? inflowCat.id : null);
        if (!categoryId) uncategorized++;
        await tx.transaction.create({
          data: {
            budgetId,
            accountId: account.id,
            date: r.date,
            amount: r.net,
            memo: patch.memo !== undefined ? patch.memo : memo,
            cleared: 'cleared',
            payeeId: payee.id,
            categoryId,
            importId,
          },
        });
      }
    },
    { timeout: 60_000 },
  );

  return { imported: fresh.length, skipped: rows.length - fresh.length, uncategorized, account: account.name };
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
    console.log(
      `Imported ${r.imported} transactions into "${r.account}" (${r.skipped} already in the register, ${r.uncategorized} uncategorized).`,
    );
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
