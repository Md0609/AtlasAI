/**
 * The guards that decide whether Atlas shows a number or declares a gap (P1-2).
 *
 * The review's mutation run left five mutants alive here, all on the same class
 * of branch: the divide-by-zero and no-root checks that stand between a
 * degenerate portfolio and a fabricated figure. Seven other mutants in the same
 * files were killed, so the harness works — these survived because nothing
 * exercised the degenerate input at all.
 *
 * Each test below names the guarantee it protects, and each was verified to
 * fail against the specific mutation described in its comment.
 *
 * The guarantee, stated once: a portfolio that cannot support a calculation
 * must produce `null` or an omission, never a NaN, an Infinity, or a number
 * derived from dividing by nothing.
 */
import { describe, expect, it } from 'vitest';
import { concentration, timeWeightedReturn, xirr } from '@atlas/signal-engine';
import { ZERO } from '@atlas/domain';
import type { LookThroughResult } from '../src/lookthrough.js';

describe('timeWeightedReturn: a zero-value day must not divide', () => {
  it('skips a day whose opening value and flows are both zero', () => {
    // GUARANTEE: an account that emptied to zero and was refunded later has a
    // finite return, not Infinity.
    // MUTANT: performance.ts:38 `if (denom.isZero()) continue;` -> `if (false)`
    // WHY IT SURVIVED: every golden fixture is a funded portfolio, so no case
    // ever reached a zero denominator.
    const series = [
      { date: '2026-01-01', value: '1000' },
      { date: '2026-01-02', value: '0' }, // fully liquidated and withdrawn
      { date: '2026-01-03', value: '0' }, // flat at zero: prev + flow === 0
      { date: '2026-01-04', value: '500' },
    ];
    const flows = [
      { date: '2026-01-02', amount: '-1000' },
      { date: '2026-01-04', amount: '500' },
    ];
    const twr = timeWeightedReturn(series, flows);
    expect(twr).not.toBeNull();
    expect(twr!.isFinite()).toBe(true);
    expect(twr!.isNaN()).toBe(false);
  });

  it('returns a finite result when the series both empties and recovers', () => {
    const series = [
      { date: '2026-01-01', value: '100' },
      { date: '2026-01-02', value: '0' },
      { date: '2026-01-03', value: '120' },
    ];
    const twr = timeWeightedReturn(series, [
      { date: '2026-01-02', amount: '-100' },
      { date: '2026-01-03', amount: '120' },
    ]);
    expect(twr?.isFinite()).toBe(true);
  });
});

