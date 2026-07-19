/**
 * Context assembly for the intelligence plane (§21.2 layer boundary).
 *
 *  - buildSecurityContext: Layer-1, USER-AGNOSTIC. Security metadata + a named
 *    signal bundle of security-level facts (valuation, fundamentals). It has
 *    no user field, so its cache key (§40) and its regulatory status (§0
 *    impersonal research) are the same line. This is what specialists see.
 *
 *  - buildUserBundle: Layer-2, PERSONAL. The user's portfolio facts about this
 *    security — look-through weight, sector exposure, cash, effective-N — plus
 *    the user's rules and active thesis. Only the PSA sees this.
 *
 * Every signal is a ContextSignalValue carrying provenance, so the numbers the
 * PSA references are provenanced by construction (P4 / US-AI-02).
 */
import type {
  ContextSignalValue,
  Finding,
  Provenance,
  SecurityContext,
} from '@atlas/contracts';
import { computePortfolioSignals } from '@atlas/signal-engine';
import {
  loadConsolidatedInputs,
  loadPeInputs,
  type Db,
} from '@atlas/dataplane';

function prov(methodology: string, inputHash: string): Provenance {
  return {
    engineVersion: 'engine.v1',
    inputHash,
    methodology,
    inputs: { pricesAsOf: null, fxAsOf: null, holdingsAsOf: null },
  };
}

function sig(value: string, methodology: string, inputHash: string, currency?: string): ContextSignalValue {
  return currency
    ? { value, currency, provenance: prov(methodology, inputHash) }
    : { value, provenance: prov(methodology, inputHash) };
}

export async function buildSecurityContext(db: Db, securityId: string): Promise<SecurityContext> {
  const { rows: secRows } = await db.query(
    `SELECT id, name, gics_sector, currency FROM securities WHERE id = $1`,
    [securityId],
  );
  if (secRows.length === 0) throw new Error(`security ${securityId} not found`);
  const sec = secRows[0];

  const signals: Record<string, ContextSignalValue> = {};
  const hashBase = `sec:${securityId}`;

  const pes = await loadPeInputs(db, [securityId]);
  const pe = pes.find((p) => p.securityId === securityId);
  if (pe) signals['valuation.pe_ttm'] = sig(pe.pe, 'valuation.pe_ttm', hashBase);

  const { rows: funds } = await db.query(
    `SELECT DISTINCT ON (metric) metric, value::text, currency
       FROM fundamentals WHERE security_id = $1 AND metric IN ('revenue_ttm','eps_diluted_ttm')
      ORDER BY metric, as_of DESC`,
    [securityId],
  );
  for (const f of funds) {
    signals[`fundamental.${f.metric}`] = sig(f.value, `fundamental.${f.metric}`, hashBase, f.currency ?? undefined);
  }

  return {
    securityId,
    name: sec.name,
    gicsSector: sec.gics_sector,
    signals,
  };
}

export interface UserRuleRow {
  id: string;
  ruleType: string;
  params: Record<string, unknown>;
  statedReason: string;
  status: string | null;
  observed: { value: string | null; limit: string | null; detail: string | null } | null;
}

export interface UserThesisRow {
  id: string;
  statement: string;
  status: string;
}

export interface UserBundle {
  baseCurrency: string;
  /** Portfolio-level signals about this security, provenanced. */
  signals: Record<string, ContextSignalValue>;
  rules: UserRuleRow[];
  thesis: UserThesisRow | null;
  /** Falsification conditions that have been met (for T2). */
  metConditions: Array<{ id: string; conditionNl: string; thesisId: string }>;
}

export async function buildUserBundle(
  db: Db,
  userId: string,
  baseCurrency: string,
  securityId: string,
): Promise<UserBundle> {
  const inputs = await loadConsolidatedInputs(db, userId, baseCurrency);
  const signals: Record<string, ContextSignalValue> = {};
  const hashBase = `user:${userId}:${securityId}`;

  if (inputs.positions.length > 0 || inputs.cash.length > 0) {
    const s = computePortfolioSignals(inputs, new Date().toISOString());
    const ih = s.inputHash;
    const lt = s.lookThrough.value.find((r) => r.securityId === securityId);
    if (lt) signals['portfolio.look_through_weight'] = sig(lt.weight, 'lookthrough.v1', ih);
    signals['portfolio.cash_weight'] = sig(s.cashWeight, 'weights.v1', ih);
    signals['portfolio.effective_n'] = sig(s.concentration.value.effectiveN, 'concentration.v1', ih);
    const sector = s.exposure.sector.value.find((x) => x.key !== 'UNKNOWN' && x.key !== 'CASH');
    if (sector) signals['portfolio.top_sector_weight'] = sig(sector.weight, 'exposure.sector.v1', ih);
  }

  const { rows: ruleRows } = await db.query(
    `SELECT r.id, r.rule_type, r.params, r.stated_reason,
            (SELECT e.status FROM rule_evaluations e WHERE e.rule_id = r.id
              ORDER BY e.evaluated_at DESC LIMIT 1) AS status,
            (SELECT e.observed FROM rule_evaluations e WHERE e.rule_id = r.id
              ORDER BY e.evaluated_at DESC LIMIT 1) AS observed
       FROM rules r WHERE r.user_id = $1 AND r.removed_at IS NULL`,
    [userId],
  );
  const rules: UserRuleRow[] = ruleRows.map((r) => ({
    id: r.id,
    ruleType: r.rule_type,
    params: r.params,
    statedReason: r.stated_reason,
    status: r.status,
    observed: r.observed,
  }));

  const { rows: thesisRows } = await db.query(
    `SELECT id, statement, status FROM theses
      WHERE user_id = $1 AND security_id = $2 AND status = 'active' LIMIT 1`,
    [userId, securityId],
  );
  const thesis: UserThesisRow | null = thesisRows[0]
    ? { id: thesisRows[0].id, statement: thesisRows[0].statement, status: thesisRows[0].status }
    : null;

  const { rows: metRows } = await db.query(
    `SELECT tc.id, tc.condition_nl, tc.thesis_id
       FROM thesis_conditions tc JOIN theses t ON t.id = tc.thesis_id
      WHERE t.user_id = $1 AND t.security_id = $2 AND tc.status = 'met'`,
    [userId, securityId],
  );
  const metConditions = metRows.map((r) => ({
    id: r.id,
    conditionNl: r.condition_nl,
    thesisId: r.thesis_id,
  }));

  return { baseCurrency, signals, rules, thesis, metConditions };
}

/** Merge Layer-1 security signals and Layer-2 user signals into one bundle. */
export function mergeSignals(
  security: SecurityContext,
  user: UserBundle,
): Record<string, ContextSignalValue> {
  return { ...security.signals, ...user.signals };
}

export type { Finding };
