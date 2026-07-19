/**
 * @atlas/relevance — the Relevance Ranker (§18.3).
 *
 * A pure, deterministic scoring engine, DELIBERATELY independent of the LLM
 * provider (§18.3): it is arithmetic over normalized features, so the same
 * inputs always produce the same ranking (FR-5.6) and nothing here imports the
 * intelligence plane.
 *
 * The model is implemented exactly as specified (§18.3):
 *
 *   relevance =  w1·materiality
 *              + w2·position_weight
 *              + w3·thesis_linkage
 *              + w4·rule_linkage
 *              + w5·strategy_linkage
 *              + w6·novelty
 *              + w7·actionability
 *              − w8·noise_prior
 *              − w9·recent_volume
 *
 * Weights are configurable, with persona-specific defaults and user-specific
 * learned overrides; a weekly notification budget is defined per persona.
 */
import { dec, str, ZERO, type Dec } from '@atlas/domain';
import type {
  Persona,
  RelevanceCandidate,
  RelevanceFeatures,
  RelevanceWeights,
  ScoredCandidate,
  Strategy,
  WeeklyBudget,
} from '@atlas/contracts';

// Re-export the ranker's contract types so consumers depend on one package.
export type {
  Persona,
  RelevanceCandidate,
  RelevanceFeatures,
  RelevanceWeights,
  ScoredCandidate,
  WeeklyBudget,
} from '@atlas/contracts';

// ---------------------------------------------------------------------------
// Persona defaults (§18.3 "persona-specific default weights").
// ---------------------------------------------------------------------------

/**
 * A neutral baseline, tuned per persona below. The additive terms (w1..w7)
 * express "how much this kind of signal matters to this investor"; the
 * subtractive terms (w8 noise_prior, w9 recent_volume) express restraint — how
 * hard to push back on noise and how quickly to back off after recent volume.
 */
const BASELINE: RelevanceWeights = {
  w1: '0.25', // materiality
  w2: '0.20', // position_weight
  w3: '0.20', // thesis_linkage
  w4: '0.15', // rule_linkage
  w5: '0.10', // strategy_linkage
  w6: '0.10', // novelty
  w7: '0.10', // actionability
  w8: '0.15', // noise_prior
  w9: '0.10', // recent_volume
};

/**
 * Default weights by persona. Passive indexers want quiet: materiality and
 * thesis linkage matter less, noise/volume restraint matters more. Conviction
 * strategies (quality-growth, value) weight thesis/materiality up. Income
 * investors sit in between with stronger noise suppression.
 */
export const DEFAULT_WEIGHTS: Record<Persona, RelevanceWeights> = {
  quality_growth: {
    ...BASELINE,
    w1: '0.28',
    w3: '0.28', // the thesis is the point
    w5: '0.12',
  },
  value: {
    ...BASELINE,
    w1: '0.30', // a mispricing event is material by definition
    w2: '0.24',
    w3: '0.22',
  },
  dividend_income: {
    ...BASELINE,
    w1: '0.22',
    w4: '0.18', // income rules (yield, concentration) carry weight
    w7: '0.08', // buy-and-hold: less about immediate action
    w8: '0.20', // more noise suppression
  },
  passive_index: {
    ...BASELINE,
    w1: '0.18',
    w3: '0.10',
    w6: '0.08',
    w8: '0.25', // want quiet
    w9: '0.18', // back off fast after recent volume
  },
  unknown: { ...BASELINE },
};

// ---------------------------------------------------------------------------
// Weekly budgets (§18.3 "weekly notification budgets defined for each persona").
// Counts NON-exempt interruptions only; C0 (a user's own falsification firing)
// is never budgeted away (§18.4). These sit ALONGSIDE the §18.6 2/day hard cap.
// ---------------------------------------------------------------------------

export const WEEKLY_BUDGET: WeeklyBudget = {
  quality_growth: 7,
  value: 7,
  dividend_income: 5,
  passive_index: 3,
  unknown: 5,
};

