// General transaction rules engine — pure logic, no Prisma. Modeled on Actual
// Budget's rule pipeline (loot-core/src/server/rules): rules carry one
// condition (field/op/value) and one action, run cumulatively in ranked order
// (least specific first), so the most specific rule's action wins. Stages
// (pre/default/post) bracket the automatic ranking.
//
// Conditions over: payeeName | memo | account. Ops: is/isNot, oneOf/notOneOf,
// contains/doesNotContain, regex. All string matching is Unicode case-folded
// ("PIÙ" → "più", "FRANKFURT" → "frankfurt") except regex, which matches the
// raw value case-insensitively.

export type RuleField = 'payeeName' | 'memo' | 'account';
export type RuleOp = 'is' | 'isNot' | 'oneOf' | 'notOneOf' | 'contains' | 'doesNotContain' | 'regex';
export type RuleStage = 'pre' | 'default' | 'post';

export interface RuleCondition {
  field: RuleField;
  op: RuleOp;
  value: string;
}

export type RuleActionDef =
  | { kind: 'category'; categoryId: string }
  | { kind: 'payeeName'; name: string }
  | { kind: 'prependNotes'; text: string }
  | { kind: 'appendNotes'; text: string };

export interface RuleLike {
  id: string;
  stage?: string | null; // pre | default | post (null → default)
  enabled?: boolean;
  conditions: RuleCondition[];
  actions: RuleActionDef[];
  conditionsOp?: 'and' | 'or' | null;
}

// A transaction-in-progress draft the pipeline can patch.
export interface RuleDraft {
  payeeName: string | null;
  accountId: string | null;
  memo: string | null;
  categoryId: string | null;
}

// Ranking ---------------------------------------------------------------

const OP_SCORES: Record<RuleOp, number> = {
  is: 10,
  isNot: 10,
  oneOf: 9,
  notOneOf: 9,
  contains: 0,
  doesNotContain: 0,
  regex: 0,
};

function computeScore(rule: RuleLike): number {
  const sum = rule.conditions.reduce((s, c) => s + (OP_SCORES[c.op] ?? 0), 0);
  // All-precise rules double their score so they always rank after any rule
  // with a vague (contains/regex) condition.
  const allPrecise =
    rule.conditions.length > 0 &&
    rule.conditions.every((c) => c.op === 'is' || c.op === 'isNot' || c.op === 'oneOf' || c.op === 'notOneOf');
  return allPrecise ? sum * 2 : sum;
}

function _rank(rules: RuleLike[]): RuleLike[] {
  return [...rules].sort((a, b) => {
    const d = computeScore(a) - computeScore(b);
    if (d !== 0) return d;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// Deterministic execution order: pre → default → post, least specific first,
// ties broken by id. Most specific runs last, so it wins under last-wins.
export function rankRules(rules: RuleLike[]): RuleLike[] {
  const pre: RuleLike[] = [];
  const normal: RuleLike[] = [];
  const post: RuleLike[] = [];
  for (const r of rules) {
    if (!r.enabled) continue;
    if (r.conditions.length === 0 || r.actions.length === 0) continue;
    if (r.stage === 'pre') pre.push(r);
    else if (r.stage === 'post') post.push(r);
    else normal.push(r);
  }
  return [..._rank(pre), ..._rank(normal), ..._rank(post)];
}

// Condition evaluation --------------------------------------------------

export function fold(s: string): string {
  return s.toLocaleLowerCase('und');
}

const REGEX_MAX = 200;

function evalCondition(c: RuleCondition, draft: RuleDraft): boolean {
  let raw: string;
  switch (c.field) {
    case 'payeeName':
      raw = draft.payeeName ?? '';
      break;
    case 'memo':
      raw = draft.memo ?? '';
      break;
    case 'account':
      raw = draft.accountId ?? '';
      break;
  }
  const foldedValue = fold(c.value.trim());
  switch (c.op) {
    case 'is':
      return fold(raw.trim()) === foldedValue && foldedValue !== '';
    case 'isNot':
      return !(fold(raw.trim()) === foldedValue);
    case 'contains':
      return foldedValue !== '' && fold(raw).includes(foldedValue);
    case 'doesNotContain':
      return !(foldedValue !== '' && fold(raw).includes(foldedValue));
    case 'oneOf': {
      // oneOf values are comma-separated in a single stored pattern
      const list = c.value.split(',').map((v) => v.trim()).filter((v) => v !== '');
      return list.some((v) => fold(v) === fold(raw.trim()) && fold(v) !== '');
    }
    case 'notOneOf': {
      const list = c.value.split(',').map((v) => v.trim()).filter((v) => v !== '');
      return !list.some((v) => fold(v) === fold(raw.trim()));
    }
    case 'regex': {
      if (!c.value || c.value.length > REGEX_MAX) return false;
      try {
        return new RegExp(c.value, 'iu').test(raw);
      } catch {
        return false; // invalid regex never matches
      }
    }
  }
}

function evalConditions(rule: RuleLike, draft: RuleDraft): boolean {
  const method = rule.conditionsOp === 'or' ? 'some' : 'every';
  return rule.conditions[method]((c) => evalCondition(c, draft));
}

// Actions ---------------------------------------------------------------

function applyAction(a: RuleActionDef, d: RuleDraft): void {
  switch (a.kind) {
    case 'category':
      d.categoryId = a.categoryId;
      break;
    case 'payeeName':
      d.payeeName = a.name;
      break;
    case 'prependNotes':
      d.memo = a.text + (d.memo ? ` ${d.memo}` : '');
      break;
    case 'appendNotes':
      d.memo = (d.memo ? `${d.memo} ` : '') + a.text;
      break;
  }
}

export interface RulePipelineResult {
  patch: Partial<Pick<RuleDraft, 'payeeName' | 'memo' | 'categoryId'>>;
  matchedRuleIds: string[];
}

// Run every enabled+well-formed rule (ranked); matching rules apply their
// actions cumulatively onto the draft — later (more specific) rules win.
// Returns only the keys that changed plus which rule ids matched.
export function applyRules(draft: RuleDraft, rules: RuleLike[]): RulePipelineResult {
  const work: RuleDraft = { ...draft };
  const matched: string[] = [];
  for (const rule of rankRules(rules)) {
    if (!evalConditions(rule, work)) continue;
    matched.push(rule.id);
    for (const a of rule.actions) applyAction(a, work);
  }
  const patch: RulePipelineResult['patch'] = {};
  if (work.categoryId !== draft.categoryId) patch.categoryId = work.categoryId;
  if (work.payeeName !== draft.payeeName) patch.payeeName = work.payeeName;
  if ((work.memo ?? null) !== (draft.memo ?? null)) patch.memo = work.memo ?? '';
  return { patch, matchedRuleIds: matched };
}
