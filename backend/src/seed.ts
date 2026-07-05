// Seed = import the real YNAB export. Idempotent: wipes existing budgets first.
// Override the export location with YNAB_EXPORT_DIR or argv[2].

import { PrismaClient } from '@prisma/client';
import { importYnabExport, DEFAULT_TRACKING } from './importYnab';

const DIR =
  process.argv[2] ||
  process.env.YNAB_EXPORT_DIR ||
  '/Users/user/Downloads/YNAB Export - My Budget as of 2026-06-28 21-01';

async function main() {
  const prisma = new PrismaClient();
  await prisma.budget.deleteMany({}); // cascades to all data
  const id = await importYnabExport(DIR, prisma, { trackingAccounts: DEFAULT_TRACKING });
  console.log(`\nSeeded budget ${id}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
