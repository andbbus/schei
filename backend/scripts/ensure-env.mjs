// Seeds backend/.env from .env.example on fresh clones. The file is
// gitignored (it holds API keys), but Prisma refuses to start without
// DATABASE_URL — so every npm script that touches the DB or the server
// runs this first. Never overwrites an existing .env.
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = join(here, '..', '.env');
const exampleFile = join(here, '..', '.env.example');

if (existsSync(envFile)) process.exit(0);

if (existsSync(exampleFile)) {
  copyFileSync(exampleFile, envFile);
} else {
  // No example available (partial checkout?) — write the bare minimum.
  writeFileSync(envFile, `DATABASE_URL="file:./dev.db"\nPORT=${process.env.PORT ?? '3001'}\n`);
}

console.log('▸ Created backend/.env from .env.example (DATABASE_URL ready; API keys can be added later — the wizard writes them for you).');
