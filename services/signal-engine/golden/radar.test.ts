/**
 * Radar condition evaluation (radar.v1) — every metric kind, self-history
 * targets, and the honesty rules: not-computable is a declared gap, never a
 * guess (§48.2 discipline).
 */
import { describe, expect, it } from 'vitest';
import type { RadarCondition } from '@atlas/contracts';
import {
  evaluateRadarCondition,
  renderCondition,
  validateRadarCondition,
  type RadarEvalContextFull,
} from '../src/radar.js';

function bars(days: number, price: (t: number) => number): Array<{ date: string; close: string }> {
  const start = Date.parse('2026-01-01T00:00:00Z');
  return Array.from({ length: days }, (_, t) => ({
    date: new Date(start + t * 86_400_000).toISOString().slice(0, 10),
    close: price(t).toFixed(4),
  }));
}

const ctx: RadarEvalContextFull = {
  // 100 days: price declines 200 → 101 linearly; median ≈ 150.
  priceHistory: new Map([['sec1', bars(100, (t) => 200 - t)]]),
  epsBySecurity: new Map([['sec1', '10']]),
  fundamentals: new Map([['sec1:revenue_ttm', '5000000']]),
  portfolio: {
    lookThroughWeights: new Map([['sec1', '0.22']]),
    sectorExposure: new Map([['Information Technology', '0.34']]),
    cashWeight: '0.05',
  },
  ruleBreach: new Map([['rule1', true]]),
};

const cond = (partial: Partial<RadarCondition>): RadarCondition => ({
  metric: { kind: 'price', securityId: 'sec1' },
  operator: 'lt',
  target: { kind: 'literal', value: '110' },
  ...partial,
});

describe('radar.v1 evaluation', () => {
  it('price vs literal', () => {
    const r = evaluateRadarCondition(cond({}), ctx);
    expect(r.value).toBe('101'); // last close = 200 − 99
    expect(r.met).toBe(true);
    const not = evaluateRadarCondition(cond({ target: { kind: 'literal', value: '100' } }), ctx);
    expect(not.met).toBe(false);
  });

  it('price vs its own history median × factor', () => {
    const r = evaluateRadarCondition(
      cond({ target: { kind: 'self_history', stat: 'median', windowDays: 100, factor: '0.9' } }),
      ctx,
    );
    // median of 101..200 window ≈ 150.5; × 0.9 ≈ 135.45; 101 < 135.45
    expect(r.met).toBe(true);
    expect(Number(r.target)).toBeCloseTo(135.45, 1);
  });

  it('trailing P/E uses latest EPS against the price series', () => {
    const r = evaluateRadarCondition(
      cond({ metric: { kind: 'valuation.pe_ttm', securityId: 'sec1' }, target: { kind: 'literal', value: '12' } }),
      ctx,
    );
    expect(Number(r.value)).toBeCloseTo(10.1, 5); // 101 / 10
    expect(r.met).toBe(true);
  });

  it('fundamental, portfolio weight, sector exposure, cash weight, rule breach', () => {
    expect(
      evaluateRadarCondition(
        cond({ metric: { kind: 'fundamental', securityId: 'sec1', name: 'revenue_ttm' }, operator: 'gt', target: { kind: 'literal', value: '1000000' } }),
        ctx,
      ).met,
    ).toBe(true);
    expect(
      evaluateRadarCondition(
        cond({ metric: { kind: 'portfolio.weight', securityId: 'sec1' }, operator: 'gt', target: { kind: 'literal', value: '0.2' } }),
        ctx,
      ).met,
    ).toBe(true);
    expect(
      evaluateRadarCondition(
        cond({ metric: { kind: 'portfolio.sector_exposure', sector: 'Information Technology' }, operator: 'gt', target: { kind: 'literal', value: '0.3' } }),
        ctx,
      ).met,
    ).toBe(true);
    expect(
      evaluateRadarCondition(
        cond({ metric: { kind: 'portfolio.cash_weight' }, operator: 'lt', target: { kind: 'literal', value: '0.03' } }),
        ctx,
      ).met,
    ).toBe(false);
    expect(
      evaluateRadarCondition(
        cond({ metric: { kind: 'rule.breach', ruleId: 'rule1' }, operator: 'gte', target: { kind: 'literal', value: '1' } }),
        ctx,
      ).met,
    ).toBe(true);
  });

  it('declares gaps instead of guessing', () => {
    const noPrices = evaluateRadarCondition(
      cond({ metric: { kind: 'price', securityId: 'ghost' } }),
      ctx,
    );
    expect(noPrices.met).toBeNull();
    expect(noPrices.gap).toContain('no price history');

    const noFund = evaluateRadarCondition(
      cond({ metric: { kind: 'fundamental', securityId: 'sec1', name: 'net_new_arr' } }),
      ctx,
    );
    expect(noFund.met).toBeNull();
    expect(noFund.gap).toContain('net_new_arr');

    const noRule = evaluateRadarCondition(
      cond({ metric: { kind: 'rule.breach', ruleId: 'ghost' } }),
      ctx,
    );
    expect(noRule.met).toBeNull();
  });

  it('validation rejects conditions the engine cannot evaluate (US-ONB-05 discipline)', () => {
    expect(
      validateRadarCondition(
        cond({ metric: { kind: 'portfolio.cash_weight' }, target: { kind: 'self_history', stat: 'median', windowDays: 90 } }),
      ),
    ).not.toEqual([]);
    expect(validateRadarCondition(cond({}))).toEqual([]);
  });

  it('renders the compiled rule in plain terms (§16.2 confirmation)', () => {
    expect(
      renderCondition(
        cond({ metric: { kind: 'valuation.pe_ttm', securityId: 'sec1' }, target: { kind: 'self_history', stat: 'median', windowDays: 1825, factor: '0.9' } }),
      ),
    ).toBe('trailing P/E below its own 1825-day median × 0.9');
  });

  it('is deterministic (FR-5.6)', () => {
    const c = cond({ target: { kind: 'self_history', stat: 'median', windowDays: 100 } });
    expect(JSON.stringify(evaluateRadarCondition(c, ctx))).toBe(
      JSON.stringify(evaluateRadarCondition(c, ctx)),
    );
  });
});
