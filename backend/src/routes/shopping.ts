import { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import nodemailer from 'nodemailer';
import { prisma } from '../db';
import { getBudgetOrThrow } from '../engineLoad';
import { GroceryItemInput, isoWeek, parseAldiHtml, parseCatalogCsv, buildEmailBody, BLOCKED_STORES } from '../engine/groceries';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

const STORE_URLS: Record<string, string> = {
  aldi: 'https://www.aldi-nord.de/angebote.html',
  lidl: 'https://www.lidl.de/c/online-prospekte/s10005610',
  netto: 'https://www.netto-online.de/prospekt',
};

async function upsertWeek(budgetId: string, week: string, items: GroceryItemInput[]) {
  let created = 0;
  for (const it of items) {
    await prisma.groceryItem.upsert({
      where: {
        budgetId_store_week_externalId: {
          budgetId,
          store: it.store,
          week,
          externalId: it.externalId ?? `${it.name}|${it.price}`,
        },
      },
      update: { name: it.name, brand: it.brand ?? null, price: it.price, unit: it.unit ?? null, imageUrl: it.imageUrl ?? null },
      create: {
        budgetId,
        store: it.store,
        week,
        name: it.name,
        brand: it.brand ?? null,
        price: it.price,
        unit: it.unit ?? null,
        imageUrl: it.imageUrl ?? null,
        externalId: it.externalId ?? `${it.name}|${it.price}`,
      },
    });
    created++;
  }
  return created;
}

export default async function shoppingRoutes(app: FastifyInstance) {
  // Sync the current week from the store adapters. Aldi Nord is parsed
  // server-side; Lidl/Netto are bot-protected JS apps → reported as blocked
  // (use the CSV import for those).
  app.post('/shopping/sync', async () => {
    const budget = await getBudgetOrThrow();
    const week = isoWeek();
    const results: { store: string; status: string; count?: number; error?: string }[] = [];
    for (const store of Object.keys(STORE_URLS)) {
      if (BLOCKED_STORES.has(store)) {
        const why =
          store === 'lidl'
            ? 'Flyer is image-based — no product data; use the CSV import.'
            : 'Bot-protected site — use the CSV import.';
        results.push({ store, status: 'blocked', error: why });
        continue;
      }
      try {
        const html = await fetchText(STORE_URLS[store]);
        const items =
          store === 'aldi'
            ? parseAldiHtml(html).map((it) => ({ ...it, store: 'aldi' as const }))
            : [];
        const count = await upsertWeek(budget.id, week, items);
        results.push({ store, status: 'ok', count });
      } catch (e) {
        results.push({ store, status: 'error', error: e instanceof Error ? e.message : String(e) });
      }
    }
    // drop the previous week's offers so the catalog stays current
    await prisma.groceryItem.deleteMany({ where: { budgetId: budget.id, week: { not: week } } });
    return { week, results };
  });

  // Manual CSV import for any store (the reliable path for Lidl/Netto).
  app.post('/shopping/import-csv', async (req, reply) => {
    const b = req.body as { csv?: string };
    const budget = await getBudgetOrThrow();
    if (!b.csv || !b.csv.trim()) return reply.code(400).send({ error: 'csv is required.' });
    let items: GroceryItemInput[];
    try {
      items = parseCatalogCsv(b.csv);
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : 'Unparseable CSV.' });
    }
    if (items.length === 0) return reply.code(400).send({ error: 'No rows parsed (expected name;price;unit).' });
    const count = await upsertWeek(budget.id, isoWeek(), items);
    return { week: isoWeek(), count, items: items.length };
  });

  // Search the current week's catalog (optionally one store).
  app.get('/shopping/catalog', async (req) => {
    const q = req.query as { q?: string; store?: string };
    const budget = await getBudgetOrThrow();
    const week = isoWeek();
    const needle = q.q?.trim().toLowerCase() ?? '';
    const rows = await prisma.groceryItem.findMany({
      where: {
        budgetId: budget.id,
        week,
        ...(q.store && q.store !== 'all' ? { store: q.store } : {}),
      },
      orderBy: [{ store: 'asc' }, { name: 'asc' }],
      take: 500,
    });
    const filtered = needle
      ? rows.filter((r) => r.name.toLowerCase().includes(needle) || (r.brand ?? '').toLowerCase().includes(needle))
      : rows;
    return {
      week,
      items: filtered.map((r) => ({ id: r.id, store: r.store, name: r.name, brand: r.brand, price: r.price, unit: r.unit, imageUrl: r.imageUrl })),
    };
  });

  app.get('/shopping/lists', async () => {
    const budget = await getBudgetOrThrow();
    const lists = await prisma.shoppingList.findMany({
      where: { budgetId: budget.id },
      orderBy: { createdAt: 'desc' },
      include: { items: { orderBy: { id: 'asc' } } },
    });
    return lists.map((l) => ({
      id: l.id,
      name: l.name,
      createdAt: l.createdAt,
      items: l.items.map((i) => ({ id: i.id, itemId: i.itemId, name: i.name, price: i.price, quantity: i.quantity, store: i.store, imageUrl: i.imageUrl })),
    }));
  });

  app.post('/shopping/lists', async (req, reply) => {
    const { name } = req.body as { name?: string };
    const budget = await getBudgetOrThrow();
    const n = name?.trim() || 'Lista della spesa';
    return prisma.shoppingList.create({ data: { budgetId: budget.id, name: n } });
  });

  app.patch('/shopping/lists/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { name } = req.body as { name?: string };
    const budget = await getBudgetOrThrow();
    const list = await prisma.shoppingList.findFirst({ where: { id, budgetId: budget.id } });
    if (!list) return reply.code(404).send({ error: 'List not found.' });
    return prisma.shoppingList.update({ where: { id }, data: { name: name?.trim() || list.name } });
  });

  app.delete('/shopping/lists/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const budget = await getBudgetOrThrow();
    const list = await prisma.shoppingList.findFirst({ where: { id, budgetId: budget.id } });
    if (!list) return reply.code(404).send({ error: 'List not found.' });
    await prisma.shoppingList.delete({ where: { id } });
    return { ok: true };
  });

  // Add an item: either a catalog itemId (price snapshot taken now) or a free
  // text line with an optional price.
  app.post('/shopping/lists/:id/items', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { itemId?: string; name?: string; price?: number; quantity?: number };
    const budget = await getBudgetOrThrow();
    const list = await prisma.shoppingList.findFirst({ where: { id, budgetId: budget.id } });
    if (!list) return reply.code(404).send({ error: 'List not found.' });
    const quantity = Math.max(1, Math.round(b.quantity ?? 1));
    if (b.itemId) {
      const item = await prisma.groceryItem.findFirst({ where: { id: b.itemId, budgetId: budget.id } });
      if (!item) return reply.code(404).send({ error: 'Catalog item not found.' });
      return prisma.shoppingListItem.create({
        data: {
          listId: id,
          itemId: item.id,
          name: item.brand ? `${item.name} (${item.brand})` : item.name,
          price: item.price,
          quantity,
          store: item.store,
          imageUrl: item.imageUrl,
        },
      });
    }
    const name = b.name?.trim();
    if (!name) return reply.code(400).send({ error: 'name is required when no itemId is given.' });
    return prisma.shoppingListItem.create({
      data: { listId: id, name, price: Math.max(0, Math.round(b.price ?? 0)), quantity },
    });
  });

  app.patch('/shopping/lists/:listId/items/:itemId', async (req, reply) => {
    const { listId, itemId } = req.params as { listId: string; itemId: string };
    const { quantity } = req.body as { quantity?: number };
    const budget = await getBudgetOrThrow();
    const list = await prisma.shoppingList.findFirst({ where: { id: listId, budgetId: budget.id } });
    if (!list) return reply.code(404).send({ error: 'List not found.' });
    const row = await prisma.shoppingListItem.findFirst({ where: { id: itemId, listId } });
    if (!row) return reply.code(404).send({ error: 'Item not found.' });
    if (quantity !== undefined && (quantity < 0 || quantity > 99)) return reply.code(400).send({ error: 'quantity must be 0-99.' });
    return prisma.shoppingListItem.update({ where: { id: itemId }, data: { quantity: Math.round(quantity ?? row.quantity) } });
  });

  app.delete('/shopping/lists/:listId/items/:itemId', async (req, reply) => {
    const { listId, itemId } = req.params as { listId: string; itemId: string };
    const budget = await getBudgetOrThrow();
    const list = await prisma.shoppingList.findFirst({ where: { id: listId, budgetId: budget.id } });
    if (!list) return reply.code(404).send({ error: 'List not found.' });
    await prisma.shoppingListItem.deleteMany({ where: { id: itemId, listId } });
    return { ok: true };
  });

  // Email the list. Delivery is two-channel: AgentMail (preferred when
  // AGENTMAIL_API_KEY or AGENTMAIL_API_KEY_FILE is set) or direct SMTP
  // (SMTP_HOST etc.). Recipient = body.to or SHOPPING_EMAIL_TO. Returns 409
  // with a friendly message when neither channel is configured.
  app.post('/shopping/lists/:id/email', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { to } = req.body as { to?: string };
    const budget = await getBudgetOrThrow();
    const list = await prisma.shoppingList.findFirst({
      where: { id, budgetId: budget.id },
      include: { items: { orderBy: { id: 'asc' } } },
    });
    if (!list) return reply.code(404).send({ error: 'List not found.' });
    const recipient = to?.trim() || process.env.SHOPPING_EMAIL_TO;
    if (!recipient) return reply.code(409).send({ error: 'No recipient — set SHOPPING_EMAIL_TO in backend/.env or pass to.' });

    const total = list.items.reduce((s, i) => s + i.price * i.quantity, 0);
    const dateLabel = new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const body = buildEmailBody(
      list.items.map((i) => ({ name: i.name, price: i.price, quantity: i.quantity, store: i.store })),
      dateLabel,
    );
    const subject = `Lista della spesa — ${dateLabel} (stimato ${(total / 1000).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €)`;

    const agentMailKey = agentMailApiKey();
    if (agentMailKey) {
      const inbox = process.env.AGENTMAIL_INBOX?.trim();
      if (!inbox) {
        return reply.code(409).send({ error: 'AgentMail key is set but AGENTMAIL_INBOX is missing in backend/.env.' });
      }
      const r = await fetch(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inbox)}/messages/send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${agentMailKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ to: recipient, subject, text: body }),
      });
      if (!r.ok) {
        return reply.code(502).send({ error: `AgentMail send failed: HTTP ${r.status} ${(await r.text()).slice(0, 300)}` });
      }
      return { ok: true, channel: 'agentmail', to: recipient, total, subject };
    }

    const host = process.env.SMTP_HOST;
    if (!host) {
      return reply.code(409).send({
        error: 'No email provider configured — set AGENTMAIL_API_KEY (or AGENTMAIL_API_KEY_FILE) or SMTP_HOST in backend/.env.',
      });
    }
    const transporter = nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' }
        : undefined,
    });
    try {
      await transporter.sendMail({
        from: process.env.SMTP_FROM ?? process.env.SMTP_USER ?? 'budget@local',
        to: recipient,
        subject,
        text: body,
      });
    } catch (e) {
      return reply.code(502).send({ error: `SMTP send failed: ${e instanceof Error ? e.message : String(e)}` });
    }
    return { ok: true, channel: 'smtp', to: recipient, total, subject };
  });
}

// AgentMail key from env, or from a file (AGENTMAIL_API_KEY_FILE). Never
// logged; the file path is the pattern used by the desktop email agent.
function agentMailApiKey(): string | null {
  const env = process.env.AGENTMAIL_API_KEY?.trim();
  if (env) return env;
  const file = process.env.AGENTMAIL_API_KEY_FILE?.trim();
  if (file) {
    try {
      const k = fs.readFileSync(file, 'utf8').trim();
      if (k) return k;
    } catch {
      // fall through — no key available
    }
  }
  return null;
}
