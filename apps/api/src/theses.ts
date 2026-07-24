/**
 * Thesis Ledger (Phase 3, §61.2, FR-4).
 *
 *  - PATCH returns 405: the API refuses to let you edit a belief (§31.2).
 *    You supersede it — new row, version+1, both visible forever.
 *  - Falsification conditions auto-generate radars in the SAME transaction
 *    (F-14, §27.4): "a thesis whose radar failed to create is a broken
 *    promise." The response tells the user it happened (§16.4).
 *  - DELETE retires (status transition with a reason); nothing is erased.
 *  - FR-4.7: thesis age is computed and stale (>12 months) flagged.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { renderCondition } from '@atlas/signal-engine';
import { recordEvent } from '@atlas/bus';
import { audit, requireUser } from './auth.js';
import { problem } from './http.js';
import { createRadar, radarConditionSchema, type CreatedRadar } from './radar-service.js';

const conditionInputSchema = z.object({
  condition_nl: z.string().trim().min(1).max(500),
  condition: radarConditionSchema,
});

const thesisSchema = z.object({
  security_id: z.string().uuid(),
  statement: z.string().trim().min(1).max(4000),
  time_horizon_months: z.number().int().positive().max(600).optional(),
  confidence: z.number().int().min(1).max(5).optional(),
  conditions: z.array(conditionInputSchema).max(5).default([]),
  supersedes_id: z.string().uuid().optional(),
  change_reason: z.string().trim().min(1).max(500).optional(),
});

const statusSchema = z.object({
  status: z.enum(['falsified', 'retired']),
  reason: z.string().trim().min(1, 'closing a thesis requires a reason — your future self will read it').max(500),
});

const THESIS_COLS = `t.id, t.security_id, s.name AS security_name, t.version, t.supersedes_id,
  t.statement, t.time_horizon_months, t.confidence_at_creation, t.status,
  t.status_changed_at, t.status_reason, t.created_at,
  (t.created_at < now() - interval '12 months') AS stale`;

async function archiveThesisRadars(client: pg.PoolClient, thesisId: string, reason: string): Promise<void> {
  await client.query(
    `UPDATE radars SET status = 'archived', archived_at = now(), paused_reason = $2
      WHERE status <> 'archived' AND thesis_condition_id IN
        (SELECT id FROM thesis_conditions WHERE thesis_id = $1)`,
    [thesisId, reason],
  );
}

export function registerThesisRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.get('/v1/theses', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const q = req.query as { security_id?: string; include_closed?: string };
    const params: unknown[] = [user.id];
    let where = `t.user_id = $1`;
    if (q.security_id) {
      params.push(q.security_id);
      where += ` AND t.security_id = $${params.length}`;
    }
    if (q.include_closed !== 'true') where += ` AND t.status = 'active'`;
    const { rows } = await pool.query(
      `SELECT ${THESIS_COLS} FROM theses t JOIN securities s ON s.id = t.security_id
        WHERE ${where} ORDER BY t.created_at DESC`,
      params,
    );
    const ids = rows.map((r) => r.id);
    const { rows: condRows } = ids.length
      ? await pool.query(
          `SELECT tc.id, tc.thesis_id, tc.condition_nl, tc.condition_ast, tc.status, tc.met_at,
                  r.id AS radar_id, r.status AS radar_status, r.last_observed
             FROM thesis_conditions tc LEFT JOIN radars r ON r.id = tc.radar_id
            WHERE tc.thesis_id = ANY($1) ORDER BY tc.created_at`,
          [ids],
        )
      : { rows: [] as never[] };
    const byThesis = new Map<string, unknown[]>();
    for (const c of condRows) {
      const list = byThesis.get(c.thesis_id) ?? [];
      list.push({
        id: c.id,
        condition_nl: c.condition_nl,
        rendered: renderCondition(c.condition_ast),
        status: c.status,
        met_at: c.met_at,
        radar: { id: c.radar_id, status: c.radar_status, last_observed: c.last_observed },
      });
      byThesis.set(c.thesis_id, list);
    }
    return reply.send({
      data: rows.map((r) => ({ ...r, conditions: byThesis.get(r.id) ?? [] })),
    });
  });

  app.post('/v1/theses', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const parsed = thesisSchema.safeParse(req.body);
    if (!parsed.success) {
      return problem(reply, req, 400, 'validation', "Check the thesis details", parsed.error.issues[0]?.message);
    }
    const d = parsed.data;
    const sec = await pool.query(`SELECT id FROM securities WHERE id = $1`, [d.security_id]);
    if (sec.rows.length === 0) return problem(reply, req, 404, 'not-found', 'Security not found');
    // Every condition must be about this thesis's security or the portfolio —
    // a thesis on ADBE cannot be falsified by a condition on NVDA.
    for (const c of d.conditions) {
      const m = c.condition.metric as { securityId?: string };
      if (m.securityId && m.securityId !== d.security_id) {
        return problem(reply, req, 400, 'validation', 'Thesis conditions must reference the thesis security or portfolio state');
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let version = 1;
      if (d.supersedes_id) {
        const { rows: prev } = await client.query(
          `SELECT id, version, security_id FROM theses
            WHERE id = $1 AND user_id = $2 AND status = 'active' FOR UPDATE`,
          [d.supersedes_id, user.id],
        );
        if (prev.length === 0) {
          await client.query('ROLLBACK');
          return problem(reply, req, 404, 'not-found', 'Thesis to supersede not found or not active');
        }
        if (prev[0].security_id !== d.security_id) {
          await client.query('ROLLBACK');
          return problem(reply, req, 400, 'validation', 'A thesis can only be superseded by one on the same security');
        }
        version = prev[0].version + 1;
        await client.query(
          `UPDATE theses SET status = 'superseded', status_changed_at = now(), status_reason = $2
            WHERE id = $1`,
          [d.supersedes_id, d.change_reason ?? `superseded by version ${version}`],
        );
        await archiveThesisRadars(client, d.supersedes_id, 'thesis superseded');
      } else {
        const { rows: existing } = await client.query(
          `SELECT id FROM theses WHERE user_id = $1 AND security_id = $2 AND status = 'active'`,
          [user.id, d.security_id],
        );
        if (existing.length > 0) {
          await client.query('ROLLBACK');
          return problem(
            reply,
            req,
            409,
            'thesis-exists',
            'An active thesis already exists for this security',
            'Supersede it (supersedes_id) to record what changed — the old version stays visible.',
          );
        }
      }

      const { rows: thesisRows } = await client.query(
        `INSERT INTO theses (user_id, security_id, version, supersedes_id, statement,
                             time_horizon_months, confidence_at_creation)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
        [
          user.id,
          d.security_id,
          version,
          d.supersedes_id ?? null,
          d.statement,
          d.time_horizon_months ?? null,
          d.confidence ?? null,
        ],
      );
      const thesisId = thesisRows[0].id as string;

      // F-14: falsification conditions become radars, silently, in this
      // same transaction. The user is told in the response (§16.4).
      const radars: CreatedRadar[] = [];
      for (const c of d.conditions) {
        const { rows: condRows } = await client.query(
          `INSERT INTO thesis_conditions (thesis_id, condition_ast, condition_nl)
           VALUES ($1,$2,$3) RETURNING id`,
          [thesisId, JSON.stringify(c.condition), c.condition_nl],
        );
        const conditionId = condRows[0].id as string;
        const m = c.condition.metric as { securityId?: string };
        const radar = await createRadar(client, {
          userId: user.id,
          baseCurrency: user.baseCurrency,
          securityId: m.securityId ?? null,
          name: `Thesis condition: ${c.condition_nl.slice(0, 80)}`,
          condition: c.condition,
          conditionNl: c.condition_nl,
          source: 'thesis',
          thesisConditionId: conditionId,
        });
        await client.query(`UPDATE thesis_conditions SET radar_id = $2 WHERE id = $1`, [
          conditionId,
          radar.id,
        ]);
        radars.push(radar);
      }

      await audit(client, user.id, 'thesis.create', 'thesis', thesisId, req.traceId, {
        security_id: d.security_id,
        version,
        conditions: d.conditions.length,
      });
      await client.query('COMMIT');
      return reply.status(201).send({
        data: {
          id: thesisId,
          version,
          created_at: thesisRows[0].created_at,
          radars_created: radars.map((r) => ({
            id: r.id,
            condition_nl: r.conditionNl,
            rendered: r.rendered,
            current: r.current,
          })),
          message:
            radars.length > 0
              ? `Thesis saved. Atlas set up ${radars.length} radar(s) for exactly what you wrote — you don't have to remember.`
              : 'Thesis saved.',
        },
      });
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

  // §31.2: the API refuses to let you edit a belief.
  app.patch('/v1/theses/:id', async (req, reply) => {
    return problem(
      reply,
      req,
      405,
      'thesis-immutable',
      'Theses cannot be edited',
      'What you believed is a historical fact. Create a new version with supersedes_id — both versions stay visible.',
    );
  });

  app.get('/v1/theses/:id/versions', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    // Walk the supersession chain both ways from the given thesis.
    const { rows } = await pool.query(
      `WITH RECURSIVE back AS (
         SELECT t.* FROM theses t WHERE t.id = $1 AND t.user_id = $2
         UNION ALL
         SELECT p.* FROM theses p JOIN back b ON b.supersedes_id = p.id
       ),
       fwd AS (
         SELECT t.* FROM theses t WHERE t.id = $1 AND t.user_id = $2
         UNION ALL
         SELECT n.* FROM theses n JOIN fwd f ON n.supersedes_id = f.id
       )
       SELECT DISTINCT ${THESIS_COLS}
         FROM (SELECT * FROM back UNION SELECT * FROM fwd) t
         JOIN securities s ON s.id = t.security_id
        ORDER BY t.version`,
      [id, user.id],
    );
    if (rows.length === 0) return problem(reply, req, 404, 'not-found', 'Thesis not found');
    return reply.send({ data: rows });
  });

  // Status transition: the user marks a thesis broken or retires it.
  app.post('/v1/theses/:id/status', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) {
      return problem(reply, req, 400, 'validation', "Check the status change", parsed.error.issues[0]?.message);
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE theses SET status = $3, status_changed_at = now(), status_reason = $4
          WHERE id = $1 AND user_id = $2 AND status = 'active'
          RETURNING id, security_id`,
        [id, user.id, parsed.data.status, parsed.data.reason],
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return problem(reply, req, 404, 'not-found', 'Active thesis not found');
      }
      await archiveThesisRadars(client, id, `thesis ${parsed.data.status}`);
      if (parsed.data.status === 'falsified') {
        await recordEvent(client, {
          type: 'thesis.falsified',
          eventId: `thesis-falsified-${id}`,
          occurredAt: new Date().toISOString(),
          thesisId: id,
          conditionId: '',
          userId: user.id,
        });
      }
      await audit(client, user.id, `thesis.${parsed.data.status}`, 'thesis', id, req.traceId, {
        reason: parsed.data.reason,
      });
      await client.query('COMMIT');
      return reply.status(204).send();
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // DELETE = retire with a reason. Nothing is erased (§61.2).
  app.delete('/v1/theses/:id', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const parsed = z
      .object({ reason: z.string().trim().min(1).max(500) })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return problem(reply, req, 400, 'thesis-retire-reason-required', 'Retiring a thesis requires a reason');
    }
    const { id } = req.params as { id: string };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE theses SET status = 'retired', status_changed_at = now(), status_reason = $3
          WHERE id = $1 AND user_id = $2 AND status = 'active' RETURNING id`,
        [id, user.id, parsed.data.reason],
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return problem(reply, req, 404, 'not-found', 'Active thesis not found');
      }
      await archiveThesisRadars(client, id, 'thesis retired');
      await audit(client, user.id, 'thesis.retired', 'thesis', id, req.traceId, { reason: parsed.data.reason });
      await client.query('COMMIT');
      return reply.status(204).send();
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}
