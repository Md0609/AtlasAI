/**
 * Exposure aggregation.
 *
 *  - sector / country: computed on the look-through single-name weights, with
 *    UNKNOWN and CASH as first-class buckets (D-006 — the unknown slice is
 *    rendered, never redistributed).
 *  - currency: computed on the *direct* pricing currency of positions + cash.
 *    Look-through currency attribution is a v1.1 refinement; methodology says so.
 */
import type { ExposureSlice, SecurityRef } from '@atlas/contracts';
import { Dec, ZERO, dec, str } from '@atlas/domain';
import type { EngineInputs } from './types.js';
import type { LookThroughResult } from './lookthrough.js';
import type { ValuationResult } from './valuation.js';

export type ExposureDimension = 'sector' | 'country' | 'currency';

export function exposures(
  inputs: EngineInputs,
  valuation: ValuationResult,
  lt: LookThroughResult,
  dimension: ExposureDimension,
): ExposureSlice[] {
  const secById = new Map<string, SecurityRef>(inputs.securities.map((s) => [s.id, s]));
  const buckets = new Map<string, Dec>();
  const bump = (key: string, w: Dec) => buckets.set(key, (buckets.get(key) ?? ZERO).plus(w));

  if (dimension === 'currency') {
    for (const r of valuation.rows) {
      if (valuation.totalBase.isZero()) continue;
      bump(r.currency, r.valueBase.div(valuation.totalBase));
    }
    for (const c of valuation.cashRows) {
      if (valuation.totalBase.isZero()) continue;
      bump(c.currency, c.valueBase.div(valuation.totalBase));
    }
  } else {
    for (const row of lt.rows) {
      if (row.securityId === null) {
        bump('UNKNOWN', dec(row.weight));
        continue;
      }
      const sec = secById.get(row.securityId);
      const key =
        dimension === 'sector'
          ? sec?.gicsSector ?? 'UNKNOWN'
          : sec?.country ?? 'UNKNOWN';
      bump(key, dec(row.weight));
    }
    if (!valuation.cashWeight.isZero()) bump('CASH', valuation.cashWeight);
  }

  return [...buckets.entries()]
    .map(([key, w]) => ({
      key,
      weight: str(w),
      marketValueBase: str(w.times(valuation.totalBase)),
    }))
    .sort((a, b) => dec(b.weight).cmp(dec(a.weight)) || a.key.localeCompare(b.key));
}
