import { strict as assert } from 'node:assert';
import { derivePatch, normalizePattern, PayeeRuleRow, pickCategory } from './payeeRules';

const ALL = new Set(['cat-a', 'cat-b', 'cat-c', 'cat-x', 'cat-sub', 'cat-exact', 'cat-piu', 'cat-cafe', 'cat-any', 'cat-t', 'cat-dead', 'cat-off', 'cat-re', 'cat-cat-on-canonical']);
const row = (
  id: string,
  pattern: string,
  createdAt = new Date(0),
  over: Partial<PayeeRuleRow> = {},
): PayeeRuleRow => ({ id, pattern, categoryId: 'cat-' + id, action: 'category', createdAt, ...over });

export function test() {
  assert.equal(normalizePattern('  Jane   Doe '), 'jane doe');
  assert.equal(normalizePattern('=Lidl'), '=lidl');

  // legacy "=" prefix forces exact matching on the payee name; exact (more
  // specific) runs AFTER the substring rule and therefore wins under
  // cumulative last-wins
  const rules = [row('sub', 'lidl', new Date(1000)), row('exact', '=lidl', new Date(2000))];
  assert.equal(pickCategory('LIDL', rules, ALL, null), 'cat-exact');
  assert.equal(pickCategory('LIDL SAGT DANKE', rules, ALL, null), 'cat-sub');

  // identical scores (same pattern): deterministic id tie-break, last id wins
  const dup = [
    row('b', 'lidl', new Date(1000), { categoryId: 'cat-b' }),
    row('a', 'lidl', new Date(2000), { categoryId: 'cat-a' }),
  ];
  assert.equal(pickCategory('Lidl', dup, ALL, null), 'cat-b');

  // Unicode case folding (Italian/French)
  assert.equal(pickCategory('PIÙ', [row('piu', 'più')], ALL, null), 'cat-piu');
  assert.equal(pickCategory('CAFÉ', [row('cafe', 'café')], ALL, null), 'cat-cafe');

  // system payees and transfers never match
  for (const name of ['Starting Balance', 'Manual Balance Adjustment', 'Reconciliation Balance Adjustment']) {
    assert.equal(pickCategory(name, [row('any', name)], ALL, null), null);
  }
  assert.equal(pickCategory('Transfer : Main Bank', [row('t', 'transfer')], ALL, null), null);

  // empty payee
  assert.equal(pickCategory('', [row('any', 'x')], ALL, null), null);
  assert.equal(pickCategory('   ', [row('any', 'x')], ALL, null), null);

  // deleted categories excluded (rule is dropped from the pipeline)
  assert.equal(pickCategory('Lidl', [row('dead', 'lidl')], new Set(), null), null);

  // explicit category always wins
  assert.equal(pickCategory('Lidl', [row('a', 'lidl')], ALL, 'cat-explicit'), 'cat-explicit');

  // disabled rules are skipped entirely
  assert.equal(
    pickCategory('Lidl', [row('off', 'lidl', new Date(0), { enabled: false })], ALL, null),
    null,
  );
  // …even with a matching enabled fallback present elsewhere
  const offVsOn = [
    row('off', 'lidl', new Date(0), { enabled: false }),
    row('a', 'lidl', new Date(0)),
  ];
  assert.equal(pickCategory('Lidl', offVsOn, ALL, null), 'cat-a');

  // regex op rows
  assert.equal(
    pickCategory('AMZN.COM*5C7Q BILL', [row('re', '^amzn\\.com\\*', new Date(0), { op: 'regex' })], ALL, null),
    'cat-re',
  );

  // ---- derivePatch: multi-action pipeline across condition fields ----
  const mixed: PayeeRuleRow[] = [
    row('rename', '=amzn.com*5c7qc7mh0 am 10/26 purchase', new Date(0), {
      action: 'payeeName',
      actionText: 'Amazon',
      categoryId: undefined,
    }),
    row('amzn-cat', 'amazon', new Date(0)),
    row('memo-tag', 'pos', new Date(0), { field: 'memo', op: 'contains', action: 'appendNotes', actionText: '[card]', categoryId: undefined }),
    row('acct-flag', 'acct-9', new Date(0), { field: 'account', op: 'is', action: 'prependNotes', actionText: '[imported]', categoryId: undefined }),
  ];
  const res = derivePatch(
    { payeeName: 'AMZN.COM*5C7QC7MH0 AM 10/26 PURCHASE', accountId: 'acct-9', memo: 'pos 12:00' },
    mixed,
    ALL,
  );
  // Ranking: zero-score rules first in id order (acct-flag, amzn-cat,
  // memo-tag), the all-precise rename LAST. memo composes through both note
  // actions; the rename fires even though it runs last.
  assert.equal(res.payeeName, 'Amazon');
  assert.equal(res.memo, '[imported] pos 12:00 [card]');
  assert.equal(res.categoryId, undefined); // amzn-cat missed ('AMZN.COM' has no 'amazon')
  assert.deepEqual([...res.matchedRuleIds].sort(), ['acct-flag', 'memo-tag', 'rename'].sort());

  // A pre-stage rename runs FIRST, so later rules see the canonical name —
  // Actual's "clean ugly import names, then categorize" flow.
  const learningFlow: PayeeRuleRow[] = [
    row('cat-on-canonical', '=amazon'),
    { ...row('ugly-rename', 'amzn.com/', new Date(0)), action: 'payeeName', categoryId: undefined, stage: 'pre', op: 'contains', field: 'payeeName', actionText: 'Amazon' } as PayeeRuleRow,
  ];
  const res2 = derivePatch({ payeeName: 'PURCHASE AMZN.COM/BILL #1', accountId: null, memo: null }, learningFlow, ALL);
  assert.equal(res2.categoryId, 'cat-cat-on-canonical');

  // derivation ignores rows with dead category targets but keeps note/rename actions alive
  const halfDead = [
    row('deadcat', 'lidl', new Date(0), { categoryId: 'cat-dead' }),
    row('tagger', 'lidl', new Date(0), { action: 'appendNotes', actionText: '[x]', categoryId: undefined }),
  ];
  // derivation ignores rows with dead category targets but keeps note/rename actions alive
  const withoutDead = new Set([...ALL].filter((c) => c !== 'cat-dead'));
  const res3 = derivePatch({ payeeName: 'Lidl Filiale', accountId: null, memo: null }, halfDead, withoutDead);
  assert.equal(res3.categoryId, undefined);
  assert.equal(res3.memo, '[x]');
}

test();
console.log('payeeRules: ok');
