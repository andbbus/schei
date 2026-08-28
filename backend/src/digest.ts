// Weekly budget digest — a pure email builder fed by the engine, an
// AgentMail/SMTP sender (same pattern as the shopping list), and an env-gated
// weekly scheduler (DIGEST_ENABLED=1). Nothing is stored; every send derives
// fresh numbers on read.

import { prisma } from './db';
import { getBudgetOrThrow, loadComputation, today } from './engineLoad';
import { monthOf, addMonths } from './engine/budget';
import { nextOccurrence } from './engine/schedule';
import { detectAnomalies } from './engine/anomalies';
import { computeAgeOfMoney } from './engine/ageOfMoney';
import { computeTarget, type GoalType } from './engine/targets';
import { formatMilli } from './money';
import nodemailer from 'nodemailer';
import fs from 'node:fs';

export interface DigestData {
  budgetName: string;
  currency: { symbol: string; digits: number; locale: string };
  month: string;
  rta: number;
  ageOfMoney: number | null;
  overspent: { name: string; available: number }[];
  underfunded: { name: string; needed: number }[];
  upcoming: { date: string; payee: string; amount: number }[];
  anomalies: { date: string; payeeName: string; amount: number; mean: number; direction: string }[];
  trend: { month: string; income: number; expense: number }[];
  netWorth: number;
}

export async function buildDigestData(budgetId: string): Promise<DigestData> {
  const budget = await getBudgetOrThrow();
  const cur = { symbol: budget.currencySymbol, digits: budget.decimalDigits, locale: budget.locale };
  const eur = (m: number) => formatMilli(m, cur);
  void eur;

  const { accounts, categories, comp, balances, txns } = await loadComputation(budgetId);
  const month = monthOf(today());

  const cell = new Map<string, { assigned: number; activity: number; available: number }>();
  for (const mc of comp.monthCategories) {
    if (mc.month === month) cell.set(mc.categoryId, mc);
  }
  const overspent = categories
    .filter((c) => !c.isInflow)
    .map((c) => ({ name: c.name, available: (cell.get(c.id)?.available ?? 0) }))
    .filter((x) => x.available < 0)
    .sort((a, b) => a.available - b.available)
    .slice(0, 8);

  // underfunded targets for the CURRENT month (same math as the quick budget)
  const underfunded = categories
    .filter((c) => !c.isInflow && c.goalType)
    .map((c) => {
      const v = cell.get(c.id) ?? { assigned: 0, activity: 0, available: 0 };
      const t = computeTarget(
        {
          goalType: (c.goalType as GoalType) ?? null,
          goalTarget: c.goalTarget ?? null,
          goalCadence: c.goalCadence ?? null,
          goalDay: c.goalDay ?? null,
          goalTargetMonth: c.goalTargetMonth ?? null,
          goalNeedsWholeAmount: c.goalNeedsWholeAmount ?? null,
        },
        { month, assignedThisMonth: v.assigned, available: v.available },
      );
      return { name: c.name, needed: t.underfunded };
    })
    .filter((x) => x.needed > 0)
    .sort((a, b) => b.needed - a.needed)
    .slice(0, 5);

  // upcoming 7 days: scheduled occurrences (skip internal transfers)
  const now = today();
  const horizon = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const onBudget = new Map(accounts.map((a) => [a.id, a.onBudget]));
  const payees = await prisma.payee.findMany({ where: { budgetId }, select: { id: true, name: true } });
  const payeeName = new Map(payees.map((p) => [p.id, p.name]));
  const scheduled = await prisma.scheduledTransaction.findMany({ where: { budgetId, deleted: false }, include: { payee: true } });
  const upcoming: { date: string; payee: string; amount: number }[] = [];
  for (const s of scheduled) {
    if (s.transferAccountId && onBudget.get(s.transferAccountId)) continue;
    const label = s.payee?.name ?? '?';
    if (s.nextDate >= now && s.nextDate <= horizon) {
      upcoming.push({ date: s.nextDate, payee: label, amount: s.amount });
    }
    let cursor = s.nextDate > now ? s.nextDate : now;
    for (let i = 0; i < 30; i++) {
      const n = nextOccurrence(s.frequency, cursor, s.anchorDay ?? undefined);
      if (!n || n > horizon) break;
      if (s.endMonth && monthOf(n) > s.endMonth) break;
      upcoming.push({ date: n, payee: label, amount: s.amount });
      cursor = n;
    }
  }
  upcoming.sort((a, b) => (a.date < b.date ? -1 : 1));

  // anomalies, last 7 days
  let anomalies: DigestData['anomalies'] = [];
  try {
    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const samples = [];
    for (const t of txns) {
      if (t.date > now || t.transferAccountId || !onBudget.get(t.accountId)) continue;
      const rows =
        (t.subtransactions ?? []).length > 0
          ? (t.subtransactions ?? []).map((s) => ({ id: s.id ?? t.id, amount: s.amount, categoryId: s.categoryId }))
          : [{ id: t.id, amount: t.amount, categoryId: t.categoryId }];
      for (const r of rows) {
        const c = r.categoryId ? categories.find((x) => x.id === r.categoryId) : null;
        if (!c || c.isInflow) continue;
        samples.push({
          id: r.id,
          date: t.date,
          amount: r.amount,
          payeeId: t.payeeId ?? null,
          payeeName: t.payeeId ? (payeeName.get(t.payeeId) ?? '') : '',
          categoryId: c.id,
          categoryName: c.name,
        });
      }
    }
    anomalies = detectAnomalies(samples, { recentFrom: cutoff })
      .slice(0, 5)
      .map((a) => ({ date: a.date, payeeName: a.payeeName, amount: a.amount, mean: a.mean, direction: a.direction }));
  } catch {
    // optional — digest still sends without anomalies
  }

  // last 3 months income/expense
  const trend = [2, 1, 0].map((i) => {
    const m = addMonths(month, -i);
    return { month: m, income: comp.incomeByMonth[m] ?? 0, expense: -(comp.activityByMonth[m] ?? 0) };
  }).reverse();

  const netWorth = accounts.reduce((s, a) => s + (balances[a.id]?.working ?? 0), 0);
  const ageOfMoney = computeAgeOfMoney(
    txns,
    accounts.map((a) => ({ id: a.id, onBudget: a.onBudget, type: a.type })),
    now,
  );

  return {
    budgetName: budget.name,
    currency: cur,
    month,
    rta: comp.rtaByMonth[month] ?? 0,
    ageOfMoney,
    overspent,
    underfunded,
    upcoming: upcoming.slice(0, 12),
    anomalies,
    trend,
    netWorth,
  };
}

