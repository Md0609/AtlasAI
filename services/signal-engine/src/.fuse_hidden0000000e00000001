/**
 * Performance metrics (performance.v1).
 *
 *  - TWR: daily chain-linking, external flows at start-of-day convention:
 *      r_d = V_d / (V_{d-1} + F_d) − 1,  TWR = Π(1+r_d) − 1
 *  - MWR: XIRR via deterministic bisection on (−0.9999, 10), ACT/365,
 *    fixed iteration budget — same inputs, same bits (FR-5.6). Returns null
 *    (a declared gap) when no sign change exists or history is insufficient.
 *  - Drawdown: max and current, on the portfolio value series.
 *  - FR-3.6: local return vs FX return separated per pricing-currency bucket:
 *      local = (Σ qᵢ·p_end,ᵢ) / (Σ qᵢ·p_start,ᵢ) − 1   (current quantities)
 *      fx    = rate_end(ccy→base) / rate_start(ccy→base) − 1
 */
import type { PerformanceResult } from '@atlas/contracts';
import { Dec, ONE, ZERO, dec, str } from '@atlas/domain';

export interface ValuePoint {
  date: string;
  value: string; // portfolio value in base currency at end of day
}

export interface Flow {
  date: string;
  amount: string; // external flow in base currency; + deposit, − withdrawal
}

export function timeWeightedReturn(series: ValuePoint[], flows: Flow[]): Dec | null {
  if (series.length < 2) return null;
  const flowByDate = new Map<string, Dec>();
  for (const f of flows) {
    flowByDate.set(f.date, (flowByDate.get(f.date) ?? ZERO).plus(dec(f.amount)));
  }
  let acc = ONE;
  for (let i = 1; i < series.length; i++) {
    const prev = dec(series[i - 1]!.value);
    const flow = flowByDate.get(series[i]!.date) ?? ZERO;
    const denom = prev.plus(flow);
    if (denom.isZero()) continue; // empty portfolio day contributes nothing
    const r = dec(series[i]!.value).div(denom).minus(1);
    acc = acc.times(ONE.plus(r));
  }
  return acc.minus(1);
}

export interface CashflowPoint {
  date: string;
  amount: string; // − invested, + received; caller appends terminal value as +
}

const DAY_MS = 86_400_000;

export function xirr(flows: CashflowPoint[]): Dec | null {
  if (flows.length < 2) return null;
  const t0 = Date.parse(`${flows[0]!.date}T00:00:00Z`);
  const cfs = flows.map((f) => ({
    // ACT/365 year fraction as an exact decimal (days is always an integer)
    years: dec(Math.round((Date.parse(`${f.date}T00:00:00Z`) - t0) / DAY_MS)).div(365),
    amount: dec(f.amount),
  }));
  const hasNeg = cfs.some((c) => c.amount.isNegative());
  const hasPos = cfs.some((c) => c.amount.gt(0));
  if (!hasNeg || !hasPos) return null;

  // All arithmetic in Dec: Math.pow is engine-dependent, Decimal.pow is not.
  const npv = (r: Dec): Dec =>
    cfs.reduce((acc, c) => acc.plus(c.amount.div(ONE.plus(r).pow(c.years))), ZERO);

  let lo = dec('-0.9999');
  let hi = dec('10');
  let fLo = npv(lo);
  const fHi = npv(hi);
  if (fLo.isZero()) return lo;
  if (fHi.isZero()) return hi;
  if (fLo.isNegative() === fHi.isNegative()) return null; // no root in bracket: declared gap

  for (let i = 0; i < 60; i++) {
    const mid = lo.plus(hi).div(2);
    const fMid = npv(mid);
    if (fMid.isZero()) {
      lo = mid;
      hi = mid;
      break;
    }
    if (fMid.isNegative() === fLo.isNegative()) {
      lo = mid;
      fLo = fMid;
    } else {
      hi = mid;
    }
    if (hi.minus(lo).abs().lt('1e-13')) break;
  }
  return lo.plus(hi).div(2).toDecimalPlaces(10);
}

export function drawdown(series: ValuePoint[]): { max: Dec; current: Dec } | null {
  if (series.length === 0) return null;
  let peak = dec(series[0]!.value);
  let maxDd = ZERO;
  let current = ZERO;
  for (const p of series) {
    const v = dec(p.value);
    if (v.gt(peak)) peak = v;
    if (peak.gt(0)) {
      const dd = ONE.minus(v.div(peak));
      if (dd.gt(maxDd)) maxDd = dd;
      current = dd;
    }
  }
  return { max: maxDd, current };
}

export interface CurrencyBucketInput {
  currency: string;
  startLocalValue: string; // Σ qᵢ·p_start,ᵢ in the pricing currency
  endLocalValue: string; // Σ qᵢ·p_end,ᵢ
  fxStart: string | null; // rate ccy→base at window start; null when ccy = base
  fxEnd: string | null;
}

export function currencyDecomposition(
  buckets: CurrencyBucketInput[],
): PerformanceResult['currencyDecomposition'] {
  return buckets.map((b) => {
    const start = dec(b.startLocalValue);
    const localReturn = start.isZero() ? null : str(dec(b.endLocalValue).div(start).minus(1));
    let fxReturn: string | null = '0';
    if (b.fxStart !== null && b.fxEnd !== null) {
      const s = dec(b.fxStart);
      fxReturn = s.isZero() ? null : str(dec(b.fxEnd).div(s).minus(1));
    }
    return { currency: b.currency, localReturn, fxReturn };
  });
}
