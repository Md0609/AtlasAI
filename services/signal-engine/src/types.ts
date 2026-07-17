/**
 * Signal Engine v1 inputs. Pure data in, pure data out: the engine has no
 * database dependency, no clock, no randomness (FR-5.6). The API layer loads
 * these from Postgres; golden tests load them from hand-authored fixtures.
 */
import type { Currency, DecimalString, IsoDate, SecurityRef } from '@atlas/contracts';
import { Dec, dec } from '@atlas/domain';

export interface PositionInput {
  securityId: string;
  quantity: DecimalString;
}

export interface PriceQuote {
  securityId: string;
  close: DecimalString; // adjusted close in the security's pricing currency
  currency: Currency;
  asOf: IsoDate;
}

export interface FxQuote {
  base: Currency;
  quote: Currency;
  rate: DecimalString; // 1 base = rate quote
  asOf: IsoDate;
}

export interface FundHoldingInput {
  fundSecurityId: string;
  holdingSecurityId: string;
  weight: DecimalString; // 0..1 fraction of fund NAV
  asOf: IsoDate;
}

export interface CashBalanceInput {
  currency: Currency;
  amount: DecimalString; // may be negative — negative cash is an honest state
}

export interface EngineInputs {
  portfolioId: string;
  baseCurrency: Currency;
  positions: PositionInput[];
  securities: SecurityRef[];
  prices: PriceQuote[];
  fx: FxQuote[];
  fundHoldings: FundHoldingInput[];
  cash: CashBalanceInput[];
}

export interface EngineGap {
  component: string;
  reason: string;
  securityId?: string;
}

/** Explicit-rate FX lookup. No implicit conversion path exists (§27.3.3). */
export class FxTable {
  private readonly direct = new Map<string, Dec>();
  private latestAsOf: IsoDate | null = null;

  constructor(quotes: FxQuote[]) {
    for (const q of quotes) {
      this.direct.set(`${q.base}/${q.quote}`, dec(q.rate));
      if (!this.latestAsOf || q.asOf > this.latestAsOf) this.latestAsOf = q.asOf;
    }
  }

  get asOf(): IsoDate | null {
    return this.latestAsOf;
  }

  /** Rate such that amount(from) × rate = amount(to). Null when no path exists. */
  rate(from: Currency, to: Currency): Dec | null {
    if (from === to) return dec(1);
    const direct = this.direct.get(`${from}/${to}`);
    if (direct) return direct;
    const inverse = this.direct.get(`${to}/${from}`);
    if (inverse && !inverse.isZero()) return dec(1).div(inverse);
    return null;
  }
}
