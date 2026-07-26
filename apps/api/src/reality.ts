/**
 * Portfolio Reality Check (F-09, §14.3) — GET /v1/portfolios/:id/reality-check.
 *
 * Deterministic end to end at Phase 2: Signal Engine → correlation clusters →
 * Surprise Detector → template narration v0. Every numeral in every rendered
 * string is computed (P4); the response carries provenance, staleness,
 * warnings (short correlation history) and declared gaps.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import {
  computePortfolioSignals,
  correlationClusters,
  detectSurprises,
  inferStrategy,
  type ReturnSeriesInput,
} from '@atlas/signal-engine';
import type { Strategy, Surprise } from '@atlas/contracts';
import { narrate, newTraceId } from '@atlas/agents';
import { requireUser } from './auth.js';
import { problem } from './http.js';
import { ownedPortfolio } from './portfolios.js';
import { loadPeInputs } from './profile.js';
import { loadEngineInputs, type Db } from './signals.js';

async function loadReturnSeries(
  db: Db,
  positions: Array<{ securityId: string; label: string; weight: string }>,
): Promise<ReturnSeriesInput[]> {
  if (positions.length === 0) return [];
  const { rows } = await db.query(
    `SELECT security_id, bar_date::text AS date, adjusted_close::text AS close
       FROM price_bars WHERE security_id = ANY($1)
      ORDER BY security_id, bar_date`,
    [positions.map((p) => p.securityId)],
  );
  const barsBySec = new Map<string, Array<{ date: string; close: string }>>();
  for (const r of rows) {
    const list = barsBySec.get(r.security_id) ?? [];
    list.push({ date: r.date, close: r.close });
    barsBySec.set(r.security_id, list);
  }
  return positions.map((p) => ({
    securityId: p.securityId,
    label: p.label,
    weight: p.weight,
    bars: barsBySec.get(p.securityId) ?? [],
  }));
}

export function registerRealityRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.get('/v1/portfolios/:id/reality-check', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const p = await ownedPortfolio(pool, user.id, id);
    if (!p) return problem(reply, req, 404, 'not-found', 'Portfolio not found');

    const inputs = await loadEngineInputs(pool, p);
    const signals = computePortfolioSignals(inputs, new Date().toISOString());

    // Correlation over DIRECT equity positions (funds correlate with their
    // own constituents by construction — including them would manufacture
    // clusters out of arithmetic).
    const secById = new Map(inputs.securities.map((s) => [s.id, s]));
    const directEquities = signals.weights.value
      .filter((w) => w.securityId !== null && !(secById.get(w.securityId)?.isFund ?? false))
      .map((w) => ({ securityId: w.securityId as string, label: w.label, weight: w.weight }));
    const correlation = correlationClusters(await loadReturnSeries(pool, directEquities));

    // D6 needs the stated strategy (when a profile exists) and the inference.
    const { rows: profRows } = await pool.query(
      `SELECT stated_strategy FROM profile_versions WHERE user_id = $1 AND valid_to IS NULL`,
      [user.id],
    );
    const statedStrategy = (profRows[0]?.stated_strategy ?? null) as Strategy | null;
    const namedIds = signals.lookThrough.value
      .filter((r) => r.securityId !== null)
      .map((r) => r.securityId as string);
    const inference = inferStrategy(
      inputs,
      signals.weights.value,
      signals.lookThrough.value,
      await loadPeInputs(pool, namedIds),
    );

    const result = detectSurprises({
      signals,
      correlation,
      statedStrategy,
      inferredStrategy: inference.hypothesis,
      baseCurrency: p.base_currency,
    });

    // LLM narration (§B1) — rephrase each surprise body behind the Guard, with
    // the template as the degradation path. Deterministic under the mock; the
    // real provider is a drop-in (ATLAS_LLM_PROVIDER). Numbers stay provenanced:
    // narrate() rejects any narration that introduces or alters a figure.
    const traceId = newTraceId();
    let narrationDegraded = false;
    // Starts false and only becomes true if a model actually wrote a body that
    // survived the numeral check. The template path — which is every path when
    // the fixture provider is active — is not analysis.
    let narrationGenerative = false;
    let narrationModel = 'template';
    const narratedTop: Surprise[] = await Promise.all(
      result.top.map(async (s) => {
        try {
          const n = await narrate(pool, {
            userId: user.id,
            surface: 'reality_check',
            template: s.body,
            facts: s.values,
            traceId,
          });
          narrationModel = n.model;
          if (n.degraded) narrationDegraded = true;
          if (n.generative) narrationGenerative = true;
          return { ...s, body: n.text };
        } catch {
          narrationDegraded = true; // never let narration break the deterministic result
          return s;
        }
      }),
    );

    return reply.send({
      data: {
        top: narratedTop,
        others: result.others,
        total_value_base: signals.totalValueBase,
        base_currency: signals.baseCurrency,
        correlation: {
          clusters: correlation.clusters,
          window_days: correlation.windowDays,
        },
      },
      warnings: result.warnings,
      gaps: [...signals.gaps, ...correlation.gaps, ...result.gaps],
      provenance: {
        engineVersion: signals.engineVersion,
        inputHash: signals.inputHash,
        methodology: 'surprise.v1',
        inputs: {
          pricesAsOf: signals.pricesAsOf,
          fxAsOf: signals.fxAsOf,
          holdingsAsOf: signals.holdingsAsOf,
        },
        narration: {
          traceId,
          model: narrationModel,
          // Every figure remains engine-computed; the model only rephrases, and
          // any narration that drifts on a number degrades to the template.
          degraded: narrationDegraded,
          // Whether a model wrote any of this prose at all. Independent of
          // `degraded`: the fixture is not degraded and is not generative.
          generative: narrationGenerative,
        },
      },
      staleness: {
        prices_as_of: signals.pricesAsOf,
        fx_as_of: signals.fxAsOf,
        holdings_as_of: signals.holdingsAsOf,
      },
      generated_at: new Date().toISOString(),
    });
  });
}
