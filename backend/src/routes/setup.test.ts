// First-run setup wizard route tests: status → budget creation (+ required
// Inflow category, starter categories) → 409 guard, chat config persisted to
// a temp .env and live-applied, provider probe against a mock gateway.
// Run via `npm test` (tsx). Never touches dev.db or the real .env.

import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import Fastify, { FastifyInstance } from 'fastify';
import setupRoutes from './setup';

const DB = `/tmp/ynab-setup-test-${Date.now()}.db`;
process.env.DATABASE_URL = `file:${DB}`;
const ENV = `/tmp/ynab-setup-test-${Date.now()}.env`;
process.env.SETUP_ENV_FILE = ENV;
delete process.env.CHAT_API_KEY;
delete process.env.CHAT_BASE_URL;
delete process.env.CHAT_MODEL;
execSync('npx prisma db push --skip-generate', { cwd: process.cwd() });

import { prisma } from '../db';

let app: FastifyInstance;

// mock provider gateway (OpenAI-compatible)
const mock = createServer((req: IncomingMessage, res: ServerResponse) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    const fail = parsed.model === 'bad-model';
    res.writeHead(fail ? 401 : 200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        fail
          ? { error: { message: 'invalid key' } }
          : { choices: [{ message: { role: 'assistant', content: 'ok' } }] },
      ),
    );
  });
});
await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
const addr = mock.address() as { port: number };

const post = async (url: string, payload?: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api${url}`, payload });

export async function test() {
  app = Fastify();
  await app.register(setupRoutes, { prefix: '/api' });

  // ---- status: fresh install ----
  let status = (await app.inject({ method: 'GET', url: '/api/setup/status' })).json();
  assert.equal(status.hasBudget, false);
  assert.equal(status.chat.configured, false);

  // ---- budget creation: always writes the structural Inflow category ----
  const created = await post('/setup/budget', {
    name: 'Fresh Budget',
    currencySymbol: '€',
    locale: 'it-IT',
    starterCategories: true,
  });
  assert.equal(created.statusCode, 200, created.body);
  const budget = await prisma.budget.findFirstOrThrow();
  assert.equal(budget.name, 'Fresh Budget');
  assert.equal(budget.locale, 'it-IT');
  const inflow = await prisma.category.findFirstOrThrow({ where: { budgetId: budget.id, isInflow: true } });
  assert.match(inflow.name, /Ready to Assign/);
  const cats = await prisma.category.count({ where: { budgetId: budget.id } });
  assert.equal(cats, 1 + 11, 'inflow + 11 starter categories');
  // two years of months derived from firstMonth
  assert.equal(budget.firstMonth.slice(0, 7), new Date().toISOString().slice(0, 7));
  assert.ok(budget.lastMonth > budget.firstMonth);

  // ---- guard: second budget refused ----
  const again = await post('/setup/budget', { name: 'Nope' });
  assert.equal(again.statusCode, 409);

  // ---- status reflects budget + default chat ----
  status = (await app.inject({ method: 'GET', url: '/api/setup/status' })).json();
  assert.equal(status.hasBudget, true);
  assert.equal(status.chat.model, 'deepseek-v4-flash'); // built-in default

  // ---- chat config: write + live-apply, key never echoed ----
  const cfg = await post('/setup/chat', {
    baseUrl: `http://127.0.0.1:${addr.port}/v1/`,
    model: 'test-model',
    apiKey: 'sk-test-1234567890',
  });
  assert.equal(cfg.statusCode, 200, cfg.body);
  assert.equal(cfg.json().configured, true);
  assert.equal(cfg.json().model, 'test-model');
  assert.ok(!JSON.stringify(cfg.body).includes('sk-test'), 'key material must not be echoed');
  const envText = readFileSync(ENV, 'utf8');
  assert.match(envText, /CHAT_API_KEY=sk-test-1234567890/);
  assert.match(envText, /CHAT_BASE_URL=/);
  assert.ok(!envText.includes(`${addr}/v1//`), 'trailing slash trimmed');
  status = (await app.inject({ method: 'GET', url: '/api/setup/status' })).json();
  assert.equal(status.chat.keyTail, '7890');

  // upsert preserves unrelated lines + comments
  const withComment = `${readFileSync(ENV, 'utf8')}\n# a comment\nOTHER_KEY=keepme\n`;
  writeFileSync(ENV, withComment);
  await post('/setup/chat', { model: 'second-model' });
  const env2 = readFileSync(ENV, 'utf8');
  assert.match(env2, /OTHER_KEY=keepme/);
  assert.match(env2, /# a comment/);
  assert.match(env2, /CHAT_MODEL=second-model/);

  // ---- validation ----
  assert.equal((await post('/setup/chat', { baseUrl: 'not-a-url' })).statusCode, 400);
  assert.equal((await post('/setup/chat', { apiKey: 'short' })).statusCode, 400);
  assert.equal((await post('/setup/chat', { model: 'bad model!' })).statusCode, 400);

  // ---- probe: working config ----
  const probe = await post('/setup/chat/test', {});
  assert.equal(probe.statusCode, 200, probe.body);
  assert.equal(probe.json().ok, true);
  assert.equal(probe.json().model, 'second-model');
  assert.equal(probe.json().sample, 'ok');

  // ---- probe: failing provider → 502 with the provider's message ----
  const bad = await post('/setup/chat/test', { model: 'bad-model' });
  assert.equal(bad.statusCode, 502);
  assert.match(bad.json().error, /invalid key/);

  // probe with an unconfigured key → 409
  delete process.env.CHAT_API_KEY;
  const noKey = await post('/setup/chat/test', { baseUrl: `${addr}/v1`, model: 'test-model' });
  assert.equal(noKey.statusCode, 409);

  await app.close();
  await prisma.$disconnect();
  mock.close();
  rmSync(DB, { force: true });
  rmSync(DB + '-journal', { force: true });
  if (existsSync(ENV)) rmSync(ENV, { force: true });
}

test()
  .then(() => console.log('setup: ok'))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
