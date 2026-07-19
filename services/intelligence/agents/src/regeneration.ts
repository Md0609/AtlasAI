/**
 * The Guard regeneration loop (§21.6).
 *
 * "Guard rejection → regenerate ≤2 → degrade." When generated content fails the
 * Compliance Guard, Atlas does not immediately fall back: it regenerates, up to
 * a fixed limit, feeding the SPECIFIC violations back so the next attempt can
 * correct them (which is why the Guard reports every violation, not just the
 * first — §21.6). Only after the retries are exhausted does it degrade to the
 * deterministic path (the safe doc / template). Every attempt is a real,
 * traced, metered generation whose verdict is recorded with its `regenerated`
 * index (§29.1), so the audit shows the whole loop.
 *
 * This is provider-agnostic and deterministic in structure: under the fixture
 * the first attempt returns the guard-clean template and the loop never
 * regenerates; the loop only does work when a live model returns fresh content
 * that fails the Guard. Tests drive it with providers that fail on purpose.
 */
import type { GuardVerdict } from '@atlas/contracts';

/** §21.6: regenerate at most twice, then degrade. */
export const MAX_REGENERATIONS = 2;

export interface GuardedOutcome<T> {
  approved: boolean;
  result: T;
  /** Violations from this attempt, fed into the next regeneration's prompt. */
  violations: GuardVerdict['violations'];
}

export interface RegenerationResult<T> {
  result: T;
  approved: boolean;
  /** How many REGENERATIONS ran (0 = approved first try; MAX = exhausted). */
  regenerations: number;
}

/**
 * Run `attempt` until the Guard approves or the regeneration budget is spent.
 * `attempt(index, priorViolations)` performs ONE generate-then-guard cycle;
 * index 0 is the initial attempt, 1..max are regenerations, and priorViolations
 * carries the previous rejection's specifics so the attempt can correct them.
 */
export async function withRegeneration<T>(
  attempt: (index: number, priorViolations: GuardVerdict['violations']) => Promise<GuardedOutcome<T>>,
  maxRegenerations: number = MAX_REGENERATIONS,
): Promise<RegenerationResult<T>> {
  let prior: GuardVerdict['violations'] = [];
  let last: GuardedOutcome<T> | undefined;
  for (let i = 0; i <= maxRegenerations; i++) {
    last = await attempt(i, prior);
    if (last.approved) return { result: last.result, approved: true, regenerations: i };
    prior = last.violations;
  }
  // Budget exhausted — the caller degrades to its deterministic path.
  return { result: last!.result, approved: false, regenerations: maxRegenerations };
}

/**
 * Render the Guard's specific violations as a corrective instruction for the
 * next regeneration attempt (§21.6 "regeneration needs the specifics").
 */
export function correctionForViolations(violations: GuardVerdict['violations']): string {
  if (violations.length === 0) return '';
  const lines = violations.map((v) => `- [${v.layer}:${v.code}] ${v.detail}`).join('\n');
  return (
    'Your previous response was blocked by the compliance guard for the following reasons:\n' +
    `${lines}\n` +
    'Produce a corrected response that removes every one of these. Never state a directive, ' +
    'rating, price target, or prediction; reference every figure by the signals in the bundle.'
  );
}
