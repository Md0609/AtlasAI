/**
 * Investor Profile (Phase 2 "The mirror"): versioned profile with stated vs
 * revealed risk (FR-2.2/2.3), scenario-based risk assessment calibrated to
 * the user's actual money (F-03, US-ONB-04), and deterministic strategy
 * inference presented as a hypothesis (F-04, US-ONB-03).
 *
 * Structural rules:
 *  - Versions are append-only (§27.3.1); the DB trigger makes mutation
 *    impossible, this file just plays along: new version = close + insert,
 *    one transaction.
 *  - The profile NEVER changes without an explicit user action (FR-2.5):
 *    inference is a GET that proposes; only POST /v1/profile persists.
 *  - Scenario answer → band mapping lives here, server-side; the client
 *    cannot claim a band its answer doesn't map to.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { RiskBand, RiskScenario } from '@atlas/contracts';
import { computePortfolioSignals, inferStrategy, type PeInput } from '@atlas/signal-engine';
import { dec, fixed, str } from '@atlas/domain';
import { audit, requireUser } from './auth.js';
import { problem } from './http.js';
import { ownedPortfolio } from './portfolios.js';
import { loadEngineInputs } from './signals.js';

const STRATEGIES = ['quality_growth', 'value', 'dividend_income', 'passive_index', 'unknown'] as const;
const CAPITAL_BANDS = ['<25k', '25k-100k', '100k-500k', '>500k'] as const;

/** Midpoint used to calibrate scenarios when no portfolio value exists yet. */
const BAND_MIDPOINT: Record<(typeof CAPITAL_BANDS)[number], string> = {
  '<25k': '12000',
  '25k-100k': '60000',
  '100k-500k': '250000',
  '>500k': '750000',
};

// ---------------------------------------------------------------------------
// Scenarios: fixed structure, calibrated amounts. The option→band map is
// static and server-owned; prompts carry the user's own numbers (US-ONB-04).
// ---------------------------------------------------------------------------

const SCENARIO_OPTIONS: Record<string, Array<{ key: string; label: string; band: RiskBand }>> = {
  market_drawdown: [
    { key: 'buy_more', label: 'Add money — prices are better now', band: 5 },
    { key: 'nothing', label: 'Nothing. This is what markets do', band: 4 },
    { key: 'trim_some', label: 'Sell part of it to feel safer', band: 2 },
    { key: 'sell_everything', label: 'Sell everything before it gets worse', band: 1 },
  ],
  single_position_loss: [
    { key: 'buy_more', label: 'Buy more if the reason I own it is intact', band: 5 },
    { key: 'nothing', label: 'Re-read why I own it, then likely nothing', band: 4 },
    { key: 'trim_some', label: 'Cut the position in half', band: 2 },
    { key: 'sell_position', label: 'Sell it all — a 40% drop means I was wrong', band: 1 },
  ],
  flat_years: [
    { key: 'stay_course', label: 'Stay the course; three years is a short window', band: 4 },
    { key: 'small_changes', label: 'Review and make small adjustments', band: 3 },
    { key: 'overhaul', label: 'Overhaul the whole strategy', band: 2 },
    { key: 'move_to_cash', label: 'Move it all to the savings account', band: 1 },
  ],
};

