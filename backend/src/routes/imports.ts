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

export default async function importRoutes(app: FastifyInstance) {
  // MainBank / BVR format (DATA;VALUTA;DARE;AVERE;...).
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
}
