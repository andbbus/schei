import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import Fastify, { FastifyInstance } from 'fastify';
import settingsRoutes from './settings';

const DB = `/tmp/schei-settings-test-${Date.now()}.db`;
process.env.DATABASE_URL = `file:${DB}`;
const ENV = `/tmp/schei-settings-test-${Date.now()}.env`;
process.env.SETUP_ENV_FILE = ENV;
for (const k of [
  'AGENTMAIL_API_KEY', 'AGENTMAIL_API_KEY_FILE', 'AGENTMAIL_INBOX',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
  'SHOPPING_EMAIL_TO', 'DIGEST_TO', 'DIGEST_ENABLED',
]) {
  delete process.env[k];
}
execSync('npx prisma db push --skip-generate', { cwd: process.cwd() });

let app: FastifyInstance;

const get = async (url: string) => app.inject({ method: 'GET', url: `/api${url}` });
const post = async (url: string, payload?: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api${url}`, payload });

async function test() {
  app = Fastify();
  await app.register(settingsRoutes, { prefix: '/api' });
  await app.ready();

  // empty state
  let s = (await get('/settings/email')).json();
  assert.equal(s.provider, null);
  assert.equal(s.digestEnabled, false);
  assert.equal(s.recipient, null);

  // validation: bad recipient
  let r = await post('/settings/email', { provider: 'smtp', recipient: 'nope' });
  assert.equal(r.statusCode, 400);

  // validation: smtp without host
  r = await post('/settings/email', { provider: 'smtp', recipient: 'me@example.com' });
  assert.equal(r.statusCode, 400);

  // validation: agentmail without key or inbox
  r = await post('/settings/email', { provider: 'agentmail', recipient: 'me@example.com', agentmailApiKey: 'k', agentmailInbox: '' });
  assert.equal(r.statusCode, 400);
  r = await post('/settings/email', { provider: 'agentmail', recipient: 'me@example.com', agentmailInbox: 'x' });
  assert.equal(r.statusCode, 400);

  // configure agentmail
  r = await post('/settings/email', {
    provider: 'agentmail',
    recipient: 'me@example.com',
    agentmailApiKey: 'secret-key-1234',
    agentmailInbox: 'my-inbox',
    digestEnabled: true,
  });
  assert.equal(r.statusCode, 200);
  s = r.json();
  assert.equal(s.provider, 'agentmail');
  assert.equal(s.digestEnabled, true);
  assert.equal(s.recipient, 'me@example.com');
  assert.equal(s.inbox, 'my-inbox');
  assert.equal(s.agentKeyTail, '1234');
  assert.ok(!('agentmailApiKey' in s), 'raw key must never be returned');

  // env file + live env both updated; other channel neutralized
  const { readFileSync } = await import('node:fs');
  const file = readFileSync(ENV, 'utf8');
  assert.ok(file.includes('AGENTMAIL_API_KEY=secret-key-1234'));
  assert.ok(file.includes('DIGEST_ENABLED=1'));
  assert.ok(file.includes('DIGEST_TO=me@example.com'));
  assert.equal(process.env.AGENTMAIL_API_KEY, 'secret-key-1234');
  assert.equal(process.env.SMTP_HOST, '');

  // re-save without retyping the key: blank keeps it
  r = await post('/settings/email', {
    provider: 'agentmail',
    recipient: 'other@example.com',
    agentmailInbox: 'my-inbox',
    digestEnabled: false,
  });
  assert.equal(r.statusCode, 200);
  assert.equal(process.env.AGENTMAIL_API_KEY, 'secret-key-1234');
  assert.equal(process.env.DIGEST_ENABLED, '0');

  // switch to smtp: agentmail keys cleared, pass keep/clear semantics
  r = await post('/settings/email', {
    provider: 'smtp',
    recipient: 'me@example.com',
    smtpHost: 'smtp.example.com',
    smtpUser: 'me@example.com',
    smtpPass: 'p4ss',
    digestEnabled: true,
  });
  assert.equal(r.statusCode, 200);
  s = r.json();
  assert.equal(s.provider, 'smtp');
  assert.equal(s.smtp.host, 'smtp.example.com');
  assert.equal(s.smtp.port, 587);
  assert.equal(s.smtp.passTail, 'p4ss');
  assert.equal(s.agentKeyTail, null);
  assert.equal(process.env.AGENTMAIL_API_KEY, '');
  assert.equal(process.env.SMTP_SECURE, 'false');

  // test endpoint: provider configured but SMTP connect fails → 502 with message
  r = await post('/settings/email/test');
  assert.equal(r.statusCode, 502);
  assert.ok((r.json() as { error: string }).error.length > 0);

  // test endpoint unconfigured → 400
  r = await post('/settings/email', { provider: 'none', recipient: 'me@example.com' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().provider, null);
  assert.equal(process.env.DIGEST_ENABLED, '0');
  r = await post('/settings/email/test');
  assert.equal(r.statusCode, 400);

  await app.close();
  rmSync(DB, { force: true });
  rmSync(ENV, { force: true });
  for (const k of ['AGENTMAIL_API_KEY', 'AGENTMAIL_INBOX', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SHOPPING_EMAIL_TO', 'DIGEST_TO', 'DIGEST_ENABLED']) {
    delete process.env[k];
  }
  console.log('settings: ok');
}

test().catch((e) => {
  console.error(e);
  process.exit(1);
});