function buildScenarios(
  totalBase: string,
  baseCurrency: string,
  largest: { label: string; weight: string } | null,
): RiskScenario[] {
  const total = dec(totalBase);
  const fmt = (d: ReturnType<typeof dec>) => `${fixed(d, 0)} ${baseCurrency}`;
  const drop32 = total.times('0.32');
  const scenarios: RiskScenario[] = [
    {
      scenarioId: 'market_drawdown',
      prompt:
        `Markets fall hard. Your portfolio drops 32% — from ${fmt(total)} to ` +
        `${fmt(total.minus(drop32))}. That is ${fmt(drop32)} gone on paper. What do you actually do?`,
      options: SCENARIO_OPTIONS.market_drawdown!,
    },
    {
      scenarioId: 'single_position_loss',
      prompt: largest
        ? `${largest.label} — ${fixed(dec(largest.weight).times(100), 1)}% of your portfolio — ` +
          `falls 40% on bad results. That is ${fmt(total.times(largest.weight).times('0.4'))} ` +
          `of your money. What do you actually do?`
        : `Your largest holding falls 40% on bad results. What do you actually do?`,
      options: SCENARIO_OPTIONS.single_position_loss!,
    },
    {
      scenarioId: 'flat_years',
      prompt:
        `Three years pass. Your portfolio has returned roughly 0% while a savings account ` +
        `paid 3% a year — you are about ${fmt(total.times('0.09'))} behind cash. What do you actually do?`,
      options: SCENARIO_OPTIONS.flat_years!,
    },
  ];
  return scenarios;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const scenarioAnswerSchema = z.object({
  scenario_id: z.string(),
  prompt: z.string().max(1000),
  answer: z.string(),
});

const profileSchema = z.object({
  experience_level: z.enum(['beginner', 'intermediate', 'advanced', 'professional']).optional(),
  horizon_years: z.number().int().positive().max(80).optional(),
  capital_band: z.enum(CAPITAL_BANDS).optional(),
  monthly_contribution: z.string().optional(),
  contribution_currency: z.string().length(3).optional(),
  decumulation: z.boolean().optional(),
  stated_strategy: z.enum(STRATEGIES).optional(),
  /** Present when the user accepted the inference hypothesis (US-ONB-03). */
  accepted_inference: z
    .object({ hypothesis: z.enum(STRATEGIES), confidence: z.string() })
    .optional(),
  risk_stated: z.number().int().min(1).max(5).optional(),
  scenario_answers: z.array(scenarioAnswerSchema).max(10).default([]),
  change_reason: z.string().min(1).max(500).optional(),
});

// ---------------------------------------------------------------------------

function rowToProfile(r: Record<string, unknown>) {
  return {
    version: r.version,
    experienceLevel: r.experience_level,
    horizonYears: r.horizon_years,
    capitalBand: r.capital_band,
    monthlyContribution: r.monthly_contribution,
    contributionCurrency: r.contribution_currency,
    decumulation: r.decumulation,
    statedStrategy: r.stated_strategy,
    inferredStrategy: r.inferred_strategy,
    strategySource: r.strategy_source,
    strategyConfidence: r.strategy_confidence,
    riskStated: r.risk_stated,
    riskRevealed: r.risk_revealed,
    riskDivergenceFlag: r.risk_divergence_flag,
    scenarioResponses: r.scenario_responses,
    changeReason: r.change_reason,
    changedBy: r.changed_by,
    validFrom: r.valid_from,
  };
}

const PROFILE_COLS = `version, experience_level, horizon_years, capital_band,
  monthly_contribution::text, contribution_currency, decumulation,
  stated_strategy, inferred_strategy, strategy_source, strategy_confidence::text,
  risk_stated, risk_revealed, risk_divergence_flag, scenario_responses,
  change_reason, changed_by, valid_from`;

export async function loadPeInputs(pool: pg.Pool, securityIds: string[]): Promise<PeInput[]> {
  if (securityIds.length === 0) return [];
  // P/E = latest adjusted close / latest ttm diluted EPS, same currency only.
  const { rows } = await pool.query(
    `SELECT f.security_id, f.value::text AS eps, f.currency AS eps_ccy,
            p.adjusted_close::text AS close, p.currency AS px_ccy
       FROM (SELECT DISTINCT ON (security_id) security_id, value, currency
               FROM fundamentals
              WHERE metric = 'eps_diluted_ttm' AND security_id = ANY($1)
              ORDER BY security_id, as_of DESC) f
       JOIN (SELECT DISTINCT ON (security_id) security_id, adjusted_close, currency
               FROM price_bars WHERE security_id = ANY($1)
              ORDER BY security_id, bar_date DESC) p
         ON p.security_id = f.security_id`,
    [securityIds],
  );
  const out: PeInput[] = [];
  for (const r of rows) {
    if (r.eps_ccy && r.eps_ccy !== r.px_ccy) continue; // no cross-currency P/E
    const eps = dec(r.eps);
    if (eps.lte(0)) continue;
    out.push({ securityId: r.security_id, pe: str(dec(r.close).div(eps)) });
  }
  return out;
}

export function registerProfileRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.get('/v1/profile', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { rows } = await pool.query(
      `SELECT ${PROFILE_COLS} FROM profile_versions
        WHERE user_id = $1 AND valid_to IS NULL`,
      [user.id],
    );
    return reply.send({ data: rows[0] ? rowToProfile(rows[0]) : null });
  });

  app.get('/v1/profile/versions', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { rows } = await pool.query(
      `SELECT ${PROFILE_COLS}, valid_to FROM profile_versions
        WHERE user_id = $1 ORDER BY version`,
      [user.id],
    );
    return reply.send({ data: rows.map(rowToProfile) });
  });

  // Scenario definitions, calibrated to the caller's actual portfolio when one
  // exists (US-ONB-04: "calibrated to the user's actual portfolio value in
  // their currency"), else to the capital band midpoint.
  app.get('/v1/profile/scenarios', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const q = req.query as { portfolio_id?: string; capital_band?: string };

    let total = '0';
    let currency = user.baseCurrency;
    let largest: { label: string; weight: string } | null = null;

    if (q.portfolio_id) {
      const p = await ownedPortfolio(pool, user.id, q.portfolio_id);
      if (!p) return problem(reply, req, 404, 'not-found', 'Portfolio not found');
      const signals = computePortfolioSignals(await loadEngineInputs(pool, p), new Date().toISOString());
      total = signals.totalValueBase;
      currency = p.base_currency;
      const named = signals.lookThrough.value.filter((r) => r.securityId !== null);
      if (named.length > 0) largest = { label: named[0]!.label, weight: named[0]!.weight };
    }
    if (dec(total).lte(0)) {
      const band = (q.capital_band ?? '25k-100k') as keyof typeof BAND_MIDPOINT;
      total = BAND_MIDPOINT[band] ?? BAND_MIDPOINT['25k-100k'];
      largest = null;
    }
    return reply.send({ data: buildScenarios(total, currency, largest) });
  });

  // Deterministic strategy inference (F-04). A proposal — persists nothing.
  app.get('/v1/portfolios/:id/strategy-inference', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const p = await ownedPortfolio(pool, user.id, id);
    if (!p) return problem(reply, req, 404, 'not-found', 'Portfolio not found');

    const inputs = await loadEngineInputs(pool, p);
    const signals = computePortfolioSignals(inputs, new Date().toISOString());
    const namedIds = signals.lookThrough.value
      .filter((r) => r.securityId !== null)
      .map((r) => r.securityId as string);
    const pes = await loadPeInputs(pool, namedIds);
    const inference = inferStrategy(inputs, signals.weights.value, signals.lookThrough.value, pes);

    return reply.send({
      data: inference,
      provenance: {
        engineVersion: signals.engineVersion,
        inputHash: signals.inputHash,
        methodology: 'strategy.v1',
        inputs: {
          pricesAsOf: signals.pricesAsOf,
          fxAsOf: signals.fxAsOf,
          holdingsAsOf: signals.holdingsAsOf,
        },
      },
      gaps: inference.gaps,
      generated_at: new Date().toISOString(),
    });
  });

  // Create a new profile version. FR-2.1: actor, timestamp, reason on every
  // change; FR-2.5: this is the ONLY code path that writes the profile.
  app.post('/v1/profile', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success) {
      return problem(reply, req, 400, 'validation', 'Invalid profile payload', parsed.error.issues[0]?.message);
    }
    const d = parsed.data;
    if (d.monthly_contribution !== undefined && d.contribution_currency === undefined) {
      return problem(reply, req, 400, 'validation', 'monthly_contribution requires contribution_currency (no implicit currency)');
    }

    // Server-side band mapping: an answer only counts if it maps to a known
    // option of a known scenario.
    const responses: Array<{ scenarioId: string; prompt: string; answer: string; answerBand: RiskBand }> = [];
    for (const a of d.scenario_answers) {
      const opt = SCENARIO_OPTIONS[a.scenario_id]?.find((o) => o.key === a.answer);
      if (!opt) {
        return problem(reply, req, 400, 'validation', `Unknown scenario answer ${a.scenario_id}/${a.answer}`);
      }
      responses.push({ scenarioId: a.scenario_id, prompt: a.prompt, answer: a.answer, answerBand: opt.band });
    }
    let riskRevealed: number | null = null;
    if (responses.length > 0) {
      const sum = responses.reduce((acc, r) => acc + r.answerBand, 0);
      riskRevealed = Math.round(sum / responses.length);
    }
    const riskStated = d.risk_stated ?? null;
    const divergence =
      riskStated !== null && riskRevealed !== null ? Math.abs(riskStated - riskRevealed) > 2 : false;

    const statedStrategy = d.stated_strategy ?? null;
    const inferred = d.accepted_inference ?? null;
    const strategySource =
      statedStrategy && inferred ? 'hybrid' : statedStrategy ? 'stated' : inferred ? 'inferred' : 'unknown';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: cur } = await client.query(
        `SELECT id, version FROM profile_versions
          WHERE user_id = $1 AND valid_to IS NULL FOR UPDATE`,
        [user.id],
      );
      const prev = cur[0] ?? null;
      const version = prev ? (prev.version as number) + 1 : 1;
      if (version > 1 && !d.change_reason) {
        await client.query('ROLLBACK');
        return problem(reply, req, 400, 'validation', 'change_reason is required when updating a profile (FR-2.1)');
      }
      if (prev) {
        await client.query('UPDATE profile_versions SET valid_to = now() WHERE id = $1', [prev.id]);
      }
      const { rows } = await client.query(
        `INSERT INTO profile_versions (
           user_id, version, experience_level, horizon_years, capital_band,
           monthly_contribution, contribution_currency, decumulation,
           stated_strategy, inferred_strategy, strategy_source, strategy_confidence,
           risk_stated, risk_revealed, risk_divergence_flag, scenario_responses,
           change_reason, changed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'user')
         RETURNING ${PROFILE_COLS}`,
        [
          user.id,
          version,
          d.experience_level ?? null,
          d.horizon_years ?? null,
          d.capital_band ?? null,
          d.monthly_contribution ?? null,
          d.contribution_currency?.toUpperCase() ?? null,
          d.decumulation ?? false,
          statedStrategy,
          inferred?.hypothesis ?? null,
          strategySource,
          inferred?.confidence ?? null,
          riskStated,
          riskRevealed,
          divergence,
          JSON.stringify(responses),
          d.change_reason ?? 'initial onboarding',
        ],
      );
      await audit(client, user.id, 'profile.version_created', 'profile_version', String(rows[0].version), req.traceId, {
        version,
        strategy_source: strategySource,
        risk_divergence_flag: divergence,
      });
      await client.query('COMMIT');
      return reply.status(201).send({ data: rowToProfile(rows[0]) });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}
