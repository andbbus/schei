// First-run setup wizard endpoints. A fresh clone ships an empty SQLite DB —
// these endpoints create the Budget (+ always the Inflow category that RTA
// math requires, + optional starter categories), the first account reuses the
// regular POST /accounts, and the assistant config writes CHAT_* into
// backend/.env (the file Prisma's dotenv already loads) AND into process.env
// so no restart is needed. Key material is never echoed back.

import { FastifyInstance } from 'fastify';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prisma } from '../db';
import { today } from '../engineLoad';
import { monthOf, addMonths } from '../engine/budget';
import { chatBaseUrl, defaultModel, chatConfigured } from './chat';

// .env lives next to src/ (backend/.env); SETUP_ENV_FILE overrides for tests.
function envFile(): string {
  if (process.env.SETUP_ENV_FILE) return process.env.SETUP_ENV_FILE;
  return fileURLToPath(new URL('../.env', import.meta.url));
}

// Merge/replace KEY=VALUE lines, preserving comments and unrelated keys.
export function upsertEnv(keys: Record<string, string>): void {
  const file = envFile();
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = existing.split('\n');
  for (const [key, value] of Object.entries(keys)) {
    const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
    const line = `${key}=${value}`;
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  }
  writeFileSync(file, lines.join('\n').replace(/\n{3,}/g, '\n\n'), { mode: 0o600 });
  // live-apply: the running process reads config from env at call time
  for (const [key, value] of Object.entries(keys)) process.env[key] = value;
}

const STARTER: { group: string; categories: string[] }[] = [
  { group: 'Bills', categories: ['Rent', 'Utilities', 'Internet & Phone', 'Insurance'] },
  { group: 'Everyday', categories: ['Groceries', 'Eating Out', 'Transport'] },
  { group: 'Fun', categories: ['Entertainment', 'Shopping'] },
  { group: 'Savings', categories: ['Emergency Fund', 'Vacation'] },
];

export default async function setupRoutes(app: FastifyInstance) {
  app.get('/setup/status', async () => {
    const budget = await prisma.budget.findFirst();
    const key = process.env.CHAT_API_KEY ?? '';
    return {
      hasBudget: !!budget,
      chat: {
        configured: chatConfigured(),
        model: defaultModel(),
        baseUrl: chatBaseUrl(),
        keyTail: key ? key.slice(-4) : null,
      },
    };
  });

  // Create the first budget (409 when one already exists — single-budget app).
  app.post('/setup/budget', async (req, reply) => {
    const existing = await prisma.budget.findFirst();
    if (existing) return reply.code(409).send({ error: 'A budget already exists — this setup step is done.' });
    const b = req.body as {
      name?: string;
      currencySymbol?: string;
      decimalDigits?: number;
      locale?: string;
      starterCategories?: boolean;
    };
    const name = b.name?.trim() || 'My Budget';
    const currencySymbol = (b.currencySymbol?.trim() || '€').slice(0, 3);
    const decimalDigits = b.decimalDigits === 0 ? 0 : 2;
    const locale = /^[a-z]{2}(-[A-Z]{2})?$/.test(b.locale?.trim() ?? '') ? b.locale!.trim() : 'en-US';
    const firstMonth = monthOf(today());

    return prisma.$transaction(async (tx) => {
      const budget = await tx.budget.create({
        data: {
          name,
          currencySymbol,
          decimalDigits,
          locale,
          firstMonth,
          lastMonth: addMonths(firstMonth, 23), // two years of runway
        },
      });

      // The Inflow category is structurally required: income posts to it and
      // the whole RTA chain derives from it.
      const inflowGroup = await tx.categoryGroup.create({
        data: { budgetId: budget.id, name: 'Inflow', sortOrder: 0, isSystem: true },
      });
      await tx.category.create({
        data: { budgetId: budget.id, groupId: inflowGroup.id, name: 'Inflow: Ready to Assign', isInflow: true, sortOrder: 0 },
      });

      if (b.starterCategories !== false) {
        let order = 1;
        for (const g of STARTER) {
          const group = await tx.categoryGroup.create({
            data: { budgetId: budget.id, name: g.group, sortOrder: order++ },
          });
          let catOrder = 0;
          for (const name of g.categories) {
            await tx.category.create({
              data: { budgetId: budget.id, groupId: group.id, name, sortOrder: catOrder++ },
            });
          }
        }
      }

      return { ok: true, budgetId: budget.id };
    });
  });

  // Persist assistant provider config (.env + live process env).
  app.post('/setup/chat', async (req, reply) => {
    const b = req.body as { baseUrl?: string; model?: string; apiKey?: string };
    if (b.baseUrl !== undefined) {
      const url = b.baseUrl.trim().replace(/\/$/, '');
      if (!/^https?:\/\/.+/.test(url)) return reply.code(400).send({ error: 'baseUrl must be an http(s) URL.' });
      upsertEnv({ CHAT_BASE_URL: url });
    }
    if (b.model !== undefined) {
      const model = b.model.trim();
      if (!/^[\w.:/-]{1,120}$/.test(model)) return reply.code(400).send({ error: 'Invalid model id.' });
      upsertEnv({ CHAT_MODEL: model });
    }
    if (b.apiKey !== undefined && b.apiKey.trim() !== '') {
      const key = b.apiKey.trim();
      if (key.length < 8 || /\s/.test(key)) return reply.code(400).send({ error: 'That API key looks invalid.' });
      upsertEnv({ CHAT_API_KEY: key });
    }
    return { ok: true, configured: chatConfigured(), model: defaultModel() };
  });

  // Probe a provider config: 1-token completion against the gateway. Body
  // overrides are applied live first (so "Test" also saves what it tests).
  app.post('/setup/chat/test', async (req, reply) => {
    const b = req.body as { baseUrl?: string; model?: string; apiKey?: string };
    if (!chatConfigured() && !b.apiKey?.trim()) {
      return reply.code(409).send({ error: 'No API key configured yet.' });
    }
    if (b.baseUrl?.trim()) process.env.CHAT_BASE_URL = b.baseUrl.trim().replace(/\/$/, '');
    if (b.model?.trim()) process.env.CHAT_MODEL = b.model.trim();
    if (b.apiKey?.trim()) process.env.CHAT_API_KEY = b.apiKey.trim();

    const base = chatBaseUrl();
    const model = defaultModel();
    try {
      const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.CHAT_API_KEY ?? ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
          max_tokens: 200,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const body = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } } | null;
      if (!res.ok) {
        return reply.code(502).send({
          error: `Provider answered ${res.status}: ${body?.error?.message ?? res.statusText}`,
        });
      }
      const replyText = body?.choices?.[0]?.message?.content?.trim();
      return { ok: true, model, sample: replyText?.slice(0, 120) ?? '' };
    } catch (e) {
      return reply.code(502).send({
        error: `Could not reach ${base}: ${e instanceof Error ? e.message : e}`,
      });
    }
  });
}
