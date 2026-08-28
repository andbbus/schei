// In-app file imports (drag & drop CSV in the UI). These mirror the CLI
// importers exactly — same parsers, same dedup, same categorization — and take
// a timestamped backup of dev.db before writing (item 7 of the tightening
// batch: you can no longer import without a snapshot on disk).

import { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { getBudgetOrThrow } from '../engineLoad';
import { backupDb } from '../backup';
import { importBankCsv } from '../importCsv';
import { importTradeRepublicCsv } from '../importTradeRepublic';
import { sniffCsv, parseCsvRows, CsvSpec } from '../csvSniff';
import { importGenericRows } from '../importGeneric';

export default async function importRoutes(app: FastifyInstance) {
  // BVR bank format (DATA;VALUTA;DARE;AVERE;...).
  app.post('/import/csv', async (req, reply) => {
    const b = req.body as { csv?: string; accountName?: string };
    const budget = await getBudgetOrThrow();
    if (!b.csv || !b.csv.trim()) return reply.code(400).send({ error: 'csv is required.' });
    const accountName = b.accountName?.trim();
    if (!accountName) return reply.code(400).send({ error: 'accountName is required.' });

    const backup = backupDb('pre-import');
    let result;
    try {
      result = await importBankCsv(prisma, budget.id, accountName, b.csv);
    } catch (e) {
      return reply.code(404).send({ error: e instanceof Error ? e.message : 'Import failed.' });
    }
    return { ...result, backup };
  });

  // Trade Republic statement format (DATA;IMPORTO;PAYEE;MEMO).
  app.post('/import/tr-csv', async (req, reply) => {
    const b = req.body as { csv?: string };
    const budget = await getBudgetOrThrow();
    if (!b.csv || !b.csv.trim()) return reply.code(400).send({ error: 'csv is required.' });

    const backup = backupDb('pre-import-tr');
    let result;
    try {
      result = await importTradeRepublicCsv(prisma, budget.id, b.csv);
    } catch (e) {
      return reply.code(404).send({ error: e instanceof Error ? e.message : 'Import failed.' });
    }
    return { ...result, backup };
  });

  // Generic auto-detected import: sniff the dialect, preview the normalized
  // rows, then commit. `spec` (from the preview call) can carry user overrides
  // (column mapping / date order / decimal) chosen in the UI.
  app.post('/import/auto', async (req, reply) => {
    const b = req.body as {
      csv?: string;
      mode?: 'preview' | 'commit';
      accountName?: string;
      spec?: Partial<CsvSpec>;
    };
    const budget = await getBudgetOrThrow();
    if (!b.csv || !b.csv.trim()) return reply.code(400).send({ error: 'csv is required.' });

    const sniffed = sniffCsv(b.csv);
    const spec: CsvSpec = { ...sniffed, ...(b.spec ?? {}) };
    const rows = parseCsvRows(b.csv, spec);
    if (b.mode !== 'commit') {
      return {
        spec,
        count: rows.length,
        net: rows.reduce((s, r) => s + r.amount, 0),
        preview: rows.slice(0, 10),
      };
    }
    const accountName = b.accountName?.trim();
    if (!accountName) return reply.code(400).send({ error: 'accountName is required for commit.' });
    if (rows.length === 0) return reply.code(400).send({ error: 'No importable rows found — check the column mapping.' });

    const backup = backupDb('pre-import-auto');
    let result;
    try {
      result = await importGenericRows(prisma, budget.id, accountName, rows);
    } catch (e) {
      return reply.code(404).send({ error: e instanceof Error ? e.message : 'Import failed.' });
    }
    return { ...result, backup, spec };
  });
}
