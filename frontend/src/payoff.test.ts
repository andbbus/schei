import { describe, expect, it } from 'vitest'
import { amortize, balanceAtMonth, moneyWeightedRate, monthsToTarget, perMonthRate, requiredContribution, requiredPayment } from './payoff'
import { parsePercent } from './format'

describe('amortize', () => {
  it('known answer: €100.000 @4% TAN, 20y → P ≈ €605,98', () => {
    const p = requiredPayment(100000, 4, 240)
    expect(p).toBeCloseTo(605.98, 1)
    const sim = amortize({ balance: 100000, tanPercent: 4, payment: p, extra: 0 })
    expect(sim.payoffMonths).toBeGreaterThanOrEqual(240) // per-row cent rounding may add a month
    expect(sim.payoffMonths).toBeLessThanOrEqual(243)
    expect(sim.totalInterest).toBeGreaterThan(44500)
    expect(sim.totalInterest).toBeLessThan(46000)
    expect(sim.finalPayment).toBeLessThanOrEqual(p)
  })

  it('zero rate → straight division', () => {
    expect(requiredPayment(12000, 0, 12)).toBe(1000)
    const sim = amortize({ balance: 12000, tanPercent: 0, payment: 1000, extra: 0 })
    expect(sim.totalInterest).toBe(0)
    expect(sim.payoffMonths).toBe(12)
  })

  it('per-row rounding: final row is the exact residual, never negative', () => {
    const sim = amortize({ balance: 1000, tanPercent: 5, payment: 120, extra: 0 })
    const last = sim.rows[sim.rows.length - 1]
    expect(last.balance).toBe(0)
    expect(sim.rows.every((r) => r.balance >= 0)).toBe(true)
  })

  it('extra payment accelerates payoff', () => {
    const base = amortize({ balance: 20000, tanPercent: 6, payment: 400, extra: 0 })
    const boosted = amortize({ balance: 20000, tanPercent: 6, payment: 400, extra: 100 })
    expect(boosted.payoffMonths).toBeLessThan(base.payoffMonths)
  })

  it('payment below first-month interest → doesNotAmortize', () => {
    const sim = amortize({ balance: 100000, tanPercent: 10, payment: 100, extra: 0 })
    expect(sim.doesNotAmortize).toBe(true)
    expect(sim.rows).toHaveLength(0)
  })

  it('required payment for payoff-by-date rounds up to the cent', () => {
    const p = requiredPayment(100000, 4, 36)
    expect(p * 100).toBe(Math.ceil(p * 100))
    const sim = amortize({ balance: 100000, tanPercent: 4, payment: p, extra: 0 })
    expect(sim.payoffMonths).toBeLessThanOrEqual(37) // cent rounding of interest may push past the target month
  })
})

describe('savings rates', () => {
  it('money-weighted window handles lumpy income (grant month)', () => {
    const series = [
      { income: 100, expense: 900 },
      { income: 100, expense: 800 },
      { income: 100, expense: 700 },
      { income: 6000, expense: 1000 },
      { income: 100, expense: 600 },
      { income: 100, expense: 700 },
    ]
    const rate = moneyWeightedRate(series)
    expect(rate).toBeCloseTo((6500 - 4700) / 6500, 5)
  })

  it('income ≤ 0 → null', () => {
    expect(moneyWeightedRate([{ income: 0, expense: 100 }])).toBeNull()
    expect(moneyWeightedRate([{ income: -946, expense: 100 }])).toBeNull()
    expect(perMonthRate({ income: 0, expense: 100 })).toBeNull()
    expect(perMonthRate({ income: -10, expense: 5 })).toBeNull()
  })

  it('suppresses absurd spikes: expense ≥ 2×income → null', () => {
    expect(perMonthRate({ income: 7, expense: 1102 })).toBeNull() // the −15.600% case
    expect(perMonthRate({ income: 143, expense: 766 })).toBeNull() // −435%
    expect(perMonthRate({ income: 500, expense: 700 })).toBeCloseTo(-0.4, 5)
    expect(perMonthRate({ income: 500, expense: 300 })).toBeCloseTo(0.4, 5)
  })

  it('negative rates allowed in the money-weighted window', () => {
    expect(moneyWeightedRate([{ income: 1000, expense: 1200 }])).toBe(-0.2)
  })
})

describe('balanceAtMonth', () => {
  it('returns the balance after that month, clamped to the schedule', () => {
    const sim = amortize({ balance: 1000, tanPercent: 5, payment: 120, extra: 0 })
    expect(balanceAtMonth(sim.rows, 0)).toBeNull()
    expect(balanceAtMonth(sim.rows, 3)).toBe(sim.rows.find((r) => r.month === 3)?.balance)
    expect(balanceAtMonth(sim.rows, 9999)).toBe(0) // paid off
    expect(balanceAtMonth([], 1)).toBeNull()
  })

  it('matches the PROJECT.md-style residual projection', () => {
    // €2.500 capital residual @3% TAN, lump of €2.988 in December
    // (capital + accrued interest) → paid off in a single payment
    const sim = amortize({ balance: 2500, tanPercent: 3, payment: 2988, extra: 0 })
    expect(sim.payoffMonths).toBe(1)
    expect(balanceAtMonth(sim.rows, 1)).toBe(0)
  })
})

describe('goal math', () => {
  it('requiredContribution: gap spread over months, rounded up to the cent', () => {
    expect(requiredContribution(500, 3000, 10)).toBe(250)
    expect(requiredContribution(500, 3000, 12)).toBe(208.34) // 208.333 → up
    expect(requiredContribution(3000, 3000, 6)).toBe(0)
    expect(requiredContribution(4000, 3000, 6)).toBe(0)
    expect(requiredContribution(0, 100, 0)).toBe(0)
  })

  it('monthsToTarget', () => {
    expect(monthsToTarget(500, 3000, 250)).toBe(10)
    expect(monthsToTarget(500, 3000, 2500)).toBe(1)
    expect(monthsToTarget(3000, 3000, 100)).toBe(0)
    expect(monthsToTarget(500, 3000, 0)).toBeNull()
  })
})

describe('parsePercent', () => {
  it('handles comma/dot/% variants', () => {
    expect(parsePercent('4,5')).toBeCloseTo(0.045)
    expect(parsePercent('4.5%')).toBeCloseTo(0.045)
    expect(parsePercent('0')).toBe(0)
    expect(parsePercent('')).toBe(0)
  })
})
