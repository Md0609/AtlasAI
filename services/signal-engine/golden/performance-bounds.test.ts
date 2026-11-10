/**
 * Issue #3 / ADR-001: bounds of the performance metrics over generated series.
 * Seeded LCG (same generator as properties.test.ts), 250 cases per property.
 */
import { describe, expect, it } from 'vitest';
import { drawdown, timeWeightedReturn, type Flow, type ValuePoint } from '@atlas/signal-engine';
import { dec } from '@atlas/domain';

class Lcg {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0;
    return this.s / 2 ** 32;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
}

const CASES = 250;
const day = (i: number) => `2026-01-${String(i + 1).padStart(2, '0')}`;

/** Positive values; deposits/withdrawals that never take the capital base to ≤ 0. */
function positiveSeries(rng: Lcg): { series: ValuePoint[]; flows: Flow[] } {
  const n = rng.int(2, 25);
  const series: ValuePoint[] = [];
  const flows: Flow[] = [];
  let v = 1 + rng.next() * 10_000;
  for (let i = 0; i < n; i++) {
    if (i > 0 && rng.next() < 0.3) {
      const f = (rng.next() - 0.4) * v; // withdrawal never exceeds 40% of the value
      flows.push({ date: day(i), amount: f.toFixed(4) });
      v += f;
    }
    v *= 0.5 + rng.next(); // −50% … +50% per day, always > 0
    series.push({ date: day(i), value: v.toFixed(4) });
  }
  return { series, flows };
}

/** Any sign, including the residue of an unfunded purchase. */
function anySeries(rng: Lcg): ValuePoint[] {
  const n = rng.int(1, 25);
  return Array.from({ length: n }, (_, i) => ({ date: day(i), value: ((rng.next() - 0.3) * 10_000).toFixed(4) }));
}

describe('performance bounds (issue #3)', () => {
  it('TWR > −1 for positive value series', () => {
    const rng = new Lcg(0x3a3);
    for (let c = 0; c < CASES; c++) {
      const { series, flows } = positiveSeries(rng);
      const twr = timeWeightedReturn(series, flows);
      expect(twr, `case ${c}`).not.toBeNull();
      expect(twr!.gt(-1), `case ${c}: twr=${twr}`).toBe(true);
    }
  });

  it('TWR is null or > −1 for any series (never below −100%)', () => {
    const rng = new Lcg(0x3a4);
    for (let c = 0; c < CASES; c++) {
      const series = anySeries(rng);
      const twr = timeWeightedReturn(series, []);
      if (twr !== null) expect(twr.gt(-1), `case ${c}: twr=${twr}`).toBe(true);
    }
  });

  it('drawdown (max and current) is always in [0, 1], whatever the series', () => {
    const rng = new Lcg(0x3a5);
    for (let c = 0; c < CASES; c++) {
      const dd = drawdown(anySeries(rng));
      expect(dd).not.toBeNull();
      for (const v of [dd!.max, dd!.current]) {
        expect(v.gte(0) && v.lte(1), `case ${c}: dd=${v}`).toBe(true);
      }
    }
  });

  it('the issue #3 residue: holdings with no capital base → TWR null, not −1984%', () => {
    // Unfunded buy of 9453.34: net value 0 on day 1, then the net gain/loss.
    const series = [
      { date: '2026-02-02', value: '0' },
      { date: '2026-02-03', value: '-120.5' },
      { date: '2026-02-04', value: '15.2' },
      { date: '2026-06-30', value: '350.09' },
    ];
    expect(timeWeightedReturn(series, [])).toBeNull();
    const dd = drawdown(series)!;
    expect(dd.max.lte(1) && dd.current.lte(1)).toBe(true);
  });

  it('an empty portfolio before the first deposit still contributes nothing', () => {
    const twr = timeWeightedReturn(
      [
        { date: '2026-01-01', value: '0' },
        { date: '2026-01-02', value: '1000' },
        { date: '2026-01-03', value: '1100' },
      ],
      [{ date: '2026-01-02', amount: '1000' }],
    );
    expect(twr!.toFixed(6)).toBe('0.100000');
  });

  it('a value below zero is a 100% drawdown, not more', () => {
    const dd = drawdown([
      { date: 'd1', value: '100' },
      { date: 'd2', value: '-26' },
    ])!;
    expect(dec(dd.max).eq(1)).toBe(true);
    expect(dec(dd.current).eq(1)).toBe(true);
  });
});
