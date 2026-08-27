// AI assistant chat backed by the user's opencode-go gateway (OpenAI-compatible
// /chat/completions). Sessions + messages persist in SQLite; every request
// injects a compact budget snapshot as the system prompt so the agent answers
// questions about THIS budget — and can ACT on it through a small set of
// undoable tools (assign/move money, cover overspending, create transactions).
// Tool messages stay ephemeral; only the final assistant text is persisted.
// Upstream errors travel as { error } 502s and leave the stored history intact.
//
// Config: CHAT_API_KEY (or CHAT_API_KEY_FILE — key-file pattern shared with
// the AgentMail integration), CHAT_BASE_URL (default opencode zen go/v1),
// CHAT_MODEL (default deepseek-v4-flash).

import { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { prisma } from '../db';
import { getBudgetOrThrow, loadComputation, today } from '../engineLoad';
import { monthOf } from '../engine/budget';
import { detectAnomalies, AnomalyInputTxn } from '../engine/anomalies';
import { formatMilli } from '../money';
import { logOps } from './ops-helpers';
import { runQuickBudget } from './budget';
import { createTransaction, TxnBody } from './register';

const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1';
export const DEFAULT_MODEL = process.env.CHAT_MODEL ?? 'deepseek-v4-flash';

const HISTORY_LIMIT = 40;
const MAX_TOOL_ROUNDS = 6;

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

  // Unusual charges worth mentioning (posting-aware, same math as /reports/anomalies).
  let anomalyLines = '';
  try {
    const { txns } = await loadComputation(budgetId);
    const cutoff = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
    const onBudget = new Map(accounts.map((a) => [a.id, a.onBudget]));
    const payeeName = new Map(
      (await prisma.payee.findMany({ where: { budgetId }, select: { id: true, name: true } })).map((p) => [p.id, p.name]),
    );
    const samples: AnomalyInputTxn[] = [];
    for (const t of txns) {
      if (t.date > today() || t.transferAccountId || !onBudget.get(t.accountId)) continue;
      const pName = t.payeeId ? (payeeName.get(t.payeeId) ?? '') : '';
      const rows =
        (t.subtransactions ?? []).length > 0
          ? (t.subtransactions ?? []).map((s) => ({ id: s.id ?? t.id, amount: s.amount, categoryId: s.categoryId }))
          : [{ id: t.id, amount: t.amount, categoryId: t.categoryId }];
      for (const r of rows) {
        const c = r.categoryId ? categories.find((x) => x.id === r.categoryId) : null;
        if (!c || c.isInflow) continue;
        samples.push({ id: r.id, date: t.date, amount: r.amount, payeeId: t.payeeId ?? null, payeeName: pName, categoryId: c.id, categoryName: c.name });
      }
    }
    const top = detectAnomalies(samples, { recentFrom: cutoff }).slice(0, 5);
    if (top.length > 0) {
      anomalyLines = [
        'Unusual recent charges:',
        ...top.map((a) => `- ${a.date} ${a.payeeName}: ${eur(a.amount)} (typical ${eur(a.mean)}, ${a.direction})`),
      ].join('\n');
    }
  } catch {
    // anomalies are optional context — never break the snapshot
  }

  return [
    `Budget "${budget.name}", month ${month}. Currency ${budget.currencySymbol}.`,
    `Accounts (on-budget): ${acctLines || 'none'}.`,
    `Ready to Assign this month: ${eur(rta)}.`,
    'Category budgets (assigned / activity / available):',
    cats.map((c) => `- ${c.line}`).join('\n') || '- none',
    `Upcoming scheduled: ${upcomingLines || 'none'}.`,
    'Recent transactions:',
    recentLines || 'none',
    anomalyLines,
  ]
    .filter(Boolean)
    .join('\n');
}

