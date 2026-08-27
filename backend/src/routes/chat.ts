// AI assistant chat backed by the user's opencode-go gateway (OpenAI-compatible
// /chat/completions). Sessions + messages persist in SQLite; every request
// injects a compact budget snapshot as the system prompt so the agent answers
// questions about THIS budget. Upstream errors travel as { error } 502s and
// leave the stored history intact (the user message is kept for easy retry).
//
// Config: CHAT_API_KEY (or CHAT_API_KEY_FILE — key-file pattern shared with
// the AgentMail integration), CHAT_BASE_URL (default opencode zen go/v1),
// CHAT_MODEL (default deepseek-v4-flash).

import { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { prisma } from '../db';
import { getBudgetOrThrow, loadComputation, today } from '../engineLoad';
import { monthOf } from '../engine/budget';
import { formatMilli } from '../money';

const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1';
export const DEFAULT_MODEL = process.env.CHAT_MODEL ?? 'deepseek-v4-flash';

const HISTORY_LIMIT = 40;

function apiKey(): string | null {
  if (process.env.CHAT_API_KEY) return process.env.CHAT_API_KEY;
  const file = process.env.CHAT_API_KEY_FILE;
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim();
    } catch {
      return null;
    }
  }
  return null;
}

export function chatConfigured(): boolean {
  return apiKey() !== null;
}

// Compact, token-cheap budget snapshot for the system prompt. Derived on read
// from the engine — never persists anything.
export async function buildBudgetContext(budgetId: string): Promise<string> {
  const budget = await getBudgetOrThrow();
  const { accounts, categories, comp, balances } = await loadComputation(budgetId);
  const month = monthOf(today());
  const eur = (milli: number) =>
    formatMilli(milli, { symbol: budget.currencySymbol, digits: budget.decimalDigits, locale: budget.locale });

  const acctLines = accounts
    .filter((a) => a.onBudget && !a.closed)
    .map((a) => `${a.name}: ${eur(balances[a.id]?.working ?? 0)}`)
    .join('; ');
  const rta = comp.rtaByMonth[month] ?? 0;

  const cell = new Map<string, { assigned: number; activity: number; available: number }>();
  for (const mc of comp.monthCategories) {
    if (mc.month === month) cell.set(mc.categoryId, mc);
  }
  const cats = categories
    .filter((c) => !c.isInflow)
    .map((c) => {
      const v = cell.get(c.id) ?? { assigned: 0, activity: 0, available: 0 };
      return {
        name: c.name,
        line:
          `${c.name}: assigned ${eur(v.assigned)}, activity ${eur(v.activity)}, available ${eur(v.available)}` +
          (c.goalType ? ` [target ${c.goalType}]` : ''),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const recent = await prisma.transaction.findMany({
    where: { budgetId, deleted: false, transferAccountId: null },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    take: 15,
    select: { date: true, amount: true, payee: { select: { name: true } }, categoryId: true },
  });
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  const recentLines = recent
    .map(
      (t) =>
        `${t.date} ${eur(t.amount)} ${t.payee?.name ?? '?'}${t.categoryId ? ` → ${catName.get(t.categoryId) ?? ''}` : ''}`,
    )
    .join('\n');

  const upcoming = await prisma.scheduledTransaction.findMany({
    where: { budgetId, deleted: false },
    orderBy: { nextDate: 'asc' },
    take: 12,
    select: { nextDate: true, amount: true, payee: { select: { name: true } } },
  });
  const upcomingLines = upcoming
    .map((s) => `${s.nextDate} ${eur(s.amount)} ${s.payee?.name ?? '?'}`)
    .join('; ');

  return [
    `Budget "${budget.name}", month ${month}. Currency ${budget.currencySymbol}.`,
    `Accounts (on-budget): ${acctLines || 'none'}.`,
    `Ready to Assign this month: ${eur(rta)}.`,
    'Category budgets (assigned / activity / available):',
    cats.map((c) => `- ${c.line}`).join('\n') || '- none',
    `Upcoming scheduled: ${upcomingLines || 'none'}.`,
    'Recent transactions:',
    recentLines || 'none',
  ].join('\n');
}

const SYSTEM_PROMPT = (context: string) =>
  [
    'You are the built-in assistant of a local YNAB-style budgeting app. Answer questions about the',
    "user's budget using ONLY the snapshot below plus the conversation; never invent numbers.",
    'Money is in milliunits internally; the snapshot already formats it for you. Be concise, use',
    'tables or short lists when helpful, and answer in the language the user writes in.',
    '',
    context,
  ].join('\n');

interface UpstreamOk {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string };
}

async function callUpstream(
  base: string,
  key: string,
  model: string,
  messages: { role: string; content: string }[],
): Promise<{ ok: true; content: string } | { ok: false; status: number; message: string }> {
  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, max_tokens: 2048 }),
    });
  } catch (e) {
    return { ok: false, status: 502, message: `AI gateway unreachable: ${e instanceof Error ? e.message : e}` };
  }
  let body: UpstreamOk | null = null;
  try {
    body = (await res.json()) as UpstreamOk;
  } catch {
    /* non-JSON */
  }
  const content = body?.choices?.[0]?.message?.content;
  if (!res.ok || !content) {
    const msg =
      body?.error?.message ??
      (typeof body === 'object' && body && 'error' in body
        ? String((body as { error: { message?: string } }).error?.message ?? res.statusText)
        : res.statusText);
    return { ok: false, status: res.status === 401 ? 502 : 502, message: `AI gateway error (${res.status}): ${msg}` };
  }
  return { ok: true, content };
}