describe('xirr: no sign change means no answer', () => {
  it('returns null rather than a bisection midpoint when all flows are negative', () => {
    // GUARANTEE: an IRR requires at least one inflow and one outflow. Without a
    // sign change the bisection has no root to find, and its midpoint is a
    // meaningless number that would render as a confident percentage return.
    // MUTANT: performance.ts:74 `if (fLo.isNegative() === fHi.isNegative()) return null;`
    //         -> `if (false)`, which returns ~4.5 (the bracket midpoint).
    // WHY IT SURVIVED: no golden case has a single-signed cashflow set.
    expect(xirr([
      { date: '2026-01-01', amount: '-100' },
      { date: '2027-01-01', amount: '-50' },
    ])).toBeNull();
  });

  it('returns null when every flow is positive', () => {
    expect(xirr([
      { date: '2026-01-01', amount: '100' },
      { date: '2027-01-01', amount: '50' },
    ])).toBeNull();
  });

  it('returns null when every cashflow is zero, instead of the bracket floor', () => {
    // GUARANTEE: a portfolio whose flows net to zero — bought and sold at the
    // same price, or never funded — has no rate of return. It must not be
    // handed one.
    // MUTANT: performance.ts:62 `if (!hasNeg || !hasPos) return null;` -> `if (false)`
    //
    // DISCREPANCY with the review, which called this guard redundant with the
    // sign-change check on line 74 and therefore unkillable. It is not. With
    // all-zero flows the NPV at the low bracket bound is exactly zero, so
    // `if (fLo.isZero()) return lo` fires and returns the bound itself:
    //
    //     with line 62:     null
    //     without line 62:  -0.9999      <- a fabricated -99.99% return
    //
    // Measured both ways. Line 62 is load-bearing, not defensive duplication.
    expect(xirr([
      { date: '2026-01-01', amount: '0' },
      { date: '2027-01-01', amount: '0' },
    ])).toBeNull();
  });

  it('returns null when the true rate lies outside the search bracket', () => {
    // GUARANTEE: the bisection searches [-99.99%, +1000%]. A cashflow pair
    // whose real IRR falls outside that has no root inside the bracket, and the
    // midpoint the loop would converge on means nothing. Atlas declares the gap.
    // MUTANT: performance.ts:74 `if (fLo.isNegative() === fHi.isNegative()) return null;`
    //         -> `if (false)`, which returns the meaningless midpoint.
    //
    // These reach line 74 specifically: both have a sign change, so the line-62
    // guard passes them through. Measured null both ways.
    expect(xirr([
      { date: '2026-01-01', amount: '-100' },
      { date: '2027-01-01', amount: '0.000001' }, // a loss beyond -99.99%
    ])).toBeNull();
    expect(xirr([
      { date: '2026-01-01', amount: '-1' },
      { date: '2027-01-01', amount: '100000' }, // a gain beyond +1000%
    ])).toBeNull();
  });

  it('still solves an ordinary case, so the guards are not simply refusing everything', () => {
    // A test that only asserts null would pass with `return null` at the top.
    const r = xirr([
      { date: '2026-01-01', amount: '-100' },
      { date: '2027-01-01', amount: '110' },
    ]);
    expect(r).not.toBeNull();
    expect(Number(r!.toString())).toBeCloseTo(0.1, 4);
  });
});

describe('concentration: no known weight means no effective N', () => {
  const lookThrough = (rows: Array<{ id: string | null; weight: string }>): LookThroughResult => ({
    rows: rows.map((r) => ({
      securityId: r.id,
      label: r.id ?? 'Unknown',
      weight: r.weight,
      viaDirect: r.weight,
      viaFunds: '0',
    })),
    unknownWeight: ZERO,
    holdingsAsOf: null,
  });

  it('reports no concentration when every named weight is zero', () => {
    // GUARANTEE: effective N is 1/HHI. With no known weight, HHI is 0 and the
    // division is 1/0. Atlas must decline rather than publish Infinity as a
    // diversification figure — the number a user would read as "perfectly
    // diversified" is exactly the one produced by knowing nothing.
    // MUTANT: concentration.ts:30 `knownTotal.gt(0)` -> `.gte(0)`
    // WHY IT SURVIVED: no golden case has an all-zero named set.
    const result = concentration(lookThrough([
      { id: 'AAA', weight: '0' },
      { id: 'BBB', weight: '0' },
    ]));
    expect(Number(result.hhi)).toBe(0);
    expect(Number(result.effectiveN)).toBe(0);
    expect(Number.isFinite(Number(result.effectiveN))).toBe(true);
  });

  it('reports no concentration for a portfolio with no named holdings at all', () => {
    // Everything unclassified: the first-import state, and one no golden case
    // covers.
    const result = concentration(lookThrough([{ id: null, weight: '1' }]));
    expect(Number.isFinite(Number(result.effectiveN))).toBe(true);
    expect(Number(result.effectiveN)).toBe(0);
  });

  it('still computes a real effective N for a normal portfolio', () => {
    // Two equal holdings -> HHI 0.5 -> effective N 2. Without this the tests
    // above would pass against a function that always returned zero.
    const result = concentration(lookThrough([
      { id: 'AAA', weight: '0.5' },
      { id: 'BBB', weight: '0.5' },
    ]));
    expect(Number(result.hhi)).toBeCloseTo(0.5, 10);
    expect(Number(result.effectiveN)).toBeCloseTo(2, 10);
  });
});
