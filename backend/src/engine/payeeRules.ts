// Payee auto-categorization rules — bridge between Prisma rows and the general
// rules engine. Pure logic, no Prisma imports.
//
// A PayeeRule row stores ONE condition + ONE action:
//   condition: {field, op, value: pattern}  ("=" prefix on the pattern is the
//              legacy encoding of an exact "is" match)
//   action:    category | payeeName | prependNotes | appendNotes
//
// Matching runs ALL enabled rules through engine/rules.ts: ranked least- to
// most-specific, cumulative last-wins. System payees and transfers are never
// matched.

import { applyRules, fold, RuleActionDef, RuleCondition, RuleDraft, RuleLike, RuleField, RuleOp } from './rules';

export interface PayeeRuleRow {
  id: string;
  pattern: string; // normalized condition value ('=' prefix = legacy exact)
  field?: string | null; // payeeName | memo | account
  op?: string | null; // contains | is | regex | oneOf | …
  stage?: string | null;
  enabled?: boolean;
  action?: string | null; // category | payeeName | prependNotes | appendNotes
  categoryId?: string | null; // required when action = category
  actionText?: string | null; // payload of non-category actions
  createdAt?: Date;
}

export const SYSTEM_PAYEES = new Set([
  'Starting Balance',
  'Manual Balance Adjustment',
  'Reconciliation Balance Adjustment',
]);

export const TRANSFER_PREFIX = 'Transfer : ';

const VALID_FIELDS = new Set(['payeeName', 'memo', 'account']);
const VALID_OPS = new Set(['is', 'isNot', 'oneOf', 'notOneOf', 'contains', 'doesNotContain', 'regex']);
const VALID_STAGES = new Set(['pre', 'default', 'post']);
const VALID_ACTIONS = new Set(['category', 'payeeName', 'prependNotes', 'appendNotes']);

export function normalizePattern(input: string): string {
  return input.trim().replace(/\s+/g, ' ').toLowerCase();
}

function effectiveOp(row: Pick<PayeeRuleRow, 'pattern' | 'op'>): RuleOp {
  if (row.pattern.startsWith('=')) return 'is';
  const op = row.op ?? '';
  return (VALID_OPS.has(op) ? op : 'contains') as RuleOp;
}

function effectiveField(row: Pick<PayeeRuleRow, 'field' | 'pattern'>): RuleField {
  if (row.pattern.startsWith('=')) return 'payeeName'; // legacy rows were always payee rules
  const f = row.field ?? '';
  return (VALID_FIELDS.has(f) ? f : 'payeeName') as RuleField;
}

function rowToCondition(row: PayeeRuleRow): RuleCondition {
  const value = row.pattern.startsWith('=') ? row.pattern.slice(1) : row.pattern;
  return { field: effectiveField(row), op: effectiveOp(row), value };
}

function rowToActions(row: PayeeRuleRow): RuleActionDef[] {
  const action = row.action ?? 'category';
  switch (action) {
    case 'category':
      return row.categoryId ? [{ kind: 'category', categoryId: row.categoryId }] : [];
    case 'payeeName':
      return row.actionText?.trim() ? [{ kind: 'payeeName', name: row.actionText }] : [];
    case 'prependNotes':
      return row.actionText?.trim() ? [{ kind: 'prependNotes', text: row.actionText }] : [];
    case 'appendNotes':
      return row.actionText?.trim() ? [{ kind: 'appendNotes', text: row.actionText }] : [];
    default:
      return [];
  }
}

export function ruleToStage(row: Pick<PayeeRuleRow, 'stage' | 'pattern'>): string {
  const s = row.stage ?? '';
  return VALID_STAGES.has(s) ? s : 'default';
}

// Convert DB rows → engine rules. Category actions pointing at dead categories
// are dropped (a rule whose category was deleted must not re-categorize).
export function liveRules(rows: PayeeRuleRow[], liveCategoryIds: Set<string>): RuleLike[] {
  const out: RuleLike[] = [];
  for (const row of rows) {
    if (row.enabled === false) continue;
    const actions = rowToActions(row);
    if (actions.length === 0) continue;
    const acts =
      row.action === 'category'
        ? actions.filter((a) => a.kind !== 'category' || liveCategoryIds.has(a.categoryId))
        : actions;
    if (acts.length === 0) continue;
    out.push({
      id: row.id,
      stage: ruleToStage(row),
      enabled: true,
      conditionsOp: 'and',
      conditions: [rowToCondition(row)],
      actions: acts,
    });
  }
  return out;
}

// Guard: system payees / transfers never participate in matching.
export function matchablePayee(name: string | null | undefined): string | null {
  const n = name?.trim() ?? '';
  if (!n) return null;
  if (SYSTEM_PAYEES.has(n) || n.startsWith(TRANSFER_PREFIX)) return null;
  return n;
}

export interface DerivedPatch {
  categoryId?: string | null;
  payeeName?: string | null;
  memo?: string | null;
  matchedRuleIds: string[];
}

// Run the full pipeline over a draft built from raw inputs.
export function derivePatch(
  input: { payeeName?: string | null; accountId?: string | null; memo?: string | null; categoryId?: string | null },
  rules: PayeeRuleRow[],
  liveCategoryIds: Set<string>,
): DerivedPatch {
  const draft: RuleDraft = {
    payeeName: matchablePayee(input.payeeName),
    accountId: input.accountId ?? null,
    memo: input.memo ?? null,
    categoryId: input.categoryId ?? null,
  };
  const lr = liveRules(rules, liveCategoryIds);
  const res = applyRules(draft, lr);
  return { ...res.patch, matchedRuleIds: res.matchedRuleIds };
}

// Explicit category wins when set; otherwise the ranked pipeline decides.
// NOTE (behavior change): conflicting substring rules no longer resolve by
// creation order — most-specific wins, ties broken by rule id, last applies.
export function pickCategory(
  payeeName: string | null | undefined,
  rules: PayeeRuleRow[],
  liveCategoryIds: Set<string>,
  explicit: string | null | undefined,
): string | null {
  if (explicit) return explicit;
  if (!matchablePayee(payeeName)) return null;
  return derivePatch({ payeeName }, rules, liveCategoryIds).categoryId ?? null;
}
