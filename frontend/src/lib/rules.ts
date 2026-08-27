// Frontend mirror of the backend rules engine (backend/src/engine/rules.ts +
// payeeRules.ts). Kept intentionally small: it powers the register's live
// category prefill and hint chip. The server always re-applies authoritatively
// on save, so this only needs to agree on outcome, not on every feature.

export interface RuleLite {
  id: string;
  pattern: string; // normalized condition value ('=' prefix = legacy exact)
  field?: string | null; // payeeName | memo | account
  op?: string | null;
  stage?: string | null;
  enabled?: boolean;
  action?: string | null; // category | payeeName | prependNotes | appendNotes
  categoryId?: string | null;
  categoryName?: string | null;
  actionText?: string | null;
}

export interface RuleDraft {
  payeeName: string | null;
  memo: string | null;
  categoryId: string | null;
}

const OP_SCORES: Record<string, number> = {
  is: 10,
  isNot: 10,
  oneOf: 9,
  notOneOf: 9,
  contains: 0,
  doesNotContain: 0,
  regex: 0,
};

export function fold(s: string): string {
  return s.toLocaleLowerCase('und');
}

function computeScore(rule: RuleLike): number {
  const cond = rule.conditions[0];
  const sum = OP_SCORES[cond.op] ?? 0;
  return cond.op === 'is' || cond.op === 'isNot' || cond.op === 'oneOf' || cond.op === 'notOneOf' ? sum * 2 : sum;
}

type RuleLike = { id: string; conditions: { field: string; op: string; value: string }[]; actions: RuleAction[] };
type RuleAction =
  | { kind: 'category'; categoryId: string }
  | { kind: 'payeeName'; name: string }
  | { kind: 'prependNotes'; text: string }
  | { kind: 'appendNotes'; text: string };

function toRule(r: RuleLite): RuleLike | null {
  if (r.enabled === false) return null;
  const actions: RuleAction[] = [];
  if ((r.action ?? 'category') === 'category' && r.categoryId) actions.push({ kind: 'category', categoryId: r.categoryId });
  if (r.action === 'payeeName' && r.actionText?.trim()) actions.push({ kind: 'payeeName', name: r.actionText.trim() });
  if (r.action === 'prependNotes' && r.actionText?.trim()) actions.push({ kind: 'prependNotes', text: r.actionText.trim() });
  if (r.action === 'appendNotes' && r.actionText?.trim()) actions.push({ kind: 'appendNotes', text: r.actionText.trim() });
  if (actions.length === 0) return null;
  let op = r.pattern.startsWith('=') ? 'is' : r.op ?? 'contains';
  let value = r.pattern.startsWith('=') ? r.pattern.slice(1) : r.pattern;
  if (op === 'regex' && value.length <= 200) {
    try {
      new RegExp(value, 'iu');
    } catch {
      return null;
    }
  } else if (op === 'regex') {
    return null;
  }
  const fieldRaw = r.pattern.startsWith('=') ? 'payeeName' : r.field ?? 'payeeName';
  if (!['payeeName', 'memo', 'account'].includes(fieldRaw)) return null;
  void op;
  return {
    id: r.id,
    conditions: [{ field: fieldRaw, op, value }],
    actions,
  };
}

function evalCondition(cond: { field: string; op: string; value: string }, draft: RuleDraft): boolean {
  const raw = cond.field === 'memo' ? draft.memo ?? '' : cond.field === 'account' ? '' : draft.payeeName ?? '';
  const foldedVal = fold(cond.value.trim());
  switch (cond.op) {
    case 'is':
      return fold(raw.trim()) === foldedVal && foldedVal !== '';
    case 'isNot':
      return fold(raw.trim()) !== foldedVal;
    case 'contains':
      return foldedVal !== '' && fold(raw).includes(foldedVal);
    case 'doesNotContain':
      return !(foldedVal !== '' && fold(raw).includes(foldedVal));
    case 'oneOf':
      return cond.value
        .split(',')
        .map((v) => v.trim())
        .some((v) => v !== '' && fold(v) === fold(raw.trim()));
    case 'notOneOf':
      return !cond.value
        .split(',')
        .map((v) => v.trim())
        .some((v) => v !== '' && fold(v) === fold(raw.trim()));
    case 'regex': {
      try {
        return new RegExp(cond.value, 'iu').test(raw);
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

// NOTE: the frontend has no account ids in scope while prefilling an editor row
// (only names), so account-field rules are evaluated against empty strings —
// they contribute ranking noise but never fire here. Server is authoritative.
export interface PrefillResult {
  patch: Partial<Pick<RuleDraft, 'payeeName' | 'memo' | 'categoryId'>>;
  sourcePattern: string | null;
}

// Cumulative last-wins over ranked rules; mirrors engine.applyRules.
export function prefillFromRules(draft: RuleDraft, rules: RuleLite[]): PrefillResult {
  const compiled = rules.map(toRule);
  const valid = new Map<string, RuleLike>();
  compiled.forEach((c, i) => {
    if (c) valid.set(rules[i].id, c);
  });
  const ranked = [...valid.values()].sort((a, b) => {
    const d = computeScore(a) - computeScore(b);
    if (d !== 0) return d;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const work: RuleDraft = { ...draft };
  let source: string | null = null;
  for (const rule of ranked) {
    const cond = rule.conditions[0];
    if (!evalCondition(cond, work)) continue;
    for (const a of rule.actions) {
      if (a.kind === 'category') work.categoryId = a.categoryId;
      else if (a.kind === 'payeeName') work.payeeName = a.name;
      else if (a.kind === 'prependNotes') work.memo = a.text + (work.memo ? ` ${work.memo}` : '');
      else if (a.kind === 'appendNotes') work.memo = `${work.memo ? work.memo + ' ' : ''}${a.text}`;
    }
    const byCat = rule.actions.some((a) => a.kind === 'category');
    if (byCat && source === null) source = rules.find((r) => r.id === rule.id)?.pattern ?? rule.id;
  }
  const patch: PrefillResult['patch'] = {};
  if (work.categoryId !== draft.categoryId) patch.categoryId = work.categoryId;
  if (work.payeeName !== draft.payeeName) patch.payeeName = work.payeeName;
  if ((work.memo ?? null) !== (draft.memo ?? null)) patch.memo = work.memo ?? '';
  return { patch, sourcePattern: source };
}
