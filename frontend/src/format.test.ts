import { describe, expect, it } from 'vitest'
import { parseAmount, evalExpression, normalizeAmount } from './format'

describe('parseAmount', () => {
  it('parses plain numbers to milliunits', () => {
    expect(parseAmount('12.5')).toBe(12500)
    expect(parseAmount('1.234,56')).toBe(1234560)
    expect(parseAmount('1,234.56')).toBe(1234560)
    expect(parseAmount('-17,99')).toBe(-17990)
    expect(parseAmount('')).toBe(0)
  })

  it('evaluates basic arithmetic expressions', () => {
    expect(parseAmount('5+3')).toBe(8000)
    expect(parseAmount('10-2')).toBe(8000)
    expect(parseAmount('2*4')).toBe(8000)
    expect(parseAmount('10/2')).toBe(5000)
  })

  it('respects operator precedence and parentheses', () => {
    expect(parseAmount('2+3*4')).toBe(14000)
    expect(parseAmount('(2+3)*4')).toBe(20000)
    expect(parseAmount('10-2-3')).toBe(5000)
    expect(parseAmount('100/5/2')).toBe(10000)
  })

  it('handles unary signs and mixed locales in expressions', () => {
    expect(parseAmount('-5+3')).toBe(-2000)
    expect(parseAmount('1.234,56+10')).toBe(1244560)
    expect(parseAmount('5+-3')).toBe(2000)
    expect(parseAmount('-(5+3)')).toBe(-8000)
  })

  it('returns 0 for malformed expressions instead of corrupting them', () => {
    expect(parseAmount('5+')).toBe(0)
    expect(parseAmount('5/0')).toBe(0)
    expect(parseAmount('*3')).toBe(0)
  })

  it('keeps legacy lenient behaviour for junk input', () => {
    expect(parseAmount('abc')).toBe(0)
    expect(parseAmount('12abc')).toBe(12000)
  })
})

describe('evalExpression', () => {
  it('returns the evaluated result or null', () => {
    expect(evalExpression('5+3')).toBe(8)
    expect(evalExpression('2*4-1')).toBe(7)
    expect(evalExpression('10 / 2')).toBe(5)
    expect(evalExpression('5+')).toBeNull()
    expect(evalExpression('abc')).toBeNull()
    expect(evalExpression('')).toBeNull()
  })
})

describe('normalizeAmount', () => {
  it('replaces expressions with their result and passes plain numbers through', () => {
    expect(normalizeAmount('5+3')).toBe('8')
    expect(normalizeAmount('10/2')).toBe('5')
    expect(normalizeAmount('2*4')).toBe('8')
    expect(normalizeAmount('1.234,56')).toBe('1.234,56')
    expect(normalizeAmount('12.5')).toBe('12.5')
    expect(normalizeAmount('-5')).toBe('-5')
    expect(normalizeAmount('5+')).toBe('5+')
  })
})