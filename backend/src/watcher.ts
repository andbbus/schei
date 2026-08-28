// Folder watcher — poor man's bank sync. When IMPORT_WATCH_DIR is set the
// server watches that folder for new .csv files, sniffs the dialect, applies
// payee rules + dedup, and imports into the matching account. Account
// resolution: the file name must START with the account name
// ("Account_2026-08.csv"), else IMPORT_WATCH_ACCOUNT is used. Processed
// files move to <dir>/imported/ (or <dir>/review/ when confidence is low) so
// fs.watch never re-fires on the same rows.

import fs from 'node:fs';
import path from 'node:path';
import { prisma } from './db';
import { getBudgetOrThrow } from './engineLoad';
import { sniffCsv, parseCsvRows } from './csvSniff';
import { importGenericRows } from './importGeneric';

const IN_FLIGHT = new Set<string>();
const DEBOUNCE_MS = 1500;

export function startWatcher(dir: string): void {
  fs.mkdirSync(path.join(dir, 'imported'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'review'), { recursive: true });
  fs.watch(dir, (_evt, filename) => {
    const name = filename ? String(filename) : '';
    if (!name.toLowerCase().endsWith('.csv')) return;
    const full = path.join(dir, name);
    if (IN_FLIGHT.has(full)) return;
    IN_FLIGHT.add(full);
    setTimeout(() => {
      processFile(dir, full)
        .catch((e) => console.error(`[watcher] ${name}: ${e instanceof Error ? e.message : e}`))
        .finally(() => IN_FLIGHT.delete(full));
    }, DEBOUNCE_MS);
  });
  console.log(`[watcher] watching ${dir} for bank CSVs`);
}

async function processFile(dir: string, full: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 300)); // let the write settle
  let text: string;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch {
    return; // file vanished (moved/deleted) — nothing to do
  }
  const base = path.basename(full);
  const budget = await getBudgetOrThrow();

  const accounts = await prisma.account.findMany({ where: { budgetId: budget.id } });
  const stem = base.replace(/\.csv$/i, '');
  const acc =
    accounts.find((a) => stem.toLowerCase().startsWith(a.name.toLowerCase())) ??
    (process.env.IMPORT_WATCH_ACCOUNT
      ? accounts.find((a) => a.name.toLowerCase() === process.env.IMPORT_WATCH_ACCOUNT!.toLowerCase())
      : undefined);
  if (!acc) {
    console.log(`[watcher] ${base}: no matching account (name the file after the account, or set IMPORT_WATCH_ACCOUNT) — moved to review/`);
    fs.renameSync(full, path.join(dir, 'review', base));
    return;
  }

  const spec = sniffCsv(text);
  const rows = parseCsvRows(text, spec);
  if (spec.confidence < 0.5 || rows.length === 0) {
    console.log(`[watcher] ${base}: low confidence (${spec.confidence.toFixed(2)}) or ${rows.length} rows — moved to review/`);
    fs.renameSync(full, path.join(dir, 'review', base));
    return;
  }

  const r = await importGenericRows(prisma, budget.id, acc.name, rows);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.renameSync(full, path.join(dir, 'imported', `${stamp}-${base}`));
  console.log(`[watcher] ${base}: imported ${r.imported} into "${acc.name}" (skipped ${r.skipped})`);
}
