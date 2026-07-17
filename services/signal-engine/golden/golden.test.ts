/**
 * Golden-dataset tests (§48.2, FR-5.2): hand-computed expected values,
 * asserted exactly. This suite is the release gate for the Signal Engine —
 * "the only module in the codebase where we would delay a release for a
 * single failing test."
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computePortfolioSignals,
  timeWeightedReturn,
  xirr,
  drawdown,
  currencyDecomposition,
  type EngineInputs,
} from '@atlas/signal-engine';
import { dec } from '@atlas/domain';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(HERE, 'fixtures', 'golden-portfolio-1.json'), 'utf8'),
) as { inputs: EngineInputs; expected: Record<string, any> };

const T0 = '2026-07-01T00:00:00.000Z';

describe('golden portfolio 1', () => {
  const out = computePortfolioSignals(fixture.inputs, T0);
  const exp = fixture.expected;

  it('total value in base currency', () => {
    expect(dec(out.totalValueBase).eq(exp.totalValueBase)).toBe(true);
  });

  it('weights match hand-computed values and sum to 1', () => {
    const byId = new Map(out.weights.value.map((w) => [w.securityId ?? 'cash', w.weight]));
    expect(dec(byId.get('AAA')!).eq(exp.weights.AAA)).toBe(true);
    expect(dec(byId.get('BBB')!).eq(exp.weights.BBB)).toBe(true);
    expect(dec(byId.get('FND')!).eq(exp.weights.FND)).toBe(true);
    expect(dec(byId.get('cash')!).eq(exp.weights.cash)).toBe(true);
    const sum = out.weights.value.reduce((a, w) => a.plus(w.weight), dec(0));
    expect(sum.eq(1)).toBe(true);
  });

  it('look-through with explicit unknown slice (D-006)', () => {
    const byId = new Map(out.lookThrough.value.map((r) => [r.securityId ?? 'unknown', r]));
    expect(dec(byId.get('AAA')!.weight).eq(exp.lookThrough.AAA.weight)).toBe(true);
    expect(dec(byId.get('AAA')!.viaDirect).eq(exp.lookThrough.AAA.viaDirect)).toBe(true);
    expect(dec(byId.get('AAA')!.viaFunds).eq(exp.lookThrough.AAA.viaFunds)).toBe(true);
    expect(dec(byId.get('BBB')!.weight).eq(exp.lookThrough.BBB.weight)).toBe(true);
    expect(dec(byId.get('unknown')!.weight).eq(exp.lookThrough.unknown)).toBe(true);
    // look-through + cash covers the whole portfolio, nothing invented
    const total = out.lookThrough.value.reduce((a, r) => a.plus(r.weight), dec(out.cashWeight));
    expect(total.eq(1)).toBe(true);
  });

  for (const dim of ['sector', 'country', 'currency'] as const) {
    it(`${dim} exposure matches hand-computed buckets`, () => {
      const got = new Map(out.exposure[dim].value.map((s) => [s.key, s.weight]));
      for (const [key, w] of Object.entries(exp.exposure[dim] as Record<string, string>)) {
        expect(got.has(key), `missing bucket ${key}`).toBe(true);
        expect(dec(got.get(key)!).eq(w), `${dim}:${key} = ${got.get(key)} want ${w}`).toBe(true);
      }
      expect(got.size).toBe(Object.keys(exp.exposure[dim]).length);
    });
  }

  it('concentration: HHI, effective-N, nominal N, top name', () => {
    const c = out.concentration.value;
    expect(dec(c.hhi).toFixed(12)).toBe(exp.concentration.hhi12dp);
    expect(dec(c.effectiveN).toFixed(12)).toBe(exp.concentration.effectiveN12dp);
    expect(c.nominalN).toBe(exp.concentration.nominalN);
    expect(c.topN[0]!.securityId).toBe(exp.concentration.top1.securityId);
    expect(dec(c.topN[0]!.weight).eq(exp.concentration.top1.weight)).toBe(true);
  });

  it('provenance is present on every output value (FR-5.5)', () => {
    for (const sv of [out.weights, out.lookThrough, out.concentration, out.exposure.sector]) {
      expect(sv.provenance.engineVersion).toBe(out.engineVersion);
      expect(sv.provenance.inputHash).toBe(out.inputHash);
      expect(sv.provenance.methodology).toMatch(/\.v1$/);
    }
  });

  it('emits a typed signal.recomputed event with deterministic id (FR-5.3, §24.3)', () => {
    expect(out.event.type).toBe('signal.recomputed');
    expect(out.event.portfolioId).toBe('golden-1');
    const again = computePortfolioSignals(fixture.inputs, T0);
    expect(again.event.eventId).toBe(out.event.eventId);
  });

  it('byte-identical reproducibility (FR-5.6)', () => {
    const a = computePortfolioSignals(fixture.inputs, T0);
    const b = computePortfolioSignals(fixture.inputs, T0);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.inputHash).toBe(b.inputHash);
  });
});

describe('golden performance metrics', () => {
  it('TWR: 4000 → 4040, +500 flow, → 4630.8 gives exactly 3.0200%', () => {
    const twr = timeWeightedReturn(
      [
        { date: '2026-01-01', value: '4000' },
        { date: '2026-01-02', value: '4040' },
        { date: '2026-01-03', value: '4630.8' },
      ],
      [{ date: '2026-01-03', amount: '500' }],
    );
    expect(twr).not.toBeNull();
    expect(twr!.toFixed(6)).toBe('0.030200');
  });

  it('XIRR: −1000 → +1100 over exactly one ACT/365 year is 10%', () => {
    const r = xirr([
      { date: '2026-01-01', amount: '-1000' },
      { date: '2027-01-01', amount: '1100' },
    ]);
    expect(r).not.toBeNull();
    expect(r!.toFixed(6)).toBe('0.100000');
  });

  it('XIRR returns null (declared gap) when flows are one-signed', () => {
    expect(
      xirr([
        { date: '2026-01-01', amount: '1000' },
        { date: '2026-06-01', amount: '1100' },
      ]),
    ).toBeNull();
  });

  it('drawdown: [100, 110, 99, 104.5] → max 10%, current 5%', () => {
    const dd = drawdown([
      { date: 'd1', value: '100' },
      { date: 'd2', value: '110' },
      { date: 'd3', value: '99' },
      { date: 'd4', value: '104.5' },
    ]);
    expect(dd!.max.toFixed(6)).toBe('0.100000');
    expect(dd!.current.toFixed(6)).toBe('0.050000');
  });

  it('FR-3.6 local vs FX separation: +10% local, −5% FX are reported separately', () => {
    const rows = currencyDecomposition([
      { currency: 'USD', startLocalValue: '1000', endLocalValue: '1100', fxStart: '0.80', fxEnd: '0.76' },
      { currency: 'EUR', startLocalValue: '2000', endLocalValue: '2000', fxStart: null, fxEnd: null },
    ]);
    const usd = rows.find((r) => r.currency === 'USD')!;
    expect(dec(usd.localReturn!).toFixed(6)).toBe('0.100000');
    expect(dec(usd.fxReturn!).toFixed(6)).toBe('-0.050000');
    const eur = rows.find((r) => r.currency === 'EUR')!;
    expect(dec(eur.localReturn!).eq(0)).toBe(true);
    expect(dec(eur.fxReturn!).eq(0)).toBe(true);
  });
});