export default async function chatRoutes(app: FastifyInstance) {
  const base = process.env.CHAT_BASE_URL ?? DEFAULT_BASE_URL;

  app.get('/chat/status', async () => ({ configured: chatConfigured(), defaultModel: DEFAULT_MODEL }));

  app.get('/chat/sessions', async () => {
    const budget = await getBudgetOrThrow();
    const sessions = await prisma.chatSession.findMany({
      where: { budgetId: budget.id },
      orderBy: { createdAt: 'desc' },
      include: { messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { content: true } } },
    });
    return sessions.map((s) => ({
      id: s.id,
      title: s.title,
      model: s.model,
      createdAt: s.createdAt,
      lastMessage: s.messages[0]?.content?.slice(0, 80) ?? null,
    }));
  });

  app.post('/chat/sessions', async (req, reply) => {
    const { title, model } = (req.body ?? {}) as { title?: string; model?: string };
    const budget = await getBudgetOrThrow();
    if (model !== undefined && !/^[\w.:-]{1,80}$/.test(model)) {
      return reply.code(400).send({ error: 'Invalid model id.' });
    }
    return prisma.chatSession.create({
      data: { budgetId: budget.id, title: title?.trim() || 'New chat', model: model?.trim() || DEFAULT_MODEL },
    });
  });

  app.patch('/chat/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { title, model } = req.body as { title?: string; model?: string };
    const budget = await getBudgetOrThrow();
    const existing = await prisma.chatSession.findFirst({ where: { id, budgetId: budget.id } });
    if (!existing) return reply.code(404).send({ error: 'Session not found.' });
    const data: Record<string, string> = {};
    if (title !== undefined) {
      const t = title.trim();
      if (!t) return reply.code(400).send({ error: 'Title must not be empty.' });
      data.title = t;
    }
    if (model !== undefined) {
      if (!/^[\w.:-]{1,80}$/.test(model)) return reply.code(400).send({ error: 'Invalid model id.' });
      data.model = model;
    }
    return prisma.chatSession.update({ where: { id }, data });
  });

  app.delete('/chat/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const budget = await getBudgetOrThrow();
    const existing = await prisma.chatSession.findFirst({ where: { id, budgetId: budget.id } });
    if (!existing) return reply.code(404).send({ error: 'Session not found.' });
    await prisma.chatSession.delete({ where: { id } }); // messages cascade
    return { ok: true };
  });

  app.get('/chat/sessions/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const budget = await getBudgetOrThrow();
    const session = await prisma.chatSession.findFirst({ where: { id, budgetId: budget.id } });
    if (!session) return reply.code(404).send({ error: 'Session not found.' });
    return prisma.chatMessage.findMany({
      where: { sessionId: id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, role: true, content: true, createdAt: true },
    });
  });

  app.post('/chat/sessions/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { content, model } = req.body as { content?: string; model?: string };
    const budget = await getBudgetOrThrow();
    const session = await prisma.chatSession.findFirst({ where: { id, budgetId: budget.id } });
    if (!session) return reply.code(404).send({ error: 'Session not found.' });
    const text = content?.trim();
    if (!text) return reply.code(400).send({ error: 'Message must not be empty.' });
    if (!chatConfigured()) {
      return reply.code(409).send({ error: 'AI chat is not configured — set CHAT_API_KEY (or CHAT_API_KEY_FILE) and restart.' });
    }

    const user = await prisma.chatMessage.create({ data: { sessionId: id, role: 'user', content: text } });

    const history = await prisma.chatMessage.findMany({
      where: { sessionId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: HISTORY_LIMIT,
      select: { role: true, content: true },
    });

    const context = await buildBudgetContext(budget.id);
    const useModel = model?.trim() || session.model || DEFAULT_MODEL;
    const result = await callUpstream(base, apiKey()!, useModel, [
      { role: 'system', content: SYSTEM_PROMPT(context) },
      ...history,
    ]);

    if (!result.ok) {
      return reply.code(502).send({ error: result.message });
    }

    const assistant = await prisma.chatMessage.create({
      data: { sessionId: id, role: 'assistant', content: result.content },
    });

    // first exchange names the session after the opening question
    if (session.title === 'New chat') {
      await prisma.chatSession.update({
        where: { id },
        data: { title: text.slice(0, 60) },
      });
    }

    return {
      user: { id: user.id, role: user.role, content: user.content, createdAt: user.createdAt },
      assistant: { id: assistant.id, role: assistant.role, content: assistant.content, createdAt: assistant.createdAt },
    };
  });
}
