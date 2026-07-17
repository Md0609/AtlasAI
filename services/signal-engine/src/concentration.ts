/**
 * Concentration metrics over look-through single-name exposure.
 *
 * Methodology (concentration.v1):
 *  - top-N reports single names by their share of total portfolio value
 *    (including cash and unknown in the denominator — honest headline weights).
 *  - HHI / effective-N are computed over the *known single-name subset*,
 *    renormalized to sum to 1. This preserves the invariant
 *    effective-N ≤ nominal-N (§48.2 property test) and answers the question
 *    "how diversified is the equity I can actually see?" The unknown slice is
 *    reported alongside, never folded in as if it were a name.
 */
import type { ConcentrationResult } from '@atlas/contracts';
import { Dec, ZERO, dec, str } from '@atlas/domain';
import type { LookThroughResult } from './lookthrough.js';

export function concentration(lt: LookThroughResult, topNCount = 10): ConcentrationResult {
  const named = lt.rows.filter((r) => r.securityId !== null);
  const nominalN = named.length;

  const topN = named
    .slice()
    .sort((a, b) => dec(b.weight).cmp(dec(a.weight)) || a.label.localeCompare(b.label))
    .slice(0, topNCount)
    .map((r) => ({ securityId: r.securityId as string, label: r.label, weight: r.weight }));

  const knownTotal = named.reduce((acc, r) => acc.plus(dec(r.weight)), ZERO);
  let hhi: Dec = ZERO;
  let effectiveN: Dec = ZERO;
  if (nominalN > 0 && knownTotal.gt(0)) {
    for (const r of named) {
      const w = dec(r.weight).div(knownTotal);
      hhi = hhi.plus(w.times(w));
    }
    effectiveN = dec(1).div(hhi);
  }

  return {
    topN,
    hhi: str(hhi),
    effectiveN: str(effectiveN),
    nominalN,
  };
}
