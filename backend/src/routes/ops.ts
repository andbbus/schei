import { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { getBudgetOrThrow } from '../engineLoad';
import { undoOp, PayloadError } from './ops-helpers';

function isPrismaError(e: unknown, code: string): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === code;
}

// Human-readable summary for the history panel (ids resolved at read time;
// nothing is ever hard-deleted, so joins always resolve).
async function summarize(
  kind: string,
  payload: string,
  names: { cats: Map<string, string>; accounts: Map<string, string>; payees: Map<string, string> },
): Promise<string> {
  let p: unknown;
  try {
    p = JSON.parse(payload);
  } catch {
    return kind;
  }
  const r = (p ?? {}) as Record<string, unknown>;
  const money = (v: unknown) => `${(Number(v) / 1000).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
  const catName = (id: unknown) => names.cats.get(String(id)) ?? '?';
  const monthLabel = (m: unknown) => {
    const [y, mm] = String(m).split('-');
    return `${mm}/${y.slice(2)}`;
  };
  switch (kind) {
    case 'assign':
    case 'autoAssign': {
      const arr = Array.isArray(p) ? (p as Record<string, unknown>[]) : [];
      if (arr.length === 1) {
        const a = arr[0];
        return `Set ${catName(a.categoryId)} (${monthLabel(a.month)}): ${money(a.next)}`;
      }
      return `Auto-assigned ${arr.length} categor${arr.length === 1 ? 'y' : 'ies'}`;
    }
    case 'move':
      return `Moved ${money(r.amount)} from ${r.fromCategoryId === 'rta' ? 'Ready to Assign' : catName(r.fromCategoryId)} to ${r.toCategoryId === 'rta' ? 'Ready to Assign' : catName(r.toCategoryId)} (${monthLabel(r.month)})`;
    case 'createTxn':
      return 'Created transaction';
    case 'updateTxn':
      return 'Edited transaction';
    case 'deleteTxn':
      return 'Deleted transaction';
    case 'deleteCategory':
      return `Deleted category ${catName(r.id)}`;
    case 'deleteGroup':
      return 'Deleted category group';
    case 'reconcile':
      return `Reconciled ${names.accounts.get(String(r.accountId)) ?? 'account'}`;
    case 'hideCategory':
      return `${r.prevHidden === true ? 'Unhid' : 'Hidden'} category ${catName(r.categoryId)}`;
    case 'applyRules':
      return `Applied payee rules to ${Array.isArray(r.rows) ? r.rows.length : '?'} transaction(s)`;
    case 'mergePayees':
      return `Merged "${String(r.fromName)}" into ${names.payees.get(String(r.toId)) ?? '?'}`;
    case 'projectedOverride': {
      const prev = typeof r.prev === 'number' ? r.prev : null;
      const next = typeof r.next === 'number' ? r.next : null;
      const who = `${catName(r.categoryId)} (${monthLabel(r.month)})`;
      if (next === null) return `Reverted projected ${who} to the moving average`;
      if (prev === null) return `Set projected ${who}: ${money(next)}`;
      return `Edited projected ${who}: ${money(prev)} → ${money(next)}`;
    }
    default:
      return kind;
  }
}

export default async function opsRoutes(app: FastifyInstance) {
  app.get('/ops', async (req) => {
    const q = req.query as { limit?: string };
    const budget = await getBudgetOrThrow();
    const limit = Math.min(Number(q.limit) || 20, 50);
    const ops = await prisma.opLog.findMany({ where: { budgetId: budget.id }, orderBy: { id: 'desc' }, take: limit });
    const [cats, accounts, payees] = await Promise.all([
      prisma.category.findMany({ where: { budgetId: budget.id }, select: { id: true, name: true } }),
      prisma.account.findMany({ where: { budgetId: budget.id }, select: { id: true, name: true } }),
      prisma.payee.findMany({ where: { budgetId: budget.id }, select: { id: true, name: true } }),
    ]);
    const names = {
      cats: new Map(cats.map((c) => [c.id, c.name])),
      accounts: new Map(accounts.map((a) => [a.id, a.name])),
      payees: new Map(payees.map((p) => [p.id, p.name])),
    };
    return Promise.all(
      ops.map(async (o) => ({
        id: o.id,
        kind: o.kind,
        summary: await summarize(o.kind, o.payload, names),
        createdAt: o.createdAt,
      })),
    );
  });

  // One-shot undo: apply the inverse and delete the op in a single transaction.
  app.post('/ops/:id/undo', async (req, reply) => {
    const { id } = req.params as { id: string };
    const budget = await getBudgetOrThrow();
    const opId = Number(id);
    if (!Number.isInteger(opId)) return reply.code(400).send({ error: 'Bad op id.' });
    try {
      const op = await prisma.opLog.findFirst({ where: { id: opId, budgetId: budget.id } });
      if (!op) return reply.code(404).send({ error: 'Operation not found — already undone or pruned.' });
      let payload: unknown;
      try {
        payload = JSON.parse(op.payload);
      } catch {
        return reply.code(409).send({ error: 'Operation payload is unreadable.' });
      }
      await prisma.$transaction(async (tx) => {
        await undoOp(tx, budget.id, op.kind, payload);
        // singular delete: a concurrent double-undo hits P2025 → 404 below
        await tx.opLog.delete({ where: { id: op.id } });
      });
      return { ok: true };
    } catch (e) {
      if (e instanceof PayloadError) return reply.code(409).send({ error: e.message });
      if (isPrismaError(e, 'P2025')) return reply.code(404).send({ error: 'Operation not found.' });
      if (isPrismaError(e, 'P1002')) return reply.code(409).send({ error: 'Database busy — try again.' });
      throw e;
    }
  });
}
