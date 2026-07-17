/**
 * Strategy inference (F-04, US-ONB-03) — strategy.v1.
 *
 * A deterministic hypothesis about what the portfolio says its owner believes,
 * presented as exactly that: a hypothesis with evidence, a confidence scaled
 * by data coverage, and declared gaps. No LLM: the inputs are portfolio
 * structure and fundamentals, and the rules are inspectable.
 *
 * The inference NEVER writes to the profile (FR-2.5) — it is a proposal the
 * user confirms or corrects; the API stores it only with the user's consent
 * and records strategy_source = 'inferred'.
 */
import type { LookThroughRow, Strategy, StrategyEvidence, StrategyInference, WeightRow } from '@atlas/contracts';
import { Dec, ONE, ZERO, dec, fixed, str } from '@atlas/domain';
import type { EngineInputs } from './types.js';

/** Latest trailing-twelve-month P/E per security, computed upstream (price / eps). */
export interface PeInput {
  securityId: string;
  pe: string;
}

const FUND_WEIGHT_PASSIVE = dec('0.6');
const PE_GROWTH = dec('25');
const PE_VALUE = dec('15');
const TECH_TILT = dec('0.4');
const MIN_PE_COVERAGE = dec('0.3');

export function inferStrategy(
  inputs: EngineInputs,
  weights: WeightRow[],
  lookThroughRows: LookThroughRow[],
  pes: PeInput[],
): StrategyInference {
  const gaps: StrategyInference['gaps'] = [];
  const evidence: StrategyEvidence[] = [];
  const secById = new Map(inputs.securities.map((s) => [s.id, s]));

  const invested = weights.filter((w) => w.securityId !== null);
  const investedTotal = invested.reduce((a, w) => a.plus(w.weight), ZERO);
  if (investedTotal.isZero()) {
    return {
      hypothesis: 'unknown',
      confidence: '0',
      evidence: [],
      gaps: [{ component: 'strategy_inference', reason: 'portfolio has no invested positions' }],
    };
  }

  // -- Signal 1: share of invested money in funds (direct weights) ----------
  const fundWeight = invested
    .filter((w) => secById.get(w.securityId as string)?.isFund)
    .reduce((a, w) => a.plus(w.weight), ZERO)
    .div(investedTotal);
  evidence.push({
    metric: 'fund_weight',
    value: str(fundWeight),
    observation: `${fixed(fundWeight.times(100), 1)}% of invested money is in funds/ETFs`,
  });
  if (fundWeight.gte(FUND_WEIGHT_PASSIVE)) {
    return {
      hypothesis: 'passive_index',
      confidence: str(clamp01(dec('0.5').plus(fundWeight.times('0.4')))),
      evidence,
      gaps,
    };
  }

  // -- Signal 2: weighted-average P/E over look-through names ---------------
  const peBySec = new Map(pes.map((p) => [p.securityId, dec(p.pe)]));
  const named = lookThroughRows.filter((r) => r.securityId !== null);
  const namedTotal = named.reduce((a, r) => a.plus(dec(r.weight)), ZERO);
  let peWeighted = ZERO;
  let peCovered = ZERO;
  for (const r of named) {
    const pe = peBySec.get(r.securityId as string);
    if (!pe || pe.lte(0)) continue;
    peWeighted = peWeighted.plus(pe.times(r.weight));
    peCovered = peCovered.plus(r.weight);
  }
  const peCoverage = namedTotal.isZero() ? ZERO : peCovered.div(namedTotal);
  const avgPe = peCovered.isZero() ? null : peWeighted.div(peCovered);
  if (avgPe !== null) {
    evidence.push({
      metric: 'weighted_avg_pe',
      value: str(avgPe),
      observation: `weighted average P/E of ${fixed(avgPe, 1)}× across the ${fixed(
        peCoverage.times(100),
        0,
      )}% of holdings with earnings data`,
    });
  } else {
    gaps.push({ component: 'strategy_inference', reason: 'no earnings data for any holding' });
  }

  // -- Signal 3: technology tilt on look-through exposure -------------------
  let techWeight = ZERO;
  for (const r of named) {
    const sec = secById.get(r.securityId as string);
    if (sec?.gicsSector === 'Information Technology') techWeight = techWeight.plus(r.weight);
  }
  const techShare = namedTotal.isZero() ? ZERO : techWeight.div(namedTotal);
  evidence.push({
    metric: 'tech_share',
    value: str(techShare),
    observation: `${fixed(techShare.times(100), 1)}% of known look-through exposure is Information Technology`,
  });

  // -- Decision rules, cheapest-to-refute first ------------------------------
  if (avgPe !== null && peCoverage.gte(MIN_PE_COVERAGE)) {
    if (avgPe.gte(PE_GROWTH)) {
      return { hypothesis: 'quality_growth', confidence: str(conf(peCoverage)), evidence, gaps };
    }
    if (avgPe.lte(PE_VALUE)) {
      return { hypothesis: 'value', confidence: str(conf(peCoverage)), evidence, gaps };
    }
  } else if (avgPe !== null) {
    gaps.push({
      component: 'strategy_inference',
      reason: `earnings data covers only ${fixed(peCoverage.times(100), 0)}% of holdings — below the ${fixed(
        MIN_PE_COVERAGE.times(100),
        0,
      )}% needed to lean on valuation`,
    });
  }
  if (techShare.gte(TECH_TILT)) {
    return {
      hypothesis: 'quality_growth',
      confidence: str(clamp01(dec('0.35').plus(techShare.times('0.3')))),
      evidence,
      gaps,
    };
  }

  // Honest fallback (P6): not enough signal to name a strategy.
  gaps.push({
    component: 'strategy_inference',
    reason: 'portfolio structure does not clearly match any strategy archetype',
  });
  return { hypothesis: 'unknown', confidence: '0.2', evidence, gaps };
}

function conf(coverage: Dec): Dec {
  return clamp01(dec('0.4').plus(coverage.times('0.5')));
}

function clamp01(d: Dec): Dec {
  if (d.lt(0)) return ZERO;
  if (d.gt(1)) return ONE;
  return d;
}

export type { Strategy };
