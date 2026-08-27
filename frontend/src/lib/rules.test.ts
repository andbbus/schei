import { describe, expect, it } from 'vitest'
import { prefillFromRules, RuleLite } from './rules'

const rule = (id: string, over: Partial<RuleLite> = {}): RuleLite => ({
  id,
  pattern: 'lidl',
  action: 'category',
  categoryId: 'cat-' + id,
  categoryName: 'Cat ' + id,
  ...over,
})

describe('prefillFromRules', () => {
  it('matches a plain substring and returns the category', () => {
    const res = prefillFromRules(
      { payeeName: 'LIDL SAGT DANKE', memo: null, categoryId: null },
      [rule('a')],
    )
    expect(res.patch.categoryId).toBe('cat-a')
    expect(res.sourcePattern).toBe('lidl')
  })

  it('legacy "=" prefix forces exact matching', () => {
    const rules = [rule('sub'), { ...rule('ex'), pattern: '=lidl' }]
    const exact = prefillFromRules({ payeeName: 'lidl', memo: null, categoryId: null }, rules)
    expect(exact.patch.categoryId).toBe('cat-ex')

    const longer = prefillFromRules({ payeeName: 'LIDLISH', memo: null, categoryId: null }, rules)
    expect(longer.patch.categoryId).toBe('cat-sub')
  })

  it('most specific wins under conflicts (ranked last-wins)', () => {
    const rules = [
      rule('broad', { pattern: 'coop', categoryId: 'cat-broad' }),
      rule('exact', { pattern: '=coop alle gru', categoryId: 'cat-exact' }),
    ]
    const res = prefillFromRules({ payeeName: 'COOP ALLE GRU', memo: null, categoryId: null }, rules)
    expect(res.patch.categoryId).toBe('cat-exact') // both match; the precise one runs last
  })

  it('disabled rules are skipped', () => {
    const res = prefillFromRules(
      { payeeName: 'Lidl', memo: null, categoryId: null },
      [rule('off', { enabled: false })],
    )
    expect(res.patch.categoryId).toBeUndefined()
    expect(res.sourcePattern).toBeNull()
  })

  it('regex rules work against the raw name', () => {
    const res = prefillFromRules(
      { payeeName: 'AMZN.COM*5C7Q BILL', memo: null, categoryId: null },
      [rule('re', { pattern: '^amzn\\.com\\*', op: 'regex' })],
    )
    expect(res.patch.categoryId).toBe('cat-re')
  })

  it('memo-field conditions fire on the draft memo', () => {
    const res = prefillFromRules(
      { payeeName: 'POS Trade', memo: 'canone mensile', categoryId: null },
      [rule('memo', { field: 'memo', pattern: 'canone' })],
    )
    expect(res.patch.categoryId).toBe('cat-memo')
  })

  it('rename + notes actions compose like the server pipeline', () => {
    const rules: RuleLite[] = [
      rule('tag', { pattern: 'pos', field: 'memo', action: 'appendNotes', actionText: '[card]', categoryId: undefined as unknown as string }),
      rule('ren', { pattern: 'amzn.com/', action: 'payeeName', actionText: 'Amazon' }),
    ]
    const res = prefillFromRules(
      { payeeName: 'PURCHASE AMZN.COM/BILL #9', memo: 'pos', categoryId: null },
      rules,
    )
    expect(res.patch.payeeName).toBe('Amazon')
    expect(res.patch.memo).toBe('pos [card]')
  })
})
