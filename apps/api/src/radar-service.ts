/**
 * Radar creation — shared by manual radars and thesis auto-radars (F-14).
 * A radar is born validated AND baseline-evaluated in the caller's
 * transaction: edge-triggering needs a "before" state, and the §16.2 flow
 * shows the user the current value at confirmation time.
 */
import { z } from 'zod';
import type { RadarCondition } from '@atlas/contracts';
import {
  evaluateRadarCondition,
  renderCondition,
  validateRadarCondition,
} from '@atlas/signal-engine';
import { conditionSecurityIds, loadRadarContext } from './radar-context.js';
import type { Db } from './signals.js';

const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'must be a decimal string');

export const radarConditionSchema = z.object({
  metric: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('price'), securityId: z.string().uuid() }),
    z.object({ kind: z.literal('valuation.pe_ttm'), securityId: z.string().uuid() }),
    z.object({ kind: z.literal('fundamental'), securityId: z.string().uuid(), name: z.string().min(1).max(80) }),
    z.object({ kind: z.literal('portfolio.weight'), securityId: z.string().uuid() }),
    z.object({ kind: z.literal('portfolio.sector_exposure'), sector: z.string().min(1).max(80) }),
    z.object({ kind: z.literal('portfolio.cash_weight') }),
    z.object({ kind: z.literal('rule.breach'), ruleId: z.string().uuid() }),
  ]),
  operator: z.enum(['lt', 'lte', 'gt', 'gte']),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('literal'), value: decimalString }),
    z.object({
      kind: z.literal('self_history'),
      stat: z.enum(['median', 'min', 'max']),
      windowDays: z.number().int().min(30).max(3660),
      factor: decimalString.optional(),
    }),
  ]),
}) satisfies z.ZodType<RadarCondition>;

export interface CreateRadarInput {
  userId: string;
  baseCurrency: string;
  securityId: string | null;
  name: string;
  condition: RadarCondition;
  conditionNl: string;
  source: 'manual' | 'thesis';
  thesisConditionId?: string;
}

export interface CreatedRadar {
  id: string;
  name: string;
  conditionNl: string;
  rendered: string;
  current: { value: string | null; target: string | null; met: boolean | null; gap: string | null };
}

/** MUST run inside the caller's transaction (§27.4 for thesis radars). */
export async function createRadar(client: Db, input: CreateRadarInput): Promise<CreatedRadar> {
  const errors = validateRadarCondition(input.condition);
  if (errors.length > 0) {
    throw Object.assign(new Error(`condition not machine-evaluable: ${errors.join('; ')}`), {
      statusCode: 400,
    });
  }

  // Baseline evaluation: sets the edge-trigger "before" state and gives the
  // caller the current value for the confirmation surface.
  const ctx = await loadRadarContext(
    client,
    input.userId,
    input.baseCurrency,
    conditionSecurityIds([input.condition]),
  );
  const evaluation = evaluateRadarCondition(input.condition, ctx);

  const { rows } = await client.query(
    `INSERT INTO radars (user_id, security_id, name, condition_ast, condition_nl,
                         source, thesis_condition_id, last_met, last_observed, last_evaluated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     RETURNING id`,
    [
      input.userId,
      input.securityId,
      input.name,
      JSON.stringify(input.condition),
      input.conditionNl,
      input.source,
      input.thesisConditionId ?? null,
      evaluation.met,
      JSON.stringify(evaluation),
    ],
  );
  return {
    id: rows[0].id,
    name: input.name,
    conditionNl: input.conditionNl,
    rendered: renderCondition(input.condition),
    current: evaluation,
  };
}
