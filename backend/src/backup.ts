// Database backup helper. Copies dev.db to backups/ with a timestamped name
// and prunes old snapshots. Best-effort: callers must not fail when backups
// are unavailable (e.g. read-only filesystems, tests).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path.join(ROOT, 'prisma', 'dev.db');
const DIR = path.join(ROOT, '..', 'backups');
const KEEP = 30;

export function backupDb(label?: string): string | null {
  try {
    if (!fs.existsSync(DB)) return null;
    fs.mkdirSync(DIR, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
    const name = `dev-${stamp}${label ? '-' + label : ''}.db`;
    fs.copyFileSync(DB, path.join(DIR, name));
    const snaps = fs
      .readdirSync(DIR)
      .filter((f) => f.startsWith('dev-') && f.endsWith('.db'))
      .sort();
    for (const old of snaps.slice(0, Math.max(0, snaps.length - KEEP))) {
      fs.rmSync(path.join(DIR, old), { force: true });
    }
    return name;
  } catch (e) {
    console.warn(`backupDb: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
