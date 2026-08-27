// AI chat route tests: session lifecycle, message persistence, budget-context
// system prompt, upstream error mapping. The upstream gateway is a local mock
// http server (CHAT_BASE_URL points at it) — no real network in tests.

import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import Fastify, { FastifyInstance } from 'fastify';
import chatRoutes from './chat';

process.env.CHAT_API_KEY = 'test-key';
delete process.env.CHAT_MODEL;

const DB = `/tmp/ynab-chat-test-${Date.now()}.db`;
process.env.DATABASE_URL = `file:${DB}`;
execSync('npx prisma db push --skip-generate', { cwd: process.cwd() });

import { prisma } from '../db';

let app: FastifyInstance;
let budgetId: string;
let sessionId: string;

// ---- mock gateway ----
const received: { messages: { role: string; content: string }[]; model: string }[] = [];
let upstreamMode: 'ok' | 'boom' = 'ok';

const mock = createServer((req: IncomingMessage, res: ServerResponse) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    if (upstreamMode === 'boom') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'upstream exploded' } }));
      return;
    }
    received.push({ messages: parsed.messages ?? [], model: parsed.model });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'mock-1',
        object: 'chat.completion',
        model: parsed.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'MOCK REPLY' } }],
      }),
    );
  });
});
await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
const addr = mock.address() as { port: number };
process.env.CHAT_BASE_URL = `http://127.0.0.1:${addr.port}`;
process.env.CHAT_API_KEY = 'test-key';

const post = async (url: string, payload?: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api${url}`, payload });

export async function test() {
  const budget = await prisma.budget.create({ data: { name: 'Chat Budget', firstMonth: '2026-01-01', lastMonth: '2026-12-01' } });
  budgetId = budget.id;

  app = Fastify();
  await app.register(chatRoutes, { prefix: '/api' });

  // ---- status ----
  const status = (await app.inject({ method: 'GET', url: '/api/chat/status' })).json();
  assert.equal(status.configured, true);
  assert.equal(status.defaultModel, 'deepseek-v4-flash');

  // ---- create session (defaults) ----
  const created = (await post('/chat/sessions', {})).json();
  assert.equal(created.title, 'New chat');
  assert.equal(created.model, 'deepseek-v4-flash');
  sessionId = created.id;

  // custom model on a second session
  const custom = (await post('/chat/sessions', { model: 'glm-5.3' })).json();
  assert.equal(custom.model, 'glm-5.3');
  const badModel = await post('/chat/sessions', { model: 'bad model!' });
  assert.equal(badModel.statusCode, 400);

  // ---- unconfigured guard ----
  const savedKey = process.env.CHAT_API_KEY;
  delete process.env.CHAT_API_KEY;
  const unconf = await post(`/chat/sessions/${sessionId}/messages`, { content: 'hi' });
  assert.equal(unconf.statusCode, 409);
  process.env.CHAT_API_KEY = savedKey;

  // ---- message roundtrip: user + assistant persisted, context injected ----
  const r = await post(`/chat/sessions/${sessionId}/messages`, { content: 'How much is left for rent?' });
  assert.equal(r.statusCode, 200, r.body);
  const { user, assistant } = r.json();
  assert.equal(user.role, 'user');
  assert.equal(assistant.content, 'MOCK REPLY');

  assert.equal(received.length, 1);
  const sent = received[0];
  assert.equal(sent.model, 'deepseek-v4-flash');
  assert.equal(sent.messages[0].role, 'system');
  assert.ok(sent.messages[0].content.includes('Chat Budget'), 'system prompt carries budget snapshot');
  assert.ok(sent.messages[0].content.includes('Ready to Assign'), 'system prompt carries RTA');
  assert.equal(sent.messages[sent.messages.length - 1].content, 'How much is left for rent?');

  // history grows for the second turn
  await post(`/chat/sessions/${sessionId}/messages`, { content: 'and for groceries?' });
  assert.equal(received[1].messages.filter((m) => m.role === 'user').length, 2);

  // ---- persistence + auto-title ----
  const msgs = (await app.inject({ method: 'GET', url: `/api/chat/sessions/${sessionId}/messages` })).json();
  assert.equal(msgs.length, 4);
  assert.deepEqual(msgs.map((m: { role: string }) => m.role), ['user', 'assistant', 'user', 'assistant']);
  const session = await prisma.chatSession.findUniqueOrThrow({ where: { id: sessionId } });
  assert.equal(session.title, 'How much is left for rent?');

  // ---- sessions list includes lastMessage ----
  const list = (await app.inject({ method: 'GET', url: '/api/chat/sessions' })).json();
  const row = list.find((s: { id: string }) => s.id === sessionId);
  assert.equal(row.lastMessage, 'MOCK REPLY');

  // ---- upstream failure → 502 { error }, user msg kept for retry ----
  upstreamMode = 'boom';
  const fail = await post(`/chat/sessions/${sessionId}/messages`, { content: 'this will fail' });
  assert.equal(fail.statusCode, 502);
  assert.match(fail.json().error, /upstream exploded/);
  const afterFail = (await app.inject({ method: 'GET', url: `/api/chat/sessions/${sessionId}/messages` })).json();
  assert.equal(afterFail[afterFail.length - 1].role, 'user');
  assert.equal(afterFail[afterFail.length - 1].content, 'this will fail');
  upstreamMode = 'ok';

  // ---- delete cascades ----
  const del = await app.inject({ method: 'DELETE', url: `/api/chat/sessions/${sessionId}` });
  assert.equal(del.statusCode, 200);
  assert.equal(await prisma.chatMessage.count({ where: { sessionId } }), 0);
  assert.equal((await app.inject({ method: 'GET', url: `/api/chat/sessions/${sessionId}/messages` })).statusCode, 404);

  // rename path
  const ren = await app.inject({ method: 'PATCH', url: `/api/chat/sessions/${custom.id}`, payload: { title: 'Budget Q&A' } });
  assert.equal(ren.statusCode, 200);
  assert.equal(ren.json().title, 'Budget Q&A');
}

test()
  .then(() => {
    mock.close();
    console.log('chat: ok');
  })
  .catch((e) => {
    mock.close();
    console.error(e);
    process.exit(1);
  });
