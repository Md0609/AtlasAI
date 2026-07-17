/**
 * Rules engine API (F-05, §14.6, US-ONB-05).
 *
 *  - stated_reason is mandatory at creation and quoted back at breach time —
 *    the quote is the mechanism (§14.6).
 *  - Removal requires a one-line reason (DELETE with a body, per §31.2
 *    "DELETE requires reason"); the rule is soft-removed, never erased.
 *  - Rules belong to the USER and are evaluated against the consolidated
 *    view of everything they own (§14.2).
 *  - Evaluation is deterministic (Signal Engine rules.v1) and runs in the
 *    SAME database transaction as every portfolio write (§27.4: "a rule that
 *    doesn't reflect the current portfolio is worse than no rule").
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { RuleType } from '@atlas/contracts';
import {
  computePortfolioSignals,
  evaluateRules,
  type RuleContext,
  type RuleInput,
  type SellRecord,
} from '@atlas/signal-engine';
import { dec, fixed, str } from '@atlas/domain';
import { audit, requireUser } from './auth.js';
import { problem } from './http.js';
import { loadConsolidatedInputs, type Db } from './signals.js';

// ---------------------------------------------------------------------------
// Param validation per rule type — a rule the engine can't evaluate must be
// rejected at the door (US-ONB-05), not stored and skipped.
// ---------------------------------------------------------------------------

const fraction = z
  .string()
  .regex(/^(0(\.\d+)?|1(\.0+)?)$/, 'must be a fraction between 0 and 1, e.g. "0.15"');

const ruleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('max_single_name'), params: z.object({ limit: fraction }) }),
  z.object({
    type: z.literal('max_sector'),
    params: z.object({ sector: z.string().min(1), limit: fraction }),
  }),
  z.object({ type: z.literal('min_cash'), params: z.object({ limit: fraction }) }),
  z.object({ type: z.literal('max_cash'), params: z.object({ limit: fraction }) }),
  z.object({
    type: z.literal('no_buy_list'),
    params: z.object({
      securityIds: z.array(z.string().uuid()).min(1).max(200),
      label: z.string().max(200).optional(),
    }),
  }),
  z.object({
    type: z.literal('max_positions'),
    params: z.object({ count: z.number().int().positive().max(1000) }),
  }),
  z.object({
    type: z.literal('min_holding_period'),
    params: z.object({ months: z.number().int().positive().max(240) }),
  }),
]);

const createRuleSchema = z.intersection(
  ruleSchema,
  z.object({
    stated_reason: z.string().trim().min(1, 'stated_reason is required — it is quoted back at breach time').max(500),
    severity: z.enum(['info', 'standard', 'hard']).default('standard'),
  }),
);

const removeRuleSchema = z.object({
  reason: z.string().trim().min(1, 'removing a rule requires a one-line reason (§14.6)').max(500),
});

// ---------------------------------------------------------------------------
// Evaluation — callable from any portfolio-write transaction
// ---------------------------------------------------------------------------

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
 * the portfolio write it follows (§27.4).
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

  await db.query(`SELECT ensure_rule_evaluations_partition(now())`);
  for (const res of results) {
    await db.query(
      `INSERT INTO rule_evaluations (rule_id, user_id, status, observed, engine_version, input_hash)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [res.ruleId, userId, res.status, JSON.stringify(res.observed), signals.engineVersion, signals.inputHash],
    );
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerRuleRoutes(app: FastifyInstance, pool: pg.Pool): void {
  // Live rules with their latest evaluation, breach duration and the reason
  // the user gave when they set the rule (quoted back — §14.6).
  app.get('/v1/rules', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { rows } = await pool.query(
      `WITH latest AS (
         SELECT DISTINCT ON (rule_id) rule_id, status, observed, evaluated_at
           FROM rule_evaluations WHERE user_id = $1
          ORDER BY rule_id, evaluated_at DESC
       ),
       last_ok AS (
         SELECT rule_id, max(evaluated_at) AS t
           FROM rule_evaluations WHERE user_id = $1 AND status <> 'breach'
          GROUP BY rule_id
       ),
       breach_since AS (
         SELECT e.rule_id, min(e.evaluated_at) AS since
           FROM rule_evaluations e LEFT JOIN last_ok o ON o.rule_id = e.rule_id
          WHERE e.user_id = $1 AND e.status = 'breach'
            AND (o.t IS NULL OR e.evaluated_at > o.t)
          GROUP BY e.rule_id
       )
       SELECT r.id, r.rule_type, r.params, r.stated_reason, r.severity, r.created_at,
              l.status, l.observed, l.evaluated_at,
              CASE WHEN l.status = 'breach' THEN b.since END AS breach_since
         FROM rules r
         LEFT JOIN latest l ON l.rule_id = r.id
         LEFT JOIN breach_since b ON b.rule_id = r.id
        WHERE r.user_id = $1 AND r.removed_at IS NULL
        ORDER BY r.created_at`,
      [user.id],
    );
    return reply.send({
      data: rows.map((r) => ({
        id: r.id,
        type: r.rule_type,
        params: r.params,
        stated_reason: r.stated_reason,
        severity: r.severity,
        created_at: r.created_at,
        evaluation: r.status
          ? { status: r.status, observed: r.observed, evaluated_at: r.evaluated_at, breach_since: r.breach_since }
          : null,
      })),
    });
  });

  app.post('/v1/rules', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const parsed = createRuleSchema.safeParse(req.body);
    if (!parsed.success) {
      return problem(reply, req, 400, 'validation', 'Invalid rule payload', parsed.error.issues[0]?.message);
    }
    const d = parsed.data;
    if (d.type === 'no_buy_list') {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM securities WHERE id = ANY($1)`, [
        d.params.securityIds,
      ]);
      if (rows[0].n !== d.params.securityIds.length) {
        return problem(reply, req, 404, 'not-found', 'One or more securities in the no-buy list do not exist');
      }
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO rules (user_id, rule_type, params, stated_reason, severity)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, rule_type, params, stated_reason, severity, created_at`,
        [user.id, d.type, JSON.stringify(d.params), d.stated_reason, d.severity],
      );
      // A rule is born evaluated: it must reflect the current portfolio from
      // its first second (§27.4).
      await evaluateAndPersistUserRules(client, user.id, user.baseCurrency);
      await audit(client, user.id, 'rule.create', 'rule', rows[0].id, req.traceId, { type: d.type });
      await client.query('COMMIT');
      return reply.status(201).send({ data: rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // Removing a rule requires writing down why. The anticipation of writing
  // that sentence is the intervention (§14.6).
  app.delete('/v1/rules/:id', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const parsed = removeRuleSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return problem(
        reply,
        req,
        400,
        'rule-removal-reason-required',
        'Removing a rule requires a reason',
        parsed.error.issues[0]?.message,
      );
    }
    const { rows } = await pool.query(
      `UPDATE rules SET removed_at = now(), removal_reason = $3
        WHERE id = $1 AND user_id = $2 AND removed_at IS NULL
        RETURNING id`,
      [id, user.id, parsed.data.reason],
    );
    if (rows.length === 0) return problem(reply, req, 404, 'not-found', 'Rule not found');
    await audit(pool, user.id, 'rule.remove', 'rule', id, req.traceId, { reason: parsed.data.reason });
    return reply.status(204).send();
  });

  // Pre-filled suggestions derived from the actual portfolio (D-002:
  // "Max 15% single name (you're at 11% now)").
  app.get('/v1/rules/suggestions', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const inputs = await loadConsolidatedInputs(pool, user.id, user.baseCurrency);
    const signals = computePortfolioSignals(inputs, new Date().toISOString());
    const suggestions: Array<{
      type: RuleType;
      params: Record<string, unknown>;
      current: string;
      rationale: string;
    }> = [];

    const named = signals.lookThrough.value.filter((r) => r.securityId !== null);
    if (named.length > 0) {
      const top = named[0]!;
      const w = dec(top.weight);
      const limit = nextStep(w);
      suggestions.push({
        type: 'max_single_name',
        params: { limit: str(limit) },
        current: str(w),
        rationale: `Max ${fixed(limit.times(100), 0)}% in a single name (${top.label} is at ${fixed(
          w.times(100),
          1,
        )}% now, look-through)`,
      });
    }
    const topSector = signals.exposure.sector.value.find((s) => s.key !== 'UNKNOWN' && s.key !== 'CASH');
    if (topSector) {
      const w = dec(topSector.weight);
      const limit = nextStep(w);
      suggestions.push({
        type: 'max_sector',
        params: { sector: topSector.key, limit: str(limit) },
        current: str(w),
        rationale: `Max ${fixed(limit.times(100), 0)}% in ${topSector.key} (you're at ${fixed(w.times(100), 1)}% now)`,
      });
    }
    suggestions.push({
      type: 'min_cash',
      params: { limit: '0.03' },
      current: signals.cashWeight,
      rationale: `Keep at least 3% cash (you're at ${fixed(dec(signals.cashWeight).times(100), 1)}% now)`,
    });
    const n = inputs.positions.length;
    if (n > 0) {
      suggestions.push({
        type: 'max_positions',
        params: { count: Math.max(10, Math.ceil((n + 5) / 5) * 5) },
        current: String(n),
        rationale: `Cap the number of positions (you hold ${n} now) — more names than you can follow is diversification theatre`,
      });
    }
    suggestions.push({
      type: 'min_holding_period',
      params: { months: 12 },
      current: '—',
      rationale: 'Hold for at least 12 months — the cheapest defence against trading on noise',
    });

    return reply.send({
      data: suggestions,
      provenance: {
        engineVersion: signals.engineVersion,
        inputHash: signals.inputHash,
        methodology: 'rule_suggestions.v1',
        inputs: {
          pricesAsOf: signals.pricesAsOf,
          fxAsOf: signals.fxAsOf,
          holdingsAsOf: signals.holdingsAsOf,
        },
      },
      generated_at: new Date().toISOString(),
    });
  });
}

/** Round a weight up to the next 5% step, minimum 10%. */
function nextStep(w: ReturnType<typeof dec>) {
  const stepped = w.times(20).ceil().div(20).plus('0.05');
  return stepped.lt('0.1') ? dec('0.1') : stepped;
}
