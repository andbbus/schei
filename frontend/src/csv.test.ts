import { describe, expect, it } from 'vitest'
import { csvAmount, csvSeparators, sanitizeFilename, toCsv } from './csv'
import type { Currency } from './format'

const EUR: Currency = { symbol: '€', digits: 2, locale: 'it-IT' }
const USD: Currency = { symbol: '$', digits: 2, locale: 'en-US' }

describe('csvSeparators', () => {
  it('it-IT → semicolon + comma; en-US → comma + dot', () => {
    expect(csvSeparators('it-IT')).toEqual({ delim: ';', decimal: ',' })
    expect(csvSeparators('en-US')).toEqual({ delim: ',', decimal: '.' })
  })
})

describe('toCsv', () => {
  it('joins with the locale delimiter and appends BOM + CRLF', () => {
    const out = toCsv([['a', 'b'], ['1', '2']], 'it-IT')
    expect(out.startsWith('\uFEFF')).toBe(true)
    expect(out).toBe('\uFEFFa;b\r\n1;2\r\n')
  })

  it('quotes cells containing the delimiter or quotes', () => {
    const out = toCsv([['he;llo', 'say "hi"', 'plain']], 'it-IT')
    expect(out).toBe('\uFEFF"he;llo";"say ""hi""";plain\r\n')
  })

  it('null → empty cell', () => {
    expect(toCsv([[null, 'x']], 'en-US')).toBe('\uFEFF,x\r\n')
    expect(toCsv([[null, 'x']], 'it-IT')).toBe('\uFEFF;x\r\n')
  })

  it('injection guard prefixes = + - @ on free text', () => {
    const out = toCsv([['=SUM(A1)', '+44', '-cmd', '@import', 'ok']], 'en-US')
    expect(out).toBe('\uFEFF\'=SUM(A1),\'+44,\'-cmd,\'@import,ok\r\n')
  })

  it('numeric cells stay untouched by the injection guard', () => {
    expect(toCsv([[-17990, 50000]], 'en-US')).toBe('\uFEFF-17990,50000\r\n')
    expect(toCsv([[-17990, 50000]], 'it-IT')).toBe('\uFEFF-17990;50000\r\n')
  })
})

describe('csvAmount', () => {
  it('locale-formatted without the symbol, no -0', () => {
    expect(csvAmount(-17990, EUR)).toBe('-17,99')
    expect(csvAmount(500000, EUR)).toBe('500,00')
    expect(csvAmount(123456, USD)).toBe('123.46')
    expect(csvAmount(-0, EUR)).toBe('0,00')
  })
})

describe('sanitizeFilename', () => {
  it('replaces filesystem-hostile characters', () => {
    expect(sanitizeFilename('2026-08-14 Investments register.csv')).toBe(
      '2026-08-14 Investments register.csv',
    )
    expect(sanitizeFilename('a/b:c*d?e"f<g>h|i.csv')).toBe('a_b_c_d_e_f_g_h_i.csv')
  })
})
