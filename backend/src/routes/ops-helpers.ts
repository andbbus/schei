// Shared op-log helpers for undo. Logging happens INSIDE the mutation's
// $transaction (atomic: mutation + op insert + prune). Payload contracts and
// inverse logic live here so routes stay thin.

import { Prisma } from '@prisma/client';

export type DbTx = Prisma.TransactionClient;

export const OPS_LIMIT = 200;

export async function logOps(tx: DbTx, budgetId: string, kind: string, payload: unknown) {
  await tx.opLog.create({ data: { budgetId, kind, payload: JSON.stringify(payload) } });
  const old = await tx.opLog.findMany({
    where: { budgetId },
    orderBy: { id: 'desc' },
    skip: OPS_LIMIT,
    take: 1,
    select: { id: true },
  });
  if (old.length > 0) {
    await tx.opLog.deleteMany({ where: { budgetId, id: { lt: old[0].id } } });
  }
}

// Adjust a category's assigned amount by a delta (upsert semantics; the engine
// treats a missing row as 0).
export async function adjustAssigned(tx: DbTx, budgetId: string, categoryId: string, month: string, delta: number) {
  const row = await tx.monthCategory.findUnique({ where: { categoryId_month: { categoryId, month } } });
  await tx.monthCategory.upsert({
    where: { categoryId_month: { categoryId, month } },
    update: { assigned: (row?.assigned ?? 0) + delta },
    create: { budgetId, categoryId, month, assigned: delta },
  });
}

