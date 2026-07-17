/**
 * Look-through: expand fund positions into constituent single names.
 *
 *  - Recursive (funds of funds, §28.3), depth-capped at 5.
 *  - Cycle-safe: a fund appearing in its own expansion path routes that
 *    weight to the unknown slice (adversarial fixture: "a fund holding
 *    itself", §48.2).
 *  - The unknown remainder is a first-class output row (D-006). It is never
 *    redistributed pro-rata, because that would be inventing data.
 */
import type { LookThroughRow, SecurityRef } from '@atlas/contracts';
import { Dec, ZERO, dec, str } from '@atlas/domain';
import type { EngineInputs } from './types.js';

const MAX_DEPTH = 5;

interface Accum {
  viaDirect: Dec;
  viaFunds: Dec;
}

export interface LookThroughResult {
  rows: LookThroughRow[]; // single names, sorted by weight desc; excludes cash
  unknownWeight: Dec; // explicit unknown slice as fraction of total portfolio
  holdingsAsOf: string | null;
}

export function lookThrough(
  inputs: EngineInputs,
  portfolioWeights: Array<{ securityId: string; weight: Dec }>,
): LookThroughResult {
  const secById = new Map<string, SecurityRef>(inputs.securities.map((s) => [s.id, s]));
  const holdingsByFund = new Map<string, EngineInputs['fundHoldings']>();
  let holdingsAsOf: string | null = null;
  for (const h of inputs.fundHoldings) {
    const list = holdingsByFund.get(h.fundSecurityId) ?? [];
    list.push(h);
    holdingsByFund.set(h.fundSecurityId, list);
    if (!holdingsAsOf || h.asOf > holdingsAsOf) holdingsAsOf = h.asOf;
  }

  const accum = new Map<string, Accum>();
  let unknown = ZERO;

  const add = (securityId: string, w: Dec, direct: boolean) => {
    const a = accum.get(securityId) ?? { viaDirect: ZERO, viaFunds: ZERO };
    if (direct) a.viaDirect = a.viaDirect.plus(w);
    else a.viaFunds = a.viaFunds.plus(w);
    accum.set(securityId, a);
  };

  const expand = (securityId: string, weight: Dec, path: Set<string>, depth: number, direct: boolean) => {
    if (weight.isZero()) return;
    const sec = secById.get(securityId);
    const isFund = sec?.isFund ?? false;

    if (!isFund) {
      add(securityId, weight, direct);
      return;
    }
    if (path.has(securityId)) {
      // Cycle: a fund inside its own expansion. Honest answer: unknown.
      unknown = unknown.plus(weight);
      return;
    }
    if (depth >= MAX_DEPTH) {
      unknown = unknown.plus(weight);
      return;
    }
    const holdings = holdingsByFund.get(securityId);
    if (!holdings || holdings.length === 0) {
      // Fund with no holdings data: the whole position is unknown exposure
      // (FR-3.7: display where look-through is unavailable).
      unknown = unknown.plus(weight);
      return;
    }
    const nextPath = new Set(path);
    nextPath.add(securityId);
    let covered = ZERO;
    for (const h of [...holdings].sort((a, b) => a.holdingSecurityId.localeCompare(b.holdingSecurityId))) {
      const hw = dec(h.weight);
      covered = covered.plus(hw);
      expand(h.holdingSecurityId, weight.times(hw), nextPath, depth + 1, false);
    }
    const remainder = dec(1).minus(covered);
    if (remainder.gt(0)) {
      unknown = unknown.plus(weight.times(remainder));
    }
  };

  for (const pw of portfolioWeights) {
    expand(pw.securityId, pw.weight, new Set(), 0, true);
  }

  const rows: LookThroughRow[] = [...accum.entries()]
    .map(([securityId, a]) => ({
      securityId,
      label: secById.get(securityId)?.name ?? securityId,
      weight: str(a.viaDirect.plus(a.viaFunds)),
      viaDirect: str(a.viaDirect),
      viaFunds: str(a.viaFunds),
    }))
    .sort((x, y) => dec(y.weight).cmp(dec(x.weight)) || x.securityId!.localeCompare(y.securityId!));

  if (unknown.gt(0)) {
    rows.push({
      securityId: null,
      label: 'Unknown (no holdings data)',
      weight: str(unknown),
      viaDirect: '0',
      viaFunds: str(unknown),
    });
  }

  return { rows, unknownWeight: unknown, holdingsAsOf };
}
