import { strict as assert } from 'node:assert';
import { applyRules, rankRules, RuleActionDef, RuleDraft, RuleLike } from './rules';

const draft = (over: Partial<RuleDraft> = {}): RuleDraft => ({
  payeeName: 'Amazon Marketplace',
  accountId: 'acct-1',
  memo: null,
  categoryId: null,
  ...over,
});

let seq = 0;
const mk = (
  conditions: RuleLike['conditions'],
  actions: RuleActionDef[],
  over: Partial<RuleLike> = {},
): RuleLike => ({
  id: `r${++seq}`,
  stage: 'default',
  enabled: true,
  conditions,
  actions,
  ...over,
});

export function test() {
  // ---- ranking: contains < is; all-precise doubles ----
  const broad = mk([{ field: 'payeeName', op: 'contains', value: 'amazon' }], [{ kind: 'category', categoryId: 'cat-broad' }]);
  const exact = mk([{ field: 'payeeName', op: 'is', value: 'Amazon Marketplace' }], [{ kind: 'category', categoryId: 'cat-exact' }]);
  const ranked = rankRules([exact, broad]);
  assert.equal(ranked[0].id, broad.id); // least specific first
  assert.equal(ranked[1].id, exact.id);

  // cumulative last-wins: the specific rule's category wins even though the
  // broad rule also matched
  const res = applyRules(draft(), [broad, exact]);
  assert.equal(res.patch.categoryId, 'cat-exact');
  assert.deepEqual(res.matchedRuleIds.sort(), [broad.id, exact.id].sort());

  // broad alone matches and applies
  assert.equal(applyRules(draft(), [broad]).patch.categoryId, 'cat-broad');

  // tie-break on identical scores: id order decides, LAST id wins
  // (deterministic regardless of array order)
  const lowId = mk([{ field: 'payeeName', op: 'contains', value: 'lidl' }], [{ kind: 'category', categoryId: 'cat-low' }]);
  const highId: RuleLike = { ...lowId, id: 'zz-higher-id', actions: [{ kind: 'category', categoryId: 'cat-high' }] };
  assert.equal(applyRules(draft({ payeeName: 'LIDL SAGT DANKE' }), [highId, lowId]).patch.categoryId, 'cat-high');
  assert.equal(applyRules(draft({ payeeName: 'LIDL SAGT DANKE' }), [lowId, highId]).patch.categoryId, 'cat-high');

  // ---- stages: pre runs before default before post, overriding ranking ----
  const preRenamer = mk(
    [{ field: 'payeeName', op: 'contains', value: 'amzn.com/bill' }],
    [{ kind: 'payeeName', name: 'Amazon' }],
    { stage: 'pre' },
  );
  const chained = applyRules(draft({ payeeName: 'AMZN.COM*5C7Q PURCHASE amzn.com/bill' }), [
    broad,
    preRenamer,
    exact,
  ]);
  // pre renamed first; the default-stage broad rule then matches "Amazon" and
  // sets its category; the exact rule no longer matches. Later rules always
  // see earlier rules' output.
  assert.equal(chained.patch.payeeName, 'Amazon');
  assert.equal(chained.patch.categoryId, 'cat-broad');
  assert.ok(!chained.matchedRuleIds.includes(exact.id));

  // post-stage wins after default
  const postOverride = mk(
    [{ field: 'payeeName', op: 'contains', value: 'amazon' }],
    [{ kind: 'category', categoryId: 'cat-post' }],
    { stage: 'post' },
  );
  const over = applyRules(draft(), [broad, exact, postOverride]);
  assert.equal(over.patch.categoryId, 'cat-post');

  // ---- disabled / malformed rules never run ----
  const off = mk([{ field: 'payeeName', op: 'contains', value: 'amazon' }], [{ kind: 'category', categoryId: 'cat-off' }], { enabled: false });
  assert.deepEqual(applyRules(draft(), [off]), { patch: {}, matchedRuleIds: [] });
  const emptyCond = mk([], [{ kind: 'category', categoryId: 'x' }]);
  assert.equal(applyRules(draft(), [emptyCond]).patch.categoryId, undefined);

  // ---- ops ----
  assert.equal(applyRules(draft({ memo: 'carta SUPERMERCATO' }), [
    mk([{ field: 'memo', op: 'contains', value: 'supermercato' }], [{ kind: 'appendNotes', text: '[groceries]' }]),
  ]).patch.memo, 'carta SUPERMERCATO [groceries]');

  // prepend composes onto an existing memo
  assert.equal(applyRules(draft({ memo: 'pos 12:04' }), [
    mk([{ field: 'memo', op: 'contains', value: 'pos' }], [{ kind: 'prependNotes', text: '[bank]' }]),
  ]).patch.memo, '[bank] pos 12:04');

  // memo condition matched, category unchanged → no category key in patch
  assert.equal(applyRules(draft({ memo: 'canone' }), [
    mk([{ field: 'memo', op: 'isNot', value: 'canone' }], [{ kind: 'category', categoryId: 'nope' }]),
  ]).patch.categoryId, undefined);

  // regex against raw value, case-insensitive, unicode flag
  const re = mk([{ field: 'payeeName', op: 'regex', value: '^AMZN\\.COM\\*[0-9A-Z]{4}' }], [{ kind: 'category', categoryId: 'cat-re' }]);
  assert.equal(applyRules(draft({ payeeName: 'AMZN.COM*5C7QC7MH0 AMZN.COM/BILL' }), [re]).patch.categoryId, 'cat-re');
  assert.equal(applyRules(draft({ payeeName: 'something else' }), [re]).patch.categoryId, undefined);

  // invalid regex never matches rather than throwing
  const badRe = mk([{ field: 'payeeName', op: 'regex', value: '(unclosed' }], [{ kind: 'category', categoryId: 'cat-badre' }]);
  assert.deepEqual(applyRules(draft(), [badRe]), { patch: {}, matchedRuleIds: [] });

  // is: trimmed + case-folded equality
  assert.equal(applyRules(draft({ payeeName: '  COOP ALLE GRU  ' }), [
    mk([{ field: 'payeeName', op: 'is', value: 'coop alle gru' }], [{ kind: 'category', categoryId: 'coop' }]),
  ]).patch.categoryId, 'coop');
  assert.equal(applyRules(draft({ payeeName: 'COOP GRU' }), [
    mk([{ field: 'payeeName', op: 'is', value: 'coop alle gru' }], [{ kind: 'category', categoryId: 'coop' }]),
  ]).patch.categoryId, undefined);

  // account field matching by account id
  assert.equal(applyRules(draft(), [
    mk([{ field: 'account', op: 'is', value: 'acct-other' }], [{ kind: 'category', categoryId: 'nope' }]),
  ]).patch.categoryId, undefined);
  assert.equal(applyRules(draft(), [
    mk([{ field: 'account', op: 'is', value: 'acct-1' }], [{ kind: 'appendNotes', text: '[checking]' }]),
  ]).patch.memo, '[checking]');

  // unicode folding through every string op
  for (const op of ['contains', 'is'] as const) {
    assert.equal(applyRules(draft({ payeeName: 'PIÙ GUSTO' }), [
      mk([{ field: 'payeeName', op, value: 'più gusto' }], [{ kind: 'category', categoryId: 'piu' }]),
    ]).patch.categoryId, 'piu', op);
  }

  // patch only includes changed keys; unchanged draft → empty patch
  const none = applyRules(draft({ categoryId: 'already' }), [mk([{ field: 'memo', op: 'contains', value: 'nothere' }], [{ kind: 'category', categoryId: 'other' }])]);
  assert.deepEqual(none.patch, {});

  // rename mid-pipeline then re-match? Rules run once each in order: a later
  // rule sees the renamed payee (Actual semantics).
  const renamerPre = mk([{ field: 'payeeName', op: 'contains', value: 'AMZN.COM/BILL' }], [{ kind: 'payeeName', name: 'Amazon' }], { stage: 'pre' });
  const catOnRenamed = mk([{ field: 'payeeName', op: 'is', value: 'amazon' }], [{ kind: 'category', categoryId: 'cat-after-rename' }]);
  const both = applyRules(draft({ payeeName: 'PURCHASE AMZN.COM/BILL x' }), [renamerPre, catOnRenamed]);
  assert.equal(both.patch.categoryId, 'cat-after-rename');

  // empty payee name never satisfies positive string conditions
  const emptyRes = applyRules(draft({ payeeName: '' }), [broad]);
  assert.deepEqual(emptyRes.patch, {});
}

test();
console.log('rules: ok');
