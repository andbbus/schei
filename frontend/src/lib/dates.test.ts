import { describe, expect, it } from 'vitest'
import { nextDates, nextOccurrence } from './dates'

describe('nextOccurrence', () => {
  it('weekly adds 7 days', () => {
    expect(nextOccurrence('weekly', '2026-08-14')).toBe('2026-08-21')
  })

  it('everyOtherWeek adds 14 days', () => {
    expect(nextOccurrence('everyOtherWeek', '2026-08-14')).toBe('2026-08-28')
  })

  it('monthly keeps the day-of-month, clamped to the month length', () => {
    expect(nextOccurrence('monthly', '2026-08-31')).toBe('2026-09-30')
    expect(nextOccurrence('monthly', '2026-01-31')).toBe('2026-02-28')
    expect(nextOccurrence('monthly', '2026-01-31', 31)).toBe('2026-02-28') // anchorDay clamped too
    expect(nextOccurrence('monthly', '2026-08-10', 10)).toBe('2026-09-10')
  })

  it('yearly adds a year with the anchor day', () => {
    expect(nextOccurrence('yearly', '2026-06-15')).toBe('2027-06-15')
    expect(nextOccurrence('yearly', '2024-02-29')).toBe('2025-02-28')
  })

  it('once has no next occurrence', () => {
    expect(nextOccurrence('once', '2026-08-14')).toBeNull()
  })
})

describe('nextDates', () => {
  it('returns n strictly-after dates, month drift-free', () => {
    expect(nextDates('monthly', '2026-08-31', 4, 31)).toEqual(['2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31'])
    expect(nextDates('weekly', '2026-08-14', 3)).toEqual(['2026-08-21', '2026-08-28', '2026-09-04'])
  })

  it('caps at 120 iterations for safety', () => {
    expect(nextDates('monthly', '2026-08-14', 200).length).toBe(120)
  })

  it('once yields nothing', () => {
    expect(nextDates('once', '2026-08-14', 3)).toEqual([])
  })
})