// Pure builder: data → { subject, text, html }. Tested.
export function buildDigest(d: DigestData): { subject: string; text: string; html: string } {
  const eur = (m: number) => formatMilli(m, d.currency);
  const dateLabel = new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  const lines: string[] = [];
  lines.push(`Budget "${d.budgetName}" — ${d.month.slice(0, 7)}`);
  lines.push('');
  lines.push(`Ready to Assign: ${eur(d.rta)}`);
  lines.push(`Net worth: ${eur(d.netWorth)}${d.ageOfMoney != null ? ` · Age of Money: ${d.ageOfMoney} days` : ''}`);
  if (d.overspent.length > 0) {
    lines.push('');
    lines.push('Overspent categories:');
    for (const o of d.overspent) lines.push(`  • ${o.name}: ${eur(o.available)}`);
  }
  if (d.underfunded.length > 0) {
    lines.push('');
    lines.push('Underfunded targets:');
    for (const u of d.underfunded) lines.push(`  • ${u.name}: needs ${eur(u.needed)}`);
  }
  if (d.upcoming.length > 0) {
    lines.push('');
    lines.push('Next 7 days:');
    for (const u of d.upcoming) lines.push(`  • ${u.date} ${u.payee}: ${eur(u.amount)}`);
  }
  if (d.anomalies.length > 0) {
    lines.push('');
    lines.push('Unusual charges (last 7 days):');
    for (const a of d.anomalies) lines.push(`  • ${a.date} ${a.payeeName}: ${eur(a.amount)} (typical ${eur(a.mean)})`);
  }
  lines.push('');
  lines.push('Last 3 months (income / expense):');
  for (const t of d.trend) lines.push(`  • ${t.month.slice(0, 7)}: ${eur(t.income)} / ${eur(-t.expense)}`);

  const text = lines.join('\n');
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const htmlParts: string[] = [];
  htmlParts.push(`<h2>Budget "${esc(d.budgetName)}" — ${d.month.slice(0, 7)}</h2>`);
  htmlParts.push(`<p><b>Ready to Assign:</b> ${eur(d.rta)} · <b>Net worth:</b> ${eur(d.netWorth)}${d.ageOfMoney != null ? ` · <b>Age of Money:</b> ${d.ageOfMoney} days` : ''}</p>`);
  const section = (title: string, rows: string[]) =>
    rows.length > 0 ? `<h3>${title}</h3><ul>${rows.map((r) => `<li>${r}</li>`).join('')}</ul>` : '';
  htmlParts.push(section('Overspent categories', d.overspent.map((o) => `${esc(o.name)}: <b>${eur(o.available)}</b>`)));
  htmlParts.push(section('Underfunded targets', d.underfunded.map((u) => `${esc(u.name)}: needs ${eur(u.needed)}`)));
  htmlParts.push(section('Next 7 days', d.upcoming.map((u) => `${u.date} ${esc(u.payee)}: ${eur(u.amount)}`)));
  htmlParts.push(
    section(
      'Unusual charges (last 7 days)',
      d.anomalies.map((a) => `${a.date} ${esc(a.payeeName)}: <b>${eur(a.amount)}</b> (typical ${eur(a.mean)})`),
    ),
  );
  htmlParts.push(`<h3>Last 3 months (income / expense)</h3><ul>${d.trend.map((t) => `<li>${t.month.slice(0, 7)}: ${eur(t.income)} / ${eur(-t.expense)}</li>`).join('')}</ul>`);
  htmlParts.push(`<p style="color:#888;font-size:12px">Generated ${esc(dateLabel)} by Schei, your local budget app.</p>`);

  return {
    subject: `Budget digest — ${d.budgetName} (${d.month.slice(0, 7)})`,
    text,
    html: htmlParts.join('\n'),
  };
}

