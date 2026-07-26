/**
 * Valuation: positions × adjusted close × explicit FX → base-currency values.
 * Missing price or missing FX path never silently zeroes a position — it
 * produces a declared gap (the §31.4 honesty contract starts here).
 */
import type { SecurityRef, WeightRow } from '@atlas/contracts';
import { Dec, ZERO, dec, str } from '@atlas/domain';
import { FxTable, type EngineGap, type EngineInputs } from './types.js';

export interface ValuationResult {
  totalBase: Dec;
  rows: Array<{ securityId: string; label: string; valueBase: Dec; currency: string; valueLocal: Dec }>;
  cashRows: Array<{ currency: string; valueBase: Dec; amountLocal: Dec }>;
  weights: WeightRow[];
  cashWeight: Dec;
  gaps: EngineGap[];
  pricesAsOf: string | null;
}

export function valuePortfolio(inputs: EngineInputs): ValuationResult {
  const fx = new FxTable(inputs.fx);
  const secById = new Map<string, SecurityRef>(inputs.securities.map((s) => [s.id, s]));
  const priceBySec = new Map(inputs.prices.map((p) => [p.securityId, p]));
  const gaps: EngineGap[] = [];
  let pricesAsOf: string | null = null;

  const rows: ValuationResult['rows'] = [];
  for (const pos of [...inputs.positions].sort((a, b) => a.securityId.localeCompare(b.securityId))) {
    const sec = secById.get(pos.securityId);
    const price = priceBySec.get(pos.securityId);
    if (!sec) {
      gaps.push({ component: 'valuation', reason: 'security metadata missing', securityId: pos.securityId });
      continue;
    }
    if (!price) {
      gaps.push({ component: 'valuation', reason: 'no price available', securityId: pos.securityId });
      continue;
    }
    const rate = fx.rate(price.currency, inputs.baseCurrency);
    if (rate === null) {
      gaps.push({
        component: 'valuation',
        reason: `no FX path ${price.currency}→${inputs.baseCurrency}`,
        securityId: pos.securityId,
      });
      continue;
    }
    // The OLDEST contributing price, not the newest (P1-9).
    //
    // This value is rendered as an unqualified claim about the whole portfolio
    // ("prices as of 25 Jul 2026"). Taking the maximum meant one six-month-stale
    // position was invisible behind a fresh date, while still being folded into
    // total value, weights, concentration and the Reality Check denominator.
    // The minimum is the only reading that cannot overstate freshness: it is the
    // date from which EVERY number here is at least as old.
    if (!pricesAsOf || price.asOf < pricesAsOf) pricesAsOf = price.asOf;
    const valueLocal = dec(pos.quantity).times(price.close);
    rows.push({
      securityId: pos.securityId,
      label: sec.name,
      currency: price.currency,
      valueLocal,
      valueBase: valueLocal.times(rate),
    });
  }

  const cashRows: ValuationResult['cashRows'] = [];
  for (const c of [...inputs.cash].sort((a, b) => a.currency.localeCompare(b.currency))) {
    const rate = fx.rate(c.currency, inputs.baseCurrency);
    if (rate === null) {
      gaps.push({ component: 'valuation', reason: `no FX path ${c.currency}→${inputs.baseCurrency} for cash` });
      continue;
    }
    cashRows.push({ currency: c.currency, amountLocal: dec(c.amount), valueBase: dec(c.amount).times(rate) });
  }

  const positionsTotal = rows.reduce((acc, r) => acc.plus(r.valueBase), ZERO);
  const cashTotal = cashRows.reduce((acc, r) => acc.plus(r.valueBase), ZERO);
  const totalBase = positionsTotal.plus(cashTotal);

  const weights: WeightRow[] = [];
  let cashWeight = ZERO;
  if (!totalBase.isZero()) {
    for (const r of rows) {
      weights.push({
        securityId: r.securityId,
        label: r.label,
        marketValueBase: str(r.valueBase),
        weight: str(r.valueBase.div(totalBase)),
      });
    }
    if (cashRows.length > 0) {
      cashWeight = cashTotal.div(totalBase);
      weights.push({
        securityId: null,
        label: 'Cash',
        marketValueBase: str(cashTotal),
        weight: str(cashWeight),
      });
    }
  }

  return { totalBase, rows, cashRows, weights, cashWeight, gaps, pricesAsOf };
}
