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
import { readFileSync } from 'node:fs';
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
// Configuration (§18.3). The persona-specific default weights and the weekly
// notification budgets are DATA, not logic: they live in JSON config files
// (config/persona-weights.json, config/notification-budgets.json) so they can
// be retuned without changing this module. They are loaded and validated once
// at module init; a malformed config fails fast with a precise error.
// ---------------------------------------------------------------------------

const PERSONAS: Persona[] = ['quality_growth', 'value', 'dividend_income', 'passive_index', 'unknown'];
const WEIGHT_KEYS: Array<keyof RelevanceWeights> = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9'];

const CONFIG_DIR = new URL('../config/', import.meta.url);

function loadConfig<T>(file: string): T {
  try {
    return JSON.parse(readFileSync(new URL(file, CONFIG_DIR), 'utf8')) as T;
  } catch (err) {
    throw new Error(`@atlas/relevance: cannot load config ${file}: ${(err as Error).message}`);
  }
}

function validateWeights(raw: Record<string, unknown>): Record<Persona, RelevanceWeights> {
  const out = {} as Record<Persona, RelevanceWeights>;
  for (const persona of PERSONAS) {
    const w = raw[persona] as Partial<RelevanceWeights> | undefined;
    if (!w) throw new Error(`@atlas/relevance: persona-weights.json missing persona "${persona}"`);
    const resolved = {} as RelevanceWeights;
    for (const k of WEIGHT_KEYS) {
      const v = w[k];
      if (typeof v !== 'string' || v.trim() === '' || Number.isNaN(Number(v))) {
        throw new Error(`@atlas/relevance: persona-weights.json ${persona}.${k} must be a decimal string`);
      }
      resolved[k] = v;
    }
    out[persona] = resolved;
  }
  return out;
}

function validateBudgets(raw: Record<string, unknown>): WeeklyBudget {
  const out = {} as WeeklyBudget;
  for (const persona of PERSONAS) {
    const n = raw[persona];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
      throw new Error(`@atlas/relevance: notification-budgets.json ${persona} must be a non-negative integer`);
    }
    // §18.6 hard numbers: floor 1, ceiling 6. A config edit cannot make Atlas
    // louder than the PRD permits.
    if (n < WEEKLY_BUDGET_FLOOR || n > WEEKLY_BUDGET_CEILING) {
      throw new Error(
        `@atlas/relevance: notification-budgets.json ${persona} = ${n} is outside the §18.6 range ` +
          `[${WEEKLY_BUDGET_FLOOR}, ${WEEKLY_BUDGET_CEILING}]`,
      );
    }
    out[persona] = n;
  }
  return out;
}

/**
 * Default weights by persona (§18.3 "persona-specific default weights"), loaded
 * from config/persona-weights.json. Passive indexers want quiet; conviction
 * strategies weight thesis/materiality up — all tunable in the JSON, not here.
 */
export const DEFAULT_WEIGHTS: Record<Persona, RelevanceWeights> = validateWeights(
  loadConfig<Record<string, unknown>>('persona-weights.json'),
);

// ---------------------------------------------------------------------------
// Class exemptions (§18.4). Two DIFFERENT sets, deliberately.
// ---------------------------------------------------------------------------

/**
 * §18.4 — "C0/C1/C2 are budget-exempt because the user asked for them."
 *
 * A rule the user wrote, a thesis condition they declared, a radar they armed:
 * suppressing any of these would break the promise that made them set it up.
 * So they are neither blocked by the weekly budget nor do they spend it —
 * "exempt" has to mean both, or a busy week of rule breaches would silently
 * consume the allowance meant for what Atlas raises on its own.
 *
 * Everything Atlas generates UNPROMPTED is budgeted: C3 material event,
 * C4 portfolio drift, C5 learning, C6 product.
 */
export const BUDGET_EXEMPT_CLASSES: readonly string[] = ['C0', 'C1', 'C2'];

export function isBudgetExempt(briefClass: string): boolean {
  return BUDGET_EXEMPT_CLASSES.includes(briefClass);
}

/**
 * §18.6 — "Hard cap: 2 / day, always, no exemption except C0."
 *
 * Narrower than the weekly exemption above, and that asymmetry is the PRD's,
 * not an oversight: a rule breach never gets budgeted away, but it still cannot
 * interrupt you more than twice in a day. Anyone tempted to unify these two
 * sets should read both sections first.
 */
export const DAILY_CAP_EXEMPT_CLASSES: readonly string[] = ['C0'];

export function isDailyCapExempt(briefClass: string): boolean {
  return DAILY_CAP_EXEMPT_CLASSES.includes(briefClass);
}

/**
 * Weekly notification budgets per persona (§18.3), loaded from
 * config/notification-budgets.json. Counts BUDGETED interruptions only — see
 * BUDGET_EXEMPT_CLASSES (§18.4). Sits ALONGSIDE the §18.6 2/day hard cap.
 *
 * §18.6 fixes the hard numbers this config must respect: base 3/week, floor 1,
 * ceiling 6. Validation enforces the floor/ceiling so a future edit cannot make
 * Atlas louder than the PRD permits.
 */
export const WEEKLY_BUDGET_FLOOR = 1;
export const WEEKLY_BUDGET_CEILING = 6;

export const WEEKLY_BUDGET: WeeklyBudget = validateBudgets(
  loadConfig<Record<string, unknown>>('notification-budgets.json'),
);

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
