import { describe, expect, it } from 'vitest'
import {
  TRANSFER_PREFIX,
  buildPickerOptions,
  filterPickerOptions,
  foldText,
  matchTransferName,
  transferLabel,
} from './payeePicker'

const payees = [
  { id: 'p1', name: 'Banca' },
  { id: 'p2', name: 'Città' },
  { id: 'p3', name: 'Aldi' },
]
const accounts = [
  { id: 'a1', name: 'Trade Republic', onBudget: true },
  { id: 'a2', name: 'Conto B', onBudget: true },
  { id: 'a3', name: 'Old', onBudget: true, closed: true },
]

describe('foldText', () => {
  it('strips case and diacritics', () => {
    expect(foldText('Città')).toBe('citta')
    expect(foldText(' ALDI ')).toBe(' aldi ')
  })
})

describe('buildPickerOptions', () => {
  it('lists accounts first then payees, alphabetical, skipping closed', () => {
    const opts = buildPickerOptions(payees, accounts)
    expect(opts.map((o) => [o.kind, o.name])).toEqual([
      ['account', 'Conto B'],
      ['account', 'Trade Republic'],
      ['payee', 'Aldi'],
      ['payee', 'Banca'],
      ['payee', 'Città'],
    ])
  })

  it('excludes the current account and builds transfer labels', () => {
    const opts = buildPickerOptions(payees, accounts, { excludeAccountId: 'a2' })
    expect(opts.some((o) => o.id === 'a2')).toBe(false)
    expect(opts.find((o) => o.id === 'a1')?.value).toBe(TRANSFER_PREFIX + 'Trade Republic')
  })

  it('hides legacy plain payees named like a transfer', () => {
    const opts = buildPickerOptions([...payees, { id: 'p9', name: TRANSFER_PREFIX + 'Conto B' }], accounts)
    expect(opts.some((o) => o.id === 'p9')).toBe(false)
  })
})

describe('filterPickerOptions', () => {
  it('returns everything on an empty query', () => {
    const opts = buildPickerOptions(payees, accounts)
    expect(filterPickerOptions(opts, '  ')).toHaveLength(opts.length)
  })

  it('matches names case- and diacritic-insensitively', () => {
    const opts = buildPickerOptions(payees, accounts)
    expect(filterPickerOptions(opts, 'citta').map((o) => o.name)).toEqual(['Città'])
    expect(filterPickerOptions(opts, 'trade').map((o) => o.name)).toEqual(['Trade Republic'])
  })
})

describe('matchTransferName', () => {
  it('resolves an exact transfer string to its account', () => {
    expect(matchTransferName(TRANSFER_PREFIX + 'Conto B', accounts)?.id).toBe('a2')
  })

  it('rejects plain payees, unknown names, closed and excluded accounts', () => {
    expect(matchTransferName('Conto B', accounts)).toBeNull()
    expect(matchTransferName(TRANSFER_PREFIX + 'Nope', accounts)).toBeNull()
    expect(matchTransferName(TRANSFER_PREFIX + 'Old', accounts)).toBeNull()
    expect(matchTransferName(TRANSFER_PREFIX + 'Conto B', accounts, { excludeAccountId: 'a2' })).toBeNull()
  })
})

describe('transferLabel', () => {
  it('prefixes the account name', () => {
    expect(transferLabel({ name: 'Conto B' })).toBe(`${TRANSFER_PREFIX}Conto B`)
  })
})
