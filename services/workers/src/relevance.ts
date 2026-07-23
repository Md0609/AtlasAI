/**
 * Relevance wiring for the notification pipeline (§18.3).
 *
 * The scoring model itself is the pure, deterministic, LLM-independent engine
 * in @atlas/relevance. This module is the thin DB adapter around it: resolve a
 * user's persona and learned weight overrides, extract the nine features from a
 * brief, and expose the weekly-budget counters the dispatcher enforces.
 *
 * Feature extraction is deterministic and derived only from brief metadata that
 * exists at generation time. `positionWeight` is populated when a look-through
 * weight is available for the subject and is 0 otherwise (radar/rule briefs are
 * event-triggered, not position-sized) — a real feature that is simply 0 for
 * those event types, never a fabricated number.
 */
import type pg from 'pg';
import type { RelevanceFeatures, RelevanceWeights, Strategy } from '@atlas/contracts';
import { dec, str } from '@atlas/domain';
import {
  personaFor,
  resolveWeights,
  scoreRelevance,
  weeklyBudgetFor,
  type Persona,
} from '@atlas/relevance';

type BriefClass = 'C0' | 'C1' | 'C2';

// Class-anchored feature priors (§18.4 class semantics → §18.3 features).
const MATERIALITY: Record<BriefClass, string> = { C0: '1', C1: '0.7', C2: '0.5' };
const NOISE_PRIOR: Record<BriefClass, string> = { C0: '0', C1: '0.1', C2: '0.3' };
const ACTIONABILITY: Record<BriefClass, string> = { C0: '1', C1: '0.8', C2: '0.5' };

export async function personaForUser(db: pg.Pool | pg.PoolClient, userId: string): Promise<Persona> {
  const { rows } = await db.query(
    `SELECT stated_strategy, inferred_strategy FROM profile_versions
      WHERE user_id = $1 AND valid_to IS NULL`,
    [userId],
  );
  return personaFor(
    (rows[0]?.stated_strategy ?? null) as Strategy | null,
    (rows[0]?.inferred_strategy ?? null) as Strategy | null,
  );
}

/** Persona default merged with the user's learned overrides (§18.3). */
export async function weightsForUser(
  db: pg.Pool | pg.PoolClient,
  userId: string,
  persona: Persona,
): Promise<RelevanceWeights> {
  const { rows } = await db.query(
    `SELECT weights FROM relevance_weight_overrides WHERE user_id = $1`,
    [userId],
  );
  return resolveWeights(persona, (rows[0]?.weights ?? null) as Partial<RelevanceWeights> | null);
}

/**
 * The user's EFFECTIVE weekly budget: the §18.3 persona default plus the delta
 * the user has retrained via "tell me about these next time" (§28.3 / US-NOT-02),
 * floored at zero.
 */
export async function effectiveWeeklyBudget(
  db: pg.Pool | pg.PoolClient,
  userId: string,
  persona: Persona,
): Promise<number> {
  const { rows } = await db.query(
    `SELECT weekly_budget_delta FROM user_notification_prefs WHERE user_id = $1`,
    [userId],
  );
  const delta = rows[0]?.weekly_budget_delta ?? 0;
  return Math.max(0, weeklyBudgetFor(persona) + delta);
}

/** Non-C0 interruptions already delivered to the user in the current week. */
export async function weeklyDeliveredCount(
  db: pg.Pool | pg.PoolClient,
  userId: string,
  day: string,
): Promise<number> {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM notification_budget_ledger
      WHERE user_id = $1 AND class <> 'C0'
        AND week_bucket = date_trunc('week', $2::date)::date`,
    [userId, day],
  );
  return rows[0].n;
}

export interface BriefFeatureInput {
  briefClass: BriefClass;
  securityLinked: boolean;
  thesisLinked: boolean;
  ruleLinked: boolean;
  /** Look-through weight of the subject in [0,1] as a decimal string; '0' if n/a. */
  positionWeight?: string;
  /** Non-C0 interruptions already delivered this week (for recent_volume). */
  weeklyDelivered: number;
  weeklyBudget: number;
}

/** Extract the nine §18.3 features from a brief. Deterministic. */
export function briefFeatures(i: BriefFeatureInput): RelevanceFeatures {
  const recentVolume =
    i.weeklyBudget > 0 ? clampUnit(dec(i.weeklyDelivered).div(i.weeklyBudget)) : '0';
  return {
    materiality: MATERIALITY[i.briefClass],
    positionWeight: clampUnit(dec(i.positionWeight ?? '0')),
    thesisLinkage: i.thesisLinked ? '1' : '0',
    ruleLinkage: i.ruleLinked ? '1' : '0',
    strategyLinkage: i.securityLinked ? '0.5' : '0',
    novelty: '1', // survived semantic dedup ⇒ a new story (§24.3)
    actionability: ACTIONABILITY[i.briefClass],
    noisePrior: NOISE_PRIOR[i.briefClass],
    recentVolume,
  };
}

export interface BriefRelevance {
  persona: Persona;
  score: string;
  weightsSource: 'default' | 'override';
  features: RelevanceFeatures;
}

/** Full pipeline: persona → weights (with overrides) → features → score. */
export async function computeBriefRelevance(
  db: pg.Pool | pg.PoolClient,
  userId: string,
  input: Omit<BriefFeatureInput, 'weeklyBudget'>,
): Promise<BriefRelevance> {
  const persona = await personaForUser(db, userId);
  const weeklyBudget = weeklyBudgetFor(persona);
  const { rows } = await db.query(
    `SELECT weights FROM relevance_weight_overrides WHERE user_id = $1`,
    [userId],
  );
  const override = (rows[0]?.weights ?? null) as Partial<RelevanceWeights> | null;
  const weights = resolveWeights(persona, override);
  const features = briefFeatures({ ...input, weeklyBudget });
  return {
    persona,
    score: scoreRelevance(features, weights),
    weightsSource: override && Object.keys(override).length > 0 ? 'override' : 'default',
    features,
  };
}

function clampUnit(d: ReturnType<typeof dec>): string {
  if (d.lt(0)) return '0';
  if (d.gt(1)) return '1';
  return str(d);
}