/** The persona for a user: stated strategy wins, else inferred, else unknown. */
export function personaFor(stated: Strategy | null, inferred: Strategy | null): Persona {
  if (stated && stated !== 'unknown') return stated;
  if (inferred && inferred !== 'unknown') return inferred;
  return 'unknown';
}

/** The weekly budget for a persona (§18.3). */
export function weeklyBudgetFor(persona: Persona, budget: WeeklyBudget = WEEKLY_BUDGET): number {
  return budget[persona];
}

// ---------------------------------------------------------------------------
// Weight resolution: persona default, then user-specific learned overrides.
// ---------------------------------------------------------------------------

/**
 * Resolve the effective weights: start from the persona default and apply any
 * user-specific learned overrides (§18.3 "user-specific learned weight
 * overrides"). Overrides are partial — only the weights the user has learned
 * values for are replaced; the rest fall back to the persona default.
 */
export function resolveWeights(
  persona: Persona,
  overrides?: Partial<RelevanceWeights> | null,
  defaults: Record<Persona, RelevanceWeights> = DEFAULT_WEIGHTS,
): RelevanceWeights {
  const base = defaults[persona];
  if (!overrides) return { ...base };
  const merged = { ...base };
  for (const k of Object.keys(base) as Array<keyof RelevanceWeights>) {
    const v = overrides[k];
    if (v !== undefined && v !== null) merged[k] = v;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Scoring — the §18.3 formula, verbatim.
// ---------------------------------------------------------------------------

export function scoreRelevance(features: RelevanceFeatures, weights: RelevanceWeights): string {
  const positive: Array<[keyof RelevanceWeights, keyof RelevanceFeatures]> = [
    ['w1', 'materiality'],
    ['w2', 'positionWeight'],
    ['w3', 'thesisLinkage'],
    ['w4', 'ruleLinkage'],
    ['w5', 'strategyLinkage'],
    ['w6', 'novelty'],
    ['w7', 'actionability'],
  ];
  let score: Dec = ZERO;
  for (const [w, f] of positive) {
    score = score.plus(dec(weights[w]).times(features[f]));
  }
  // Subtractive terms (§18.3): noise_prior and recent_volume push relevance DOWN.
  score = score.minus(dec(weights.w8).times(features.noisePrior));
  score = score.minus(dec(weights.w9).times(features.recentVolume));
  return str(score);
}

// ---------------------------------------------------------------------------
// Ranking — deterministic: score DESC, then candidate id ASC as the stable
// tie-break so equal scores never reorder run-to-run (FR-5.6).
// ---------------------------------------------------------------------------

export function rankCandidates(
  candidates: RelevanceCandidate[],
  weights: RelevanceWeights,
): ScoredCandidate[] {
  const scored: ScoredCandidate[] = candidates.map((c) => ({
    ...c,
    score: scoreRelevance(c.features, weights),
  }));
  scored.sort((a, b) => {
    const d = dec(b.score).cmp(dec(a.score));
    if (d !== 0) return d;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return scored;
}

// ---------------------------------------------------------------------------
// Weekly budget enforcement (§18.3). Given ranked candidates and how many
// budgeted interruptions were already delivered this week, the highest-scoring
// candidates fill the remaining slots; the rest are suppressed (§28.3 — what
// Atlas chose NOT to send is product data, surfaced in the Weekly Review).
// ---------------------------------------------------------------------------

export interface BudgetDecision {
  deliver: ScoredCandidate[];
  suppress: ScoredCandidate[];
}

export function enforceWeeklyBudget(
  ranked: ScoredCandidate[],
  weeklyBudget: number,
  alreadyDeliveredThisWeek: number,
): BudgetDecision {
  const remaining = Math.max(0, weeklyBudget - alreadyDeliveredThisWeek);
  return {
    deliver: ranked.slice(0, remaining),
    suppress: ranked.slice(remaining),
  };
}

/** Convenience: is there any weekly budget left for this persona? */
export function hasWeeklyBudget(
  persona: Persona,
  alreadyDeliveredThisWeek: number,
  budget: WeeklyBudget = WEEKLY_BUDGET,
): boolean {
  return alreadyDeliveredThisWeek < weeklyBudgetFor(persona, budget);
}