// Set a category's assigned amount absolutely (used by delta-undo of assign).
export async function setAssigned(tx: DbTx, budgetId: string, categoryId: string, month: string, value: number) {
  await tx.monthCategory.upsert({
    where: { categoryId_month: { categoryId, month } },
    update: { assigned: value },
    create: { budgetId, categoryId, month, assigned: value },
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function assertPayload(kind: string, payload: unknown, check: boolean) {
  if (!check) {
    throw new PayloadError(`Malformed ${kind} undo payload.`);
  }
  return payload as Record<string, unknown>;
}

export class PayloadError extends Error {}

// Apply the inverse of one logged operation. Runs inside the undo transaction.
// Missing/live-checked rows consume the op silently (nothing to undo) EXCEPT
// malformed payloads, which throw PayloadError → 409.
export async function undoOp(tx: DbTx, budgetId: string, kind: string, raw: unknown) {
  switch (kind) {
    case 'assign':
    case 'autoAssign': {
      const arr = assertPayload(kind, raw, Array.isArray(raw)) as unknown as Record<string, unknown>[];
      for (const item of arr) {
        assertPayload(kind, item, isRecord(item) && typeof item.categoryId === 'string' && typeof item.month === 'string' && typeof item.prev === 'number' && typeof item.next === 'number');
        const { categoryId, month, prev, next } = item as { categoryId: string; month: string; prev: number; next: number };
        const cur = await tx.monthCategory.findUnique({ where: { categoryId_month: { categoryId, month } } });
        await setAssigned(tx, budgetId, categoryId, month, (cur?.assigned ?? 0) - (next - prev));
      }
      return;
    }
    case 'move': {
      const p = assertPayload(kind, raw, isRecord(raw) && typeof raw.month === 'string' && typeof raw.amount === 'number');
      const { month, amount } = p as { month: string; amount: number };
      const from = typeof p.fromCategoryId === 'string' ? p.fromCategoryId : null;
      const to = typeof p.toCategoryId === 'string' ? p.toCategoryId : null;
      if (from && from !== 'rta') await adjustAssigned(tx, budgetId, from, month, amount);
      if (to && to !== 'rta') await adjustAssigned(tx, budgetId, to, month, -amount);
      return;
    }
    case 'createTxn': {
      const p = assertPayload(kind, raw, isRecord(raw) && typeof raw.txnId === 'string');
      await softDeleteTxnPair(tx, p.txnId as string, typeof p.transferTxnId === 'string' ? p.transferTxnId : null);
      return;
    }
    case 'deleteTxn': {
      const p = assertPayload(kind, raw, isRecord(raw) && typeof raw.txnId === 'string');
      await restoreTxnPair(tx, p.txnId as string, typeof p.transferTxnId === 'string' ? p.transferTxnId : null);
      return;
    }
    case 'updateTxn': {
      const p = assertPayload(
        kind,
        raw,
        isRecord(raw) && typeof raw.txnId === 'string' && isRecord(raw.prev),
      );
      const { txnId, transferTxnId, prev, prevMirror, prevSubs } = p as {
        txnId: string;
        transferTxnId?: string | null;
        prev: Record<string, unknown>;
        prevMirror?: Record<string, unknown> | null;
        prevSubs?: { id: string; amount: number; categoryId: string | null; payeeId: string | null; memo: string | null; transferAccountId: string | null }[] | null;
      };
      const live = await tx.transaction.findFirst({ where: { id: txnId, deleted: false }, select: { id: true } });
      if (live) {
        await tx.transaction.update({ where: { id: txnId }, data: prev });
        if (transferTxnId && prevMirror) {
          const mirrorLive = await tx.transaction.findFirst({
            where: { id: transferTxnId, deleted: false },
            select: { id: true },
          });
          if (mirrorLive) {
            await tx.transaction.update({
              where: { id: transferTxnId },
              data: { date: prevMirror.date ?? '', amount: prevMirror.amount ?? 0 },
            });
          }
        }
        if (prevSubs) {
          await tx.subtransaction.deleteMany({ where: { transactionId: txnId } });
          for (const s of prevSubs) {
            await tx.subtransaction.create({
              data: {
                id: s.id,
                transactionId: txnId,
                amount: s.amount,
                categoryId: s.categoryId,
                payeeId: s.payeeId,
                memo: s.memo,
                transferAccountId: s.transferAccountId,
              },
            });
          }
        }
      }
      return;
    }
    case 'deleteCategory': {
      const p = assertPayload(kind, raw, isRecord(raw) && typeof raw.id === 'string');
      await tx.category.update({ where: { id: p.id as string }, data: { deleted: false } }).catch(() => undefined);
      return;
    }
    case 'deleteGroup': {
      const p = assertPayload(kind, raw, isRecord(raw) && typeof raw.id === 'string');
      await tx.categoryGroup.update({ where: { id: p.id as string }, data: { deleted: false } }).catch(() => undefined);
      return;
    }
    case 'reconcile': {
      const p = assertPayload(kind, raw, isRecord(raw) && typeof raw.accountId === 'string' && isStringArray(raw.flipped));
      const { accountId, adjustmentTxnId, flipped } = p as {
        accountId: string;
        adjustmentTxnId: string | null;
        flipped: string[];
      };
      if (adjustmentTxnId) {
        const adj = await tx.transaction.findFirst({ where: { id: adjustmentTxnId, deleted: false }, select: { id: true } });
        if (adj) await tx.transaction.update({ where: { id: adjustmentTxnId }, data: { deleted: true } });
      }
      if (flipped.length > 0) {
        await tx.transaction.updateMany({
          where: { id: { in: flipped }, deleted: false, cleared: 'reconciled' },
          data: { cleared: 'cleared' },
        });
      }
      return;
    }
    case 'hideCategory': {
      const p = assertPayload(kind, raw, isRecord(raw) && typeof raw.categoryId === 'string' && typeof raw.prevHidden === 'boolean');
      const live = await tx.category.findFirst({ where: { id: p.categoryId as string, deleted: false }, select: { id: true } });
      if (live) {
        await tx.category.update({ where: { id: p.categoryId as string }, data: { hidden: p.prevHidden as boolean } });
      }
      return;
    }
    case 'projectedOverride': {
      const p = assertPayload(
        kind,
        raw,
        isRecord(raw) && typeof raw.categoryId === 'string' && typeof raw.month === 'string',
      );
      const { categoryId, month } = p as { categoryId: string; month: string };
      const prev = typeof p.prev === 'number' ? (p.prev as number) : null;
      const next = typeof p.next === 'number' ? (p.next as number) : null;
      const where = { budgetId_categoryId_month: { budgetId, categoryId, month } };
      if (next === null) {
        // undo of a delete → recreate the override with its previous amount
        await tx.projectedOverride.upsert({
          where,
          create: { budgetId, categoryId, month, amount: prev ?? 0 },
          update: { amount: prev ?? 0 },
        });
      } else if (prev === null) {
        // undo of a set-on-empty → remove the override
        await tx.projectedOverride.deleteMany({ where: { budgetId, categoryId, month } });
      } else {
        // undo of a set → restore the previous amount
        await tx.projectedOverride.upsert({
          where,
          create: { budgetId, categoryId, month, amount: prev },
          update: { amount: prev },
        });
      }
      return;
    }
    case 'applyRules': {
      // payload: { ruleIds: string[], rows: [{ id, prev:{categoryId,payeeId,memo}, next:{...} }] }
      const p = assertPayload(kind, raw, isRecord(raw) && Array.isArray(raw.rows));
      const rows = (p as { rows: unknown }).rows as Record<string, unknown>[];
      for (const row of rows) {
        assertPayload(
          kind,
          row,
          isRecord(row) &&
            typeof row.id === 'string' &&
            isRecord(row.prev) &&
            ('categoryId' in row.prev || 'payeeId' in row.prev || 'memo' in row.prev),
        );
        const { id, prev } = row as {
          id: string;
          prev: { categoryId?: string | null; payeeId?: string | null; memo?: string | null };
        };
        const live = await tx.transaction.findFirst({ where: { id, deleted: false }, select: { id: true } });
        if (!live) continue;
        const data: Record<string, unknown> = {};
        if ('categoryId' in prev) data.categoryId = prev.categoryId ?? null;
        if ('payeeId' in prev) data.payeeId = prev.payeeId ?? null;
        if ('memo' in prev) data.memo = prev.memo ?? null;
        if (Object.keys(data).length > 0) await tx.transaction.update({ where: { id }, data });
      }
      return;
    }
    case 'mergePayees': {
      const p = assertPayload(
        kind,
        raw,
        isRecord(raw) &&
          typeof raw.fromId === 'string' &&
          typeof raw.toId === 'string' &&
          typeof raw.fromName === 'string' &&
          isStringArray(raw.txnIds) &&
          isStringArray(raw.subTxnIds),
      );
      const { fromId, toId, fromName, txnIds, subTxnIds } = p as {
        fromId: string;
        toId: string;
        fromName: string;
        txnIds: string[];
        subTxnIds: string[];
      };
      const to = await tx.payee.findUnique({ where: { id: toId } });
      if (!to) throw new PayloadError('Target payee no longer exists — cannot undo.');
      await tx.payee.create({ data: { id: fromId, budgetId, name: fromName } });
      if (txnIds.length > 0) {
        await tx.transaction.updateMany({ where: { id: { in: txnIds }, payeeId: toId }, data: { payeeId: fromId } });
      }
      if (subTxnIds.length > 0) {
        await tx.subtransaction.updateMany({ where: { id: { in: subTxnIds }, payeeId: toId }, data: { payeeId: fromId } });
      }
      // schedules that pointed at the source payee were moved too; their
      // pre-merge mapping is not recoverable — they stay on the target.
      return;
    }
    default:
      throw new PayloadError(`Unknown op kind: ${kind}`);
  }
}

async function softDeleteTxnPair(tx: DbTx, txnId: string, transferTxnId: string | null) {
  const live = await tx.transaction.findFirst({ where: { id: txnId, deleted: false }, select: { id: true } });
  if (live) await tx.transaction.update({ where: { id: txnId }, data: { deleted: true } });
  if (transferTxnId) {
    const other = await tx.transaction.findFirst({ where: { id: transferTxnId, deleted: false }, select: { id: true } });
    if (other) await tx.transaction.update({ where: { id: transferTxnId }, data: { deleted: true } });
  }
}

async function restoreTxnPair(tx: DbTx, txnId: string, transferTxnId: string | null) {
  const live = await tx.transaction.findFirst({ where: { id: txnId }, select: { id: true } });
  if (live) await tx.transaction.update({ where: { id: txnId }, data: { deleted: false } });
  if (transferTxnId) {
    const other = await tx.transaction.findFirst({ where: { id: transferTxnId }, select: { id: true } });
    if (other) await tx.transaction.update({ where: { id: transferTxnId }, data: { deleted: false } });
  }
}
