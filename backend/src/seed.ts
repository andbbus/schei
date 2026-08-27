// Seed = import the real YNAB export. Idempotent: wipes existing budgets first.
// Override the export location with YNAB_EXPORT_DIR or argv[2].

import { PrismaClient } from '@prisma/client';
import { importYnabExport, DEFAULT_TRACKING } from './importYnab';
import { backupDb } from './backup';

const args = process.argv.slice(2).filter((a) => a !== '--force');
const DIR =
  args[0] ||
  process.env.YNAB_EXPORT_DIR ||
  '/Users/user/Downloads/YNAB Export - My Budget as of 2026-06-28 21-01';

async function main() {
  const prisma = new PrismaClient();
  // The clone is the primary financial record: refuse to wipe silently.
  const existing = await prisma.budget.count();
  if (existing > 0 && !process.argv.includes('--force')) {
    console.error(
      'Refusing to overwrite: the database already holds a budget with live data.\n' +
        'Re-importing WIPES everything entered in the app. If you really mean it:\n' +
        '  npm run seed -- --force',
    );
    await prisma.$disconnect();
    process.exit(1);
  }
  if (existing > 0 && process.argv.includes('--force')) {
    const name = backupDb('pre-seed');
    console.log(name ? `Backup: backups/${name}` : 'Backup unavailable — proceeding without a snapshot.');
  }
  await prisma.budget.deleteMany({}); // cascades to all data
  const id = await importYnabExport(DIR, prisma, { trackingAccounts: DEFAULT_TRACKING });
  console.log(`\nSeeded budget ${id}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
