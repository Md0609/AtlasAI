/**
 * Radar API (Phase 3, §16, FR-7). Structured condition builder only at MVP
 * (Design §A4.3 — the NL box prefills the builder when the LLM lane arrives
 * in Phase 4b); every stored condition is machine-evaluable by construction.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { renderCondition } from '@atlas/signal-engine';
import { audit, requireUser } from './auth.js';
import { problem } from './http.js';
import { createRadar, radarConditionSchema } from './radar-service.js';

/** Billing is mocked at Phase 3 (§B8: everyone on a free internal plan);
 *  a generous fixed cap stands in for plan limits. Thesis radars never
 *  count against any limit (§16.6). */
const MAX_MANUAL_RADARS = 50;

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  security_id: z.string().uuid().optional(),
  condition_nl: z.string().trim().min(1).max(500),
  condition: radarConditionSchema,
});

const snoozeSchema = z.object({
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export function registerRadarRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.get('/v1/radars', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { rows } = await pool.query(
      `SELECT r.id, r.name, r.security_id, s.name AS security_name, r.condition_ast,
              r.condition_nl, r.source, r.status, r.paused_reason, r.snoozed_until::text,
              r.last_met, r.last_observed, r.last_evaluated_at, r.created_at,
              (SELECT count(*)::int FROM radar_fires f WHERE f.radar_id = r.id) AS fire_count
         FROM radars r LEFT JOIN securities s ON s.id = r.security_id
        WHERE r.user_id = $1 AND r.status <> 'archived'
        ORDER BY r.created_at DESC`,
      [user.id],
    );
    return reply.send({
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        security_id: r.security_id,
        security_name: r.security_name,
        condition_nl: r.condition_nl,
        rendered: renderCondition(r.condition_ast),
        source: r.source,
        status: r.status,
        paused_reason: r.paused_reason,
        snoozed_until: r.snoozed_until,
        last_met: r.last_met,
        last_observed: r.last_observed,
        last_evaluated_at: r.last_evaluated_at,
        fire_count: r.fire_count,
        created_at: r.created_at,
      })),
    });
  });

  app.get('/v1/radar-fires', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { rows } = await pool.query(
      `SELECT f.id::text, f.radar_id, r.name AS radar_name, r.condition_nl, r.source,
              f.fired_at, f.observed, f.brief_id
         FROM radar_fires f JOIN radars r ON r.id = f.radar_id
        WHERE f.user_id = $1 ORDER BY f.fired_at DESC LIMIT 100`,
      [user.id],
    );
    return reply.send({ data: rows });
  });

  app.post('/v1/radars', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return problem(reply, req, 400, 'validation', "Check the radar details", parsed.error.issues[0]?.message);
    }
    const d = parsed.data;
    const m = d.condition.metric as { securityId?: string; ruleId?: string };
    if (m.securityId) {
      const s = await pool.query(`SELECT 1 FROM securities WHERE id = $1`, [m.securityId]);
      if (s.rows.length === 0) return problem(reply, req, 404, 'not-found', 'Security not found');
    }
    if (m.ruleId) {
      const r = await pool.query(
        `SELECT 1 FROM rules WHERE id = $1 AND user_id = $2 AND removed_at IS NULL`,
        [m.ruleId, user.id],
      );
      if (r.rows.length === 0) return problem(reply, req, 404, 'not-found', 'Rule not found');
    }
    const { rows: countRows } = await pool.query(
      `SELECT count(*)::int AS n FROM radars
        WHERE user_id = $1 AND source = 'manual' AND status <> 'archived'`,
      [user.id],
    );
    if (countRows[0].n >= MAX_MANUAL_RADARS) {
      return problem(reply, req, 409, 'radar-limit', `Phase 3 caps manual radars at ${MAX_MANUAL_RADARS}`);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const radar = await createRadar(client, {
        userId: user.id,
        baseCurrency: user.baseCurrency,
        securityId: m.securityId ?? null,
        name: d.name,
        condition: d.condition,
        conditionNl: d.condition_nl,
        source: 'manual',
      });
      await audit(client, user.id, 'radar.create', 'radar', radar.id, req.traceId, { name: d.name });
      await client.query('COMMIT');
      // §16.2: confirmation shows the compiled rule in plain terms AND where
      // the metric stands right now.
      return reply.status(201).send({ data: radar });
    } catch (err) {
      await client.query('ROLLBACK');
      if ((err as { statusCode?: number }).statusCode === 400) {
        return problem(reply, req, 400, 'validation', (err as Error).message);
      }
      throw err;
    } finally {
      client.release();
    }
  });

  // Resume an auto-suppressed radar (§16.5: pause prompts a refine/resume).
  app.post('/v1/radars/:id/resume', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const { rows } = await pool.query(
      `UPDATE radars SET status = 'active', paused_reason = NULL
        WHERE id = $1 AND user_id = $2 AND status = 'paused' RETURNING id`,
      [id, user.id],
    );
    if (rows.length === 0) return problem(reply, req, 404, 'not-found', 'Paused radar not found');
    await audit(pool, user.id, 'radar.resume', 'radar', id, req.traceId);
    return reply.status(204).send();
  });

  app.post('/v1/radars/:id/snooze', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const parsed = snoozeSchema.safeParse(req.body);
    if (!parsed.success) {
      return problem(reply, req, 400, 'validation', 'snooze requires until (YYYY-MM-DD)');
    }
    const { id } = req.params as { id: string };
    const { rows } = await pool.query(
      `UPDATE radars SET snoozed_until = $3
        WHERE id = $1 AND user_id = $2 AND status <> 'archived' RETURNING id`,
      [id, user.id, parsed.data.until],
    );
    if (rows.length === 0) return problem(reply, req, 404, 'not-found', 'Radar not found');
    await audit(pool, user.id, 'radar.snooze', 'radar', id, req.traceId, { until: parsed.data.until });
    return reply.status(204).send();
  });

  app.delete('/v1/radars/:id', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const { rows } = await pool.query(
      `UPDATE radars SET status = 'archived', archived_at = now()
        WHERE id = $1 AND user_id = $2 AND source = 'manual' AND status <> 'archived'
        RETURNING id`,
      [id, user.id],
    );
    if (rows.length === 0) {
      return problem(
        reply,
        req,
        404,
        'not-found',
        'Manual radar not found',
        'Thesis radars are managed through their thesis — retire or supersede the thesis instead.',
      );
    }
    await audit(pool, user.id, 'radar.archive', 'radar', id, req.traceId);
    return reply.status(204).send();
  });
}
