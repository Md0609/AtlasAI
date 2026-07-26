/**
 * `prices_as_of` must not overstate freshness (P1-9).
 *
 * The engine took the MAXIMUM price date across all positions, and the UI
 * prints it as an unqualified claim about the whole portfolio: "prices as of
 * 25 Jul 2026". A portfolio holding one six-month-stale position therefore read
 * as fully fresh, while that position was still folded into total value,
 * weights, concentration and the Reality Check denominator — and there is no
 * per-position as-of anywhere in the UI to contradict it.
 *
 * The minimum is the only reading that cannot overstate: it is the date from
 * which every number in the response is at least as old.
 */
import { describe, expect, it } from 'vitest';
import { valuePortfolio } from '@atlas/signal-engine';
import type { EngineInputs } from '../src/types.js';
import type { SecurityRef } from '@atlas/contracts';

/** A plain equity, fully specified — no casts, so a contract change breaks here. */
const security = (id: string, name: string): SecurityRef => ({
  id,
  name,
  type: 'equity',
  isFund: false,
  gicsSector: null,
  gicsIndustry: null,
  country: null,
  currency: 'EUR',
});

/** Two holdings priced on different days, both valued in their own currency. */
function inputs(asOfA: string, asOfB: string): EngineInputs {
  return {
    portfolioId: 'p1',
    baseCurrency: 'EUR',
    positions: [
      { securityId: 'AAA', quantity: '10' },
      { securityId: 'BBB', quantity: '10' },
    ],
    securities: [security('AAA', 'Alpha'), security('BBB', 'Beta')],
    prices: [
      { securityId: 'AAA', close: '100', currency: 'EUR', asOf: asOfA },
      { securityId: 'BBB', close: '100', currency: 'EUR', asOf: asOfB },
    ],
    fx: [],
    fundHoldings: [],
    cash: [],
  };
}

describe('prices_as_of reports the oldest contributing price', () => {
  it('takes the stale leg, not the fresh one', () => {
    // The bug, in one assertion: with a max, this read 2026-07-25 while half
    // the portfolio was priced six months earlier.
    const v = valuePortfolio(inputs('2026-01-20', '2026-07-25'));
    expect(v.pricesAsOf).toBe('2026-01-20');
  });

  it('is order-independent — the stale leg wins whichever way round it appears', () => {
    expect(valuePortfolio(inputs('2026-07-25', '2026-01-20')).pricesAsOf).toBe('2026-01-20');
  });

  it('is simply the date when every price shares one', () => {
    expect(valuePortfolio(inputs('2026-07-25', '2026-07-25')).pricesAsOf).toBe('2026-07-25');
  });

  it('stays null when nothing could be priced', () => {
    const none = { ...inputs('2026-01-20', '2026-07-25'), prices: [] };
    const v = valuePortfolio(none);
    expect(v.pricesAsOf).toBeNull();
    // …and the positions become declared gaps rather than silent zeroes.
    expect(v.gaps.length).toBeGreaterThan(0);
  });

  it('ignores a position that was excluded, since it contributed no value', () => {
    // AAA has no price at all: it is a gap, not a contributor, so the as-of
    // must describe what actually went into the number.
    const partial = {
      ...inputs('2026-01-20', '2026-07-25'),
      prices: [{ securityId: 'BBB', close: '100', currency: 'EUR', asOf: '2026-07-25' }],
    };
    const v = valuePortfolio(partial);
    expect(v.pricesAsOf).toBe('2026-07-25');
    expect(v.gaps.some((g) => g.securityId === 'AAA')).toBe(true);
  });
});
