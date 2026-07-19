/**
 * @atlas/portfolio-core — shared portfolio WRITE paths.
 *
 * The counterpart to @atlas/dataplane (which stays read-only, so the
 * intelligence plane can depend on it without dragging in the job queue).
 * What lives here is logic that both the API request handlers AND the
 * background workers must run identically: evaluating a user's rules against
 * their consolidated portfolio, persisting the evaluations, and enqueuing the
 * briefs those evaluations trigger.
 *
 * It previously lived in apps/api and was reached by the workers through
 * `@atlas/api/internal`, which made a background worker depend on the whole
 * HTTP application. Extracting it removes that inversion: both consumers now
 * depend on this package, and nothing depends on the API app.
 *
 * Deliberately free of Fastify, HTTP, and auth: this is domain logic over a
 * pg client, callable inside any transaction.
 */
import type { RuleType } from '@atlas/contracts';
import {
  computePortfolioSignals,
  evaluateRules,
  type RuleContext,
  type RuleInput,
  type SellRecord,
} from '@atlas/signal-engine';
import { enqueue } from '@atlas/bus';
import { loadConsolidatedInputs, type Db } from '@atlas/dataplane';

export type { Db };

async function loadSells(db: Db, userId: string): Promise<SellRecord[]> {
  const { rows } = await db.query(
    `SELECT t.security_id, s.name AS label, t.trade_date::text AS sell_date,
            (SELECT min(b.trade_date)::text
               FROM transactions b JOIN portfolios pb ON pb.id = b.portfolio_id
              WHERE pb.user_id = $1 AND b.security_id = t.security_id
                AND b.tx_type = 'buy' AND b.trade_date <= t.trade_date) AS first_buy
       FROM transactions t
       JOIN portfolios p ON p.id = t.portfolio_id
       JOIN securities s ON s.id = t.security_id
      WHERE p.user_id = $1 AND p.deleted_at IS NULL AND t.tx_type = 'sell'`,
    [userId],
  );
  return rows.map((r) => ({
    securityId: r.security_id,
    label: r.label,
    sellDate: r.sell_date,
    firstBuyDate: r.first_buy,
  }));
}

/**
 * Evaluate every live rule of a user against their consolidated portfolio and
 * persist the evaluations. MUST be called with the same client/transaction as
 * the portfolio write it follows (§27.4: "a rule that doesn't reflect the
 * current portfolio is worse than no rule").
 */
export async function evaluateAndPersistUserRules(
  db: Db,
  userId: string,
  baseCurrency: string,
): Promise<void> {
  const { rows: ruleRows } = await db.query(
    `SELECT id, rule_type, params FROM rules WHERE user_id = $1 AND removed_at IS NULL`,
    [userId],
  );
  if (ruleRows.length === 0) return;

  const inputs = await loadConsolidatedInputs(db, userId, baseCurrency);
  const signals = computePortfolioSignals(inputs, new Date().toISOString());
  const secById = new Map(inputs.securities.map((s) => [s.id, s.name]));
  const ctx: RuleContext = {
    lookThrough: signals.lookThrough.value,
    sectorExposure: signals.exposure.sector.value,
    cashWeight: signals.cashWeight,
    directPositions: inputs.positions.map((p) => ({
      securityId: p.securityId,
      label: secById.get(p.securityId) ?? p.securityId,
    })),
    sells: await loadSells(db, userId),
  };
  const rules: RuleInput[] = ruleRows.map((r) => ({
    id: r.id,
    ruleType: r.rule_type as RuleType,
    params: r.params,
  }));
  const results = evaluateRules(rules, ctx);

  // Previous status per rule, to detect ok→breach transitions (C1 briefs
  // fire on the transition, not on every evaluation while breached).
  const { rows: prevRows } = await db.query(
    `SELECT DISTINCT ON (rule_id) rule_id, status FROM rule_evaluations
      WHERE user_id = $1 ORDER BY rule_id, evaluated_at DESC`,
    [userId],
  );
  const prevStatus = new Map<string, string>(prevRows.map((r) => [r.rule_id, r.status]));

  await db.query(`SELECT ensure_rule_evaluations_partition(now())`);
  for (const res of results) {
    await db.query(
      `INSERT INTO rule_evaluations (rule_id, user_id, status, observed, engine_version, input_hash)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [res.ruleId, userId, res.status, JSON.stringify(res.observed), signals.engineVersion, signals.inputHash],
    );
    if (res.status === 'breach' && prevStatus.get(res.ruleId) !== 'breach') {
      // §18.4 class C1, generated in the same transaction as the evaluation.
      await enqueue(db, 'brief.generate', userId, { kind: 'rule_breach', ruleId: res.ruleId, userId });
    }
  }
}