const SYSTEM_PROMPT = (context: string) =>
  [
    'You are the built-in assistant of a local YNAB-style budgeting app. Answer questions about the',
    "user's budget using ONLY the snapshot below plus the conversation; never invent numbers. Be",
    'concise, use tables or short lists when helpful, and answer in the language the user writes in.',
    'You CAN modify the budget through tools: assigning or moving money, covering overspending and',
    'creating transactions are all performed for real (and are undoable by the user). Only call a',
    'tool when the user clearly asked for the change; confirm amounts and targets in your answer.',
    'Money amounts in tools are in CURRENCY UNITS (e.g. 12.5 = twelve and a half euros).',
    '',
    context,
  ].join('\n');

// ---- tools ----

interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

const TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'get_rta',
      description: 'Read Ready-to-Assign (left to assign) for a month.',
      parameters: {
        type: 'object',
        properties: { month: { type: 'string', description: 'YYYY-MM, default current month' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'assign_money',
      description:
        'Set the assigned amount of one category for a month. amount REPLACES the category total (absolute).',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Category name or id' },
          amount: { type: 'number', description: 'New total assigned, in currency units (positive)' },
          month: { type: 'string', description: 'YYYY-MM, default current month' },
        },
        required: ['category', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_money',
      description: 'Move available money between two categories in a month (or from "Ready to Assign" to a category).',
      parameters: {
        type: 'object',
        properties: {
          from_category: { type: 'string', description: 'Category name, id, or "Ready to Assign"' },
          to_category: { type: 'string', description: 'Category name or id' },
          amount: { type: 'number', description: 'Amount to move, in currency units (positive)' },
          month: { type: 'string', description: 'YYYY-MM, default current month' },
        },
        required: ['from_category', 'to_category', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cover_overspending',
      description: 'Auto-assign every underfunded category for the month, capped at Ready-to-Assign (largest shortfall first).',
      parameters: {
        type: 'object',
        properties: { month: { type: 'string', description: 'YYYY-MM, default current month' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_transaction',
      description:
        'Create a real transaction. Rules may auto-categorize when category is omitted; inflows without a rule go to Ready to Assign.',
      parameters: {
        type: 'object',
        properties: {
          account: { type: 'string', description: 'Account name or id' },
          payee: { type: 'string', description: 'Payee name' },
          amount: { type: 'number', description: 'Positive amount in currency units' },
          inflow: { type: 'boolean', description: 'true = money received, false (default) = money spent' },
          date: { type: 'string', description: 'YYYY-MM-DD, default today' },
          category: { type: 'string', description: 'Category name or id (optional)' },
          memo: { type: 'string' },
        },
        required: ['account', 'payee', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_transactions',
      description: 'Search past transactions by payee (and optional date range). Read-only.',
      parameters: {
        type: 'object',
        properties: {
          payee: { type: 'string', description: 'Payee name substring' },
          from: { type: 'string', description: 'YYYY-MM-DD inclusive' },
          to: { type: 'string', description: 'YYYY-MM-DD inclusive' },
          limit: { type: 'number', description: 'Max rows (default 10, max 25)' },
        },
      },
    },
  },
];

class ToolError extends Error {}

const normMonth = (m?: string | null): string => {
  if (!m) return monthOf(today());
  const s = m.trim();
  return /^\d{4}-\d{2}$/.test(s) ? `${s}-01` : `${s.slice(0, 7)}-01`;
};

const eur = (budgetId: string, milli: number): Promise<string> =>
  getBudgetOrThrow().then((b) =>
    formatMilli(milli, { symbol: b.currencySymbol, digits: b.decimalDigits, locale: b.locale }),
  );

async function resolveCategory(budgetId: string, ref: string): Promise<{ id: string; name: string; isInflow: boolean }> {
  const cats = await prisma.category.findMany({ where: { budgetId, deleted: false } });
  const q = ref.trim().toLowerCase();
  const cat =
    cats.find((c) => c.id === ref) ??
    cats.find((c) => c.name.toLowerCase() === q) ??
    cats.find((c) => !c.isInflow && (c.name.toLowerCase().includes(q) || q.includes(c.name.toLowerCase())));
  if (!cat) {
    throw new ToolError(
      `Category "${ref}" not found. Available: ${cats.filter((c) => !c.isInflow).map((c) => c.name).join(', ')}`,
    );
  }
  return cat;
}

async function resolveAccount(budgetId: string, ref: string): Promise<{ id: string; name: string }> {
  const accts = await prisma.account.findMany({ where: { budgetId, closed: false } });
  const q = ref.trim().toLowerCase();
  const acc = accts.find((a) => a.id === ref) ?? accts.find((a) => a.name.toLowerCase() === q) ?? accts.find((a) => a.name.toLowerCase().includes(q));
  if (!acc) throw new ToolError(`Account "${ref}" not found. Available: ${accts.map((a) => a.name).join(', ')}`);
  return acc;
}

// Execute one tool call and return a plain-text result for the model.
// Mutating tools wrap their writes + op-log in ONE transaction so every AI
// action is undoable from the History menu.
async function execTool(
  budgetId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const num = (k: string): number => {
    const v = Number(args[k]);
    if (!Number.isFinite(v)) throw new ToolError(`Invalid ${k}.`);
    return v;
  };
  const str = (k: string): string => {
    const v = args[k];
    if (typeof v !== 'string' || !v.trim()) throw new ToolError(`Invalid ${k}.`);
    return v.trim();
  };

  switch (name) {
    case 'get_rta': {
      const month = normMonth(typeof args.month === 'string' ? args.month : undefined);
      const { comp } = await loadComputation(budgetId);
      return `Ready to Assign for ${month.slice(0, 7)}: ${await eur(budgetId, comp.rtaByMonth[month] ?? 0)}`;
    }

    case 'assign_money': {
      const month = normMonth(typeof args.month === 'string' ? args.month : undefined);
      const cat = await resolveCategory(budgetId, str('category'));
      if (cat.isInflow) throw new ToolError('Ready to Assign cannot be assigned to — it IS the pool.');
      const milli = Math.round(num('amount') * 1000);
      if (milli < 0) throw new ToolError('Amount must be ≥ 0.');
      await prisma.$transaction(async (tx) => {
        const existing = await tx.monthCategory.findUnique({ where: { categoryId_month: { categoryId: cat.id, month } } });
        const prev = existing?.assigned ?? 0;
        if (prev !== milli) {
          await tx.monthCategory.upsert({
            where: { categoryId_month: { categoryId: cat.id, month } },
            update: { assigned: milli },
            create: { budgetId, categoryId: cat.id, month, assigned: milli },
          });
          await logOps(tx, budgetId, 'assign', [{ categoryId: cat.id, month, prev, next: milli }]);
        }
      });
      return `Assigned ${await eur(budgetId, milli)} to "${cat.name}" for ${month.slice(0, 7)}.`;
    }

    case 'move_money': {
      const month = normMonth(typeof args.month === 'string' ? args.month : undefined);
      const milli = Math.round(num('amount') * 1000);
      if (milli <= 0) throw new ToolError('Amount must be positive.');
      const fromRef = str('from_category');
      const isRta = /^(ready to assign|rta)$/i.test(fromRef);
      const from = isRta ? null : await resolveCategory(budgetId, fromRef);
      const to = await resolveCategory(budgetId, str('to_category'));
      if (from && from.id === to.id) throw new ToolError('Source and target are the same category.');
      await prisma.$transaction(async (tx) => {
        const adjust = async (categoryId: string, delta: number) => {
          const existing = await tx.monthCategory.findUnique({ where: { categoryId_month: { categoryId, month } } });
          const base = existing?.assigned ?? 0;
          await tx.monthCategory.upsert({
            where: { categoryId_month: { categoryId, month } },
            update: { assigned: base + delta },
            create: { budgetId, categoryId, month, assigned: base + delta },
          });
        };
        if (from) await adjust(from.id, -milli);
        await adjust(to.id, milli);
        await logOps(tx, budgetId, 'move', {
          month,
          fromCategoryId: from ? from.id : 'rta',
          toCategoryId: to.id,
          amount: milli,
        });
      });
      return `Moved ${await eur(budgetId, milli)} from "${from ? from.name : 'Ready to Assign'}" to "${to.name}" (${month.slice(0, 7)}).`;
    }

    case 'cover_overspending': {
      const month = normMonth(typeof args.month === 'string' ? args.month : undefined);
      const r = await runQuickBudget(budgetId, month, 'underfunded', true);
      if (r.changed === 0) return `Nothing to cover — every category is funded for ${month.slice(0, 7)}.`;
      return `Covered ${r.changed} underfunded categories with ${await eur(budgetId, r.totalDelta)} (largest shortfall first, capped at Ready to Assign).`;
    }

    case 'create_transaction': {
      const acc = await resolveAccount(budgetId, str('account'));
      const amount = Math.round(num('amount') * 1000);
      if (amount <= 0) throw new ToolError('Amount must be positive.');
      const signed = args.inflow === true ? amount : -amount;
      const date = typeof args.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : today();
      const cat = args.category ? await resolveCategory(budgetId, String(args.category)) : null;
      if (cat?.isInflow && signed < 0) throw new ToolError('Ready to Assign cannot be used for spending.');
      const body: TxnBody = {
        accountId: acc.id,
        date,
        payeeName: str('payee'),
        amount: signed,
        memo: typeof args.memo === 'string' ? args.memo : null,
        categoryId: cat ? cat.id : undefined,
        cleared: 'uncleared',
      };
      const created = await prisma.$transaction(async (tx) => {
        const t = await createTransaction(budgetId, body, tx);
        await logOps(tx, budgetId, 'createTxn', { txnId: t.id, transferTxnId: null });
        return t;
      });
      const catName = created.categoryId
        ? (await prisma.category.findUnique({ where: { id: created.categoryId } }))?.name
        : created.amount > 0
          ? 'Ready to Assign'
          : 'uncategorized';
      return `Created transaction ${created.date} ${await eur(budgetId, created.amount)} "${str('payee')}" on "${acc.name}" (${catName ?? 'uncategorized'}).`;
    }

    case 'search_transactions': {
      const limit = Math.min(25, Math.max(1, Math.round(Number(args.limit) || 10)));
      const where: Record<string, unknown> = { budgetId, deleted: false, transferAccountId: null };
      if (typeof args.from === 'string' || typeof args.to === 'string') {
        where.date = {
          ...(typeof args.from === 'string' ? { gte: args.from } : {}),
          ...(typeof args.to === 'string' ? { lte: args.to } : {}),
        };
      }
      if (typeof args.payee === 'string' && args.payee.trim()) {
        where.payee = { name: { contains: args.payee.trim() } };
      }
      const rows = await prisma.transaction.findMany({
        where,
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
        take: limit,
        select: {
          date: true,
          amount: true,
          memo: true,
          payee: { select: { name: true } },
          category: { select: { name: true } },
        },
      });
      if (rows.length === 0) return 'No matching transactions.';
      const lines = await Promise.all(
        rows.map(
          async (t) =>
            `${t.date} ${await eur(budgetId, t.amount)} ${t.payee?.name ?? '?'}${t.category ? ` → ${t.category.name}` : ''}${t.memo ? ` (${t.memo})` : ''}`,
        ),
      );
      return lines.join('\n');
    }

    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}

interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}

interface UpstreamOk {
  choices?: { message?: { role?: string; content?: string | null; tool_calls?: ToolCall[] } }[];
  error?: { message?: string };
}

async function callUpstream(
  base: string,
  key: string,
  model: string,
  messages: { role: string; content: string; tool_call_id?: string; tool_calls?: ToolCall[] }[],
  tools: ToolDef[] | null,
): Promise<
  | { ok: true; content: string; toolCalls: ToolCall[] }
  | { ok: false; status: number; message: string; toolsUnsupported?: boolean }
> {
  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, max_tokens: 2048, ...(tools ? { tools } : {}) }),
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
  if (!res.ok) {
    const msg =
      body?.error?.message ??
      (typeof body === 'object' && body && 'error' in body
        ? String((body as { error: { message?: string } }).error?.message ?? res.statusText)
        : res.statusText);
    // 400/404/422 from the gateway usually means the model rejects `tools`
    const toolsUnsupported = res.status === 400 || res.status === 404 || res.status === 422;
    return { ok: false, status: 502, message: `AI gateway error (${res.status}): ${msg}`, toolsUnsupported };
  }
  const message = body?.choices?.[0]?.message;
  const content = message?.content ?? '';
  const toolCalls = message?.tool_calls ?? [];
  if (!content && toolCalls.length === 0) {
    return { ok: false, status: 502, message: 'AI gateway returned an empty reply.' };
  }
  return { ok: true, content, toolCalls };
}

export default async function chatRoutes(app: FastifyInstance) {
  const base = process.env.CHAT_BASE_URL ?? DEFAULT_BASE_URL;

  app.get('/chat/status', async () => ({ configured: chatConfigured(), defaultModel: DEFAULT_MODEL, tools: TOOLS.map((t) => t.function.name) }));

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
    const messages: { role: string; content: string; tool_call_id?: string; tool_calls?: ToolCall[] }[] = [
      { role: 'system', content: SYSTEM_PROMPT(context) },
      ...history,
    ];

    // Tool loop: the model may call tools for several rounds; tool outputs
    // stay ephemeral (in-memory only) while the conversation persists.
    const toolResults: { name: string; summary: string }[] = [];
    let finalContent = '';
    let gaveUp = false;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const result = await callUpstream(base, apiKey()!, useModel, messages, TOOLS);

      if (!result.ok) {
        if (result.toolsUnsupported && round === 0) {
          // model/gateway can't take tools — degrade to read-only chat
          const plain = await callUpstream(base, apiKey()!, useModel, messages, null);
          if (!plain.ok) return reply.code(502).send({ error: plain.message });
          finalContent = plain.content;
          break;
        }
        return reply.code(502).send({ error: result.message });
      }

      if (result.toolCalls.length === 0) {
        finalContent = result.content;
        break;
      }

      // mirror the assistant's tool-call turn (with its tool_calls, as the
      // OpenAI wire format expects), then feed each result back
      messages.push({
        role: 'assistant',
        content: result.content || `Calling tools: ${result.toolCalls.map((t) => t.function.name).join(', ')}`,
        tool_calls: result.toolCalls,
      });
      for (const tc of result.toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = tc.function.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
        } catch {
          /* model sent malformed JSON — execTool will complain */
        }
        try {
          const out = await execTool(budget.id, tc.function.name, args);
          toolResults.push({ name: tc.function.name, summary: out });
          messages.push({ role: 'tool', content: out, tool_call_id: tc.id });
        } catch (e) {
          const msg = e instanceof ToolError ? e.message : `Tool ${tc.function.name} failed: ${e instanceof Error ? e.message : e}`;
          toolResults.push({ name: tc.function.name, summary: msg });
          messages.push({ role: 'tool', content: msg, tool_call_id: tc.id });
        }
      }
      if (round === MAX_TOOL_ROUNDS - 1) gaveUp = true;
    }

    if (!finalContent) {
      finalContent = gaveUp
        ? 'I stopped after too many tool rounds — ask me to continue if something is missing.'
        : 'OK.';
    }

    const assistant = await prisma.chatMessage.create({
      data: { sessionId: id, role: 'assistant', content: finalContent },
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
      toolCalls: toolResults,
    };
  });
}
