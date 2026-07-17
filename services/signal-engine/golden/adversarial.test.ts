/**
 * Adversarial fixtures (§48.2): a portfolio with a 100% position; a fund
 * holding itself; a security with 3 days of history; negative cash.
 * (The mid-period corporate action is exercised in the ingest integration
 * test, where split adjustment actually happens.)
 */
import { describe, expect, it } from 'vitest';
import {
  computePortfolioSignals,
  timeWeightedReturn,
  xirr,
  type EngineInputs,
} from '@atlas/signal-engine';
import { dec } from '@atlas/domain';

const T0 = '2026-07-01T00:00:00.000Z';

const sec = (id: string, over: Partial<EngineInputs['securities'][number]> = {}) => ({
  id,
  name: id,
  type: 'equity' as const,
  isFund: false,
  gicsSector: 'Information Technology',
  gicsIndustry: 'Software',
  country: 'US',
  currency: 'EUR',
  ...over,
});

describe('adversarial: 100% single position', () => {
  const inputs: EngineInputs = {
    portfolioId: 'adv-100',
    baseCurrency: 'EUR',
    positions: [{ securityId: 'AAA', quantity: '10' }],
    securities: [sec('AAA')],
    prices: [{ securityId: 'AAA', close: '100', currency: 'EUR', asOf: '2026-06-30' }],
    fx: [],
    fundHoldings: [],
    cash: [],
  };
  const out = computePortfolioSignals(inputs, T0);

  it('weight is exactly 1, HHI is 1, effective-N is 1', () => {
    expect(dec(out.weights.value[0]!.weight).eq(1)).toBe(true);
    expect(dec(out.concentration.value.hhi).eq(1)).toBe(true);
    expect(dec(out.concentration.value.effectiveN).eq(1)).toBe(true);
    expect(out.concentration.value.nominalN).toBe(1);
  });
});

describe('adversarial: a fund holding itself', () => {
  // Portfolio: AAA direct 30%, FSELF 50%, cash 20%.
  // FSELF holds itself 60% and AAA 30% (10% undisclosed).
  // Hand-computed: AAA = 0.3 + 0.5×0.3 = 0.45.
  // Unknown = self-cycle 0.5×0.6 = 0.30, plus remainder 0.5×0.1 = 0.05 → 0.35.
  const inputs: EngineInputs = {
    portfolioId: 'adv-self',
    baseCurrency: 'EUR',
    positions: [
      { securityId: 'AAA', quantity: '30' },
      { securityId: 'FSELF', quantity: '50' },
    ],
    securities: [sec('AAA'), sec('FSELF', { type: 'fund', isFund: true, gicsSector: null, country: 'IE' })],
    prices: [
      { securityId: 'AAA', close: '1', currency: 'EUR', asOf: '2026-06-30' },
      { securityId: 'FSELF', close: '1', currency: 'EUR', asOf: '2026-06-30' },
    ],
    fx: [],
    fundHoldings: [
      { fundSecurityId: 'FSELF', holdingSecurityId: 'FSELF', weight: '0.6', asOf: '2026-06-30' },
      { fundSecurityId: 'FSELF', holdingSecurityId: 'AAA', weight: '0.3', asOf: '2026-06-30' },
    ],
    cash: [{ currency: 'EUR', amount: '20' }],
  };
  const out = computePortfolioSignals(inputs, T0);

  it('terminates and routes the self-referential weight to the unknown slice', () => {
    const byId = new Map(out.lookThrough.value.map((r) => [r.securityId ?? 'unknown', r.weight]));
    expect(dec(byId.get('AAA')!).eq('0.45')).toBe(true);
    expect(dec(byId.get('unknown')!).eq('0.35')).toBe(true);
  });

  it('nothing is invented: look-through + cash still sums to 1', () => {
    const total = out.lookThrough.value.reduce((a, r) => a.plus(r.weight), dec(out.cashWeight));
    expect(total.eq(1)).toBe(true);
  });
});

describe('adversarial: security with 3 days of history', () => {
  it('TWR works on a 3-point series; MWR declares a gap on a single flow', () => {
    const twr = timeWeightedReturn(
      [
        { date: '2026-06-26', value: '100' },
        { date: '2026-06-29', value: '101' },
        { date: '2026-06-30', value: '99.98' },
      ],
      [],
    );
    // 1.01 × (99.98/101) = 0.9998 → −0.02%
    expect(twr!.toFixed(6)).toBe('-0.000200');
    expect(xirr([{ date: '2026-06-26', amount: '-100' }])).toBeNull();
  });
});

describe('adversarial: negative cash', () => {
  // Positions 4500, cash −500 → total 4000. Weights: 1.125 and −0.125, sum 1.
  const inputs: EngineInputs = {
    portfolioId: 'adv-negcash',
    baseCurrency: 'EUR',
    positions: [{ securityId: 'AAA', quantity: '45' }],
    securities: [sec('AAA')],
    prices: [{ securityId: 'AAA', close: '100', currency: 'EUR', asOf: '2026-06-30' }],
    fx: [],
    fundHoldings: [],
    cash: [{ currency: 'EUR', amount: '-500' }],
  };
  const out = computePortfolioSignals(inputs, T0);

  it('renders leverage honestly: position >100%, cash negative, sum exactly 1', () => {
    const byId = new Map(out.weights.value.map((w) => [w.securityId ?? 'cash', w.weight]));
    expect(dec(byId.get('AAA')!).eq('1.125')).toBe(true);
    expect(dec(byId.get('cash')!).eq('-0.125')).toBe(true);
    const sum = out.weights.value.reduce((a, w) => a.plus(w.weight), dec(0));
    expect(sum.eq(1)).toBe(true);
  });
});

describe('adversarial: missing price is a declared gap, never a silent zero', () => {
  const inputs: EngineInputs = {
    portfolioId: 'adv-gap',
    baseCurrency: 'EUR',
    positions: [
      { securityId: 'AAA', quantity: '10' },
      { securityId: 'NOPRICE', quantity: '5' },
    ],
    securities: [sec('AAA'), sec('NOPRICE')],
    prices: [{ securityId: 'AAA', close: '100', currency: 'EUR', asOf: '2026-06-30' }],
    fx: [],
    fundHoldings: [],
    cash: [],
  };
  const out = computePortfolioSignals(inputs, T0);

  it('gaps is non-empty and names the security', () => {
    expect(out.gaps.length).toBe(1);
    expect(out.gaps[0]!.securityId).toBe('NOPRICE');
    expect(out.gaps[0]!.reason).toContain('no price');
  });
});
