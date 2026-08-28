// Similarity engine tests: levenshtein, normalization, containment, exclusions.

import { strict as assert } from 'node:assert';
import { levenshtein, normalizePayeeName, findSimilarPayees } from './similarity';

export async function test() {
  // levenshtein basics
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('lidl', 'lidl'), 0);
  assert.equal(levenshtein('', 'abc'), 3);

  // normalization
  assert.equal(normalizePayeeName('  LIDL SAGT DANKE  '), 'lidl sagt danke');
  assert.equal(normalizePayeeName('Netto Marken-Discount 3710'), 'netto marken-discount');
  assert.equal(normalizePayeeName('Rewe GmbH'), 'rewe');
  assert.equal(normalizePayeeName('Foo S.R.L.'), 'foo');
  assert.equal(normalizePayeeName('S.R.L. Foo S.r.l.'), 's.r.l. foo'); // leading suffix kept — trailing stripped

  const P = (id: string, name: string, transfer = false) => ({ id, name, transferAccountId: transfer ? 'a1' : null });

  // near-identical names pair up
  let pairs = findSimilarPayees([P('1', 'Lidl', false), P('2', 'LIDL', false)]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].similarity, 1);

  // containment: long name containing a short one scores high
  pairs = findSimilarPayees([P('1', 'LIDL SAGT DANKE', false), P('2', 'Lidl', false), P('3', 'Rossmann', false)]);
  assert.equal(pairs.length, 1);
  assert.ok([pairs[0].fromId, pairs[0].toId].sort().join() === ['1', '2'].join());

  // transfer payees excluded
  pairs = findSimilarPayees([P('1', 'Transfer : BVR', true), P('2', 'Transfer : BVR', true)]);
  assert.equal(pairs.length, 0);

  // unrelated names stay apart
  pairs = findSimilarPayees([P('1', 'Aldi Nord', false), P('2', 'Jane Doe', false)]);
  assert.equal(pairs.length, 0);

  // a payee is a source at most once (best target wins)
  pairs = findSimilarPayees([
    P('1', 'Lidl', false),
    P('2', 'LIDL', false),
    P('3', 'Lidl Discount', false),
    P('4', 'Rewe', false),
  ]);
  assert.ok(pairs.length >= 1);
  const sources = new Set(pairs.map((p) => p.fromId));
  assert.equal(sources.size, pairs.length);

  console.log('similarity: ok');
}

test()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