// ---- delivery (AgentMail preferred, SMTP fallback — mirrors shopping.ts) ----

function agentMailApiKey(): string | null {
  const env = process.env.AGENTMAIL_API_KEY?.trim();
  if (env) return env;
  const file = process.env.AGENTMAIL_API_KEY_FILE?.trim();
  if (file) {
    try {
      const k = fs.readFileSync(file, 'utf8').trim();
      if (k) return k;
    } catch {
      // fall through
    }
  }
  return null;
}

export function digestRecipient(): string | null {
  return process.env.DIGEST_TO?.trim() || process.env.SHOPPING_EMAIL_TO?.trim() || null;
}

export async function sendDigestEmail(subject: string, text: string, html: string): Promise<{ channel: string; to: string }> {
  const recipient = digestRecipient();
  if (!recipient) throw new Error('No digest recipient — open Settings (⚙ → Email & digest) to set one, or add DIGEST_TO to backend/.env.');
  const key = agentMailApiKey();
  if (key) {
    const inbox = process.env.AGENTMAIL_INBOX?.trim();
    if (!inbox) throw new Error('AgentMail key is set but AGENTMAIL_INBOX is missing in backend/.env.');
    const r = await fetch(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inbox)}/messages/send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ to: recipient, subject, text, html }),
    });
    if (!r.ok) throw new Error(`AgentMail send failed: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
    return { channel: 'agentmail', to: recipient };
  }
  const host = process.env.SMTP_HOST;
  if (!host) throw new Error('No email provider configured — set AGENTMAIL_API_KEY (or AGENTMAIL_API_KEY_FILE) or SMTP_HOST in backend/.env.');
  const transporter = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' } : undefined,
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER ?? 'budget@local',
    to: recipient,
    subject,
    text,
    html,
  });
  return { channel: 'smtp', to: recipient };
}

export async function sendDigestNow(): Promise<{ subject: string; channel: string; to: string }> {
  const data = await buildDigestData((await getBudgetOrThrow()).id);
  const digest = buildDigest(data);
  const res = await sendDigestEmail(digest.subject, digest.text, digest.html);
  return { subject: digest.subject, ...res };
}

// ---- weekly scheduler (no cron dep): DIGEST_ENABLED=1 → Mondays 08:00 ----
// The flag is re-read on every tick so toggling it in Settings applies
// without a restart.

export function startDigestScheduler(): void {
  const schedule = () => {
    const now = new Date();
    const next = new Date(now);
    next.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7)); // next Monday
    next.setHours(8, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 7);
    const wait = next.getTime() - now.getTime();
    console.log(`[digest] next weekly digest: ${next.toString()}`);
    setTimeout(async () => {
      try {
        if (process.env.DIGEST_ENABLED !== '1') {
          console.log('[digest] skipped — disabled (DIGEST_ENABLED)');
        } else if (digestRecipient()) {
          const r = await sendDigestNow();
          console.log(`[digest] sent via ${r.channel} to ${r.to}`);
        } else {
          console.log('[digest] skipped — no recipient configured (DIGEST_TO)');
        }
      } catch (e) {
        console.error(`[digest] send failed: ${e instanceof Error ? e.message : e}`);
      }
      schedule();
    }, wait);
  };
  schedule();
}
