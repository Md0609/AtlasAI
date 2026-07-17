/**
 * Property tests (§48.2): invariants over generated portfolios.
 * Generator is a seeded LCG — deterministic, so a failure is reproducible
 * by construction. 250 cases per property.
 */
import { describe, expect, it } from 'vitest';
import { computePortfolioSignals, type EngineInputs } from '@atlas/signal-engine';
import { dec } from '@atlas/domain';

class Lcg {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    // Numerical Recipes LCG
    this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0;
    return this.s / 2 ** 32;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  price(): string {
    return (1 + this.next() * 999).toFixed(4);
  }
  qty(): string {
    return (0.1 + this.next() * 500).toFixed(4);
  }
}

const SECTORS = ['Information Technology', 'Industrials', 'Financials', 'Health Care', null];
const COUNTRIES = ['US', 'DE', 'FR', 'NL', 'ES', null];

function genPortfolio(rng: Lcg, caseId: number): EngineInputs {
  const nEquities = rng.int(1, 8);
  const nFunds = rng.int(0, 3);
  const securities: EngineInputs['securities'] = [];
  const positions: EngineInputs['positions'] = [];
  const prices: EngineInputs['prices'] = [];
  const fundHoldings: EngineInputs['fundHoldings'] = [];

  for (let i = 0; i < nEquities; i++) {
    const id = `EQ${i}`;
    securities.push({
      id,
      name: `Equity ${i}`,
      type: 'equity',
      isFund: false,
      gicsSector: SECTORS[rng.int(0, SECTORS.length - 1)]!,
      gicsIndustry: null,
      country: COUNTRIES[rng.int(0, COUNTRIES.length - 1)]!,
      currency: rng.next() < 0.7 ? 'EUR' : 'USD',
    });
  }
  for (let i = 0; i < nFunds; i++) {
    const id = `FU${i}`;
    securities.push({
      id,
      name: `Fund ${i}`,
      type: 'fund',
      isFund: true,
      gicsSector: null,
      gicsIndustry: null,
      country: 'IE',
      currency: 'EUR',
    });
    // Fund holds a random subset of equities (and sometimes another fund,
    // possibly itself — cycles must be safe by construction).
    let remaining = dec(1);
    const nHold = rng.int(0, nEquities);
    for (let h = 0; h < nHold && remaining.gt(0.05); h++) {
      const w = dec((rng.next() * 0.4).toFixed(4));
      if (w.lte(0)) continue;
      const use = w.gt(remaining) ? remaining : w;
      const target = rng.next() < 0.15 ? `FU${rng.int(0, nFunds - 1)}` : `EQ${rng.int(0, nEquities - 1)}`;
      fundHoldings.push({
        fundSecurityId: id,
        holdingSecurityId: target,
        weight: use.toString(),
        asOf: '2026-06-30',
      });
      remaining = remaining.minus(use);
    }
  }

  for (const s of securities) {
    if (rng.next() < 0.85 || s.type !== 'equity') {
      positions.push({ securityId: s.id, quantity: rng.qty() });
    }
    prices.push({
      securityId: s.id,
      close: rng.price(),
      currency: s.currency,
      asOf: '2026-06-30',
    });
  }
  if (positions.length === 0) {
    positions.push({ securityId: securities[0]!.id, quantity: rng.qty() });
  }

  const cash: EngineInputs['cash'] = [];
  if (rng.next() < 0.8) {
    // occasionally negative — leverage must not break invariants
    const sign = rng.next() < 0.15 ? -1 : 1;
    cash.push({ currency: 'EUR', amount: (sign * rng.next() * 10000).toFixed(2) });
  }

  return {
    portfolioId: `prop-${caseId}`,
    baseCurrency: 'EUR',
    positions,
    securities,
    prices,
    fx: [{ base: 'EUR', quote: 'USD', rate: '1.0900', asOf: '2026-06-30' }],
    fundHoldings,
    cash,
  };
}

const CASES = 250;
const TOL = dec('1e-18'); // decimal arithmetic slack across division chains

describe('signal engine invariants (seeded property tests)', () => {
  const rng = new Lcg(0xa71a5);
  const inputs = Array.from({ length: CASES }, (_, i) => genPortfolio(rng, i));

  it('weights sum to exactly 1 (within decimal tolerance) whenever total ≠ 0', () => {
    for (const inp of inputs) {
      const out = computePortfolioSignals(inp, '2026-07-01T00:00:00.000Z');
      if (dec(out.totalValueBase).isZero()) continue;
      const sum = out.weights.value.reduce((a, w) => a.plus(w.weight), dec(0));
      expect(sum.minus(1).abs().lte(TOL), `case ${inp.portfolioId}: sum=${sum}`).toBe(true);
    }
  });

  it('effective-N ≤ nominal N', () => {
    for (const inp of inputs) {
      const out = computePortfolioSignals(inp, '2026-07-01T00:00:00.000Z');
      const c = out.concentration.value;
      if (c.nominalN === 0) continue;
      expect(
        dec(c.effectiveN).lte(dec(c.nominalN).plus(TOL)),
        `case ${inp.portfolioId}: effN=${c.effectiveN} N=${c.nominalN}`,
      ).toBe(true);
    }
  });

  it('look-through never exceeds 100%: single names + unknown + cash = 1', () => {
    for (const inp of inputs) {
      const out = computePortfolioSignals(inp, '2026-07-01T00:00:00.000Z');
      if (dec(out.totalValueBase).isZero()) continue;
      if (out.gaps.length > 0) continue; // gap cases assert elsewhere
      const total = out.lookThrough.value.reduce((a, r) => a.plus(r.weight), dec(out.cashWeight));
      expect(total.minus(1).abs().lte(TOL), `case ${inp.portfolioId}: total=${total}`).toBe(true);
    }
  });

  it('determinism: identical inputs produce byte-identical outputs (FR-5.6)', () => {
    for (const inp of inputs.slice(0, 40)) {
      const a = computePortfolioSignals(inp, '2026-07-01T00:00:00.000Z');
      const b = computePortfolioSignals(inp, '2026-07-01T00:00:00.000Z');
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });
});
