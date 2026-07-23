/**
 * Briefs inbox, suppressions, and decision recording (Phase 3).
 *
 *  - /v1/suppressions is a public endpoint (§31.2): what Atlas chose NOT to
 *    tell you is a first-class resource.
 *  - Decisions are append-only; the reason is mandatory — a decision without
 *    reasoning is exactly the amnesia the product exists to prevent (P-03).
 *  - Recording "no change" is a decision (§6.3: inaction is a choice).
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { audit, requireUser } from './auth.js';
import { problem } from './http.js';

const decisionSchema = z.object({
  action: z.enum(['buy', 'sell', 'hold', 'update_thesis', 'mark_thesis_broken', 'no_change', 'snooze', 'other']),
  security_id: z.string().uuid().optional(),
  thesis_id: z.string().uuid().optional(),
  brief_id: z.string().uuid().optional(),
  quantity: z.string().regex(/^-?\d+(\.\d+)?$/).optional(),
  price: z.string().regex(/^-?\d+(\.\d+)?$/).optional(),
  currency: z.string().length(3).optional(),
  reason: z.string().trim().min(1, 'a decision needs a reason — your future self will read it').max(2000),
  // FR-11.6: a conclusion the user chose to keep from a Copilot exchange. The
  // thread makes the entry attributable in the Journal (§30.2 episodic).
  source: z.enum(['user', 'copilot']).default('user'),
  source_thread_id: z.string().uuid().optional(),
});

export function registerBriefRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.get('/v1/briefs', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { rows } = await pool.query(
      `SELECT b.id, b.class, b.headline, b.body, b.tone, b.values_json, b.security_id,
              s.name AS security_name, b.rule_id, b.radar_fire_id::text, b.created_at, b.read_at,
              tc.thesis_id
         FROM briefs b
         LEFT JOIN securities s ON s.id = b.security_id
         LEFT JOIN radar_fires f ON f.id = b.radar_fire_id
         LEFT JOIN radars r ON r.id = f.radar_id
         LEFT JOIN thesis_conditions tc ON tc.id = r.thesis_condition_id
        WHERE b.user_id = $1
        ORDER BY b.created_at DESC LIMIT 100`,
      [user.id],
    );
    return reply.send({ data: rows });
  });

  // PATCH = read receipt / feedback (§31.2).
  app.patch('/v1/briefs/:id', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const { rows } = await pool.query(
      `UPDATE briefs SET read_at = COALESCE(read_at, now())
        WHERE id = $1 AND user_id = $2 RETURNING id, read_at`,
      [id, user.id],
    );
    if (rows.length === 0) return problem(reply, req, 404, 'not-found', 'Brief not found');
    return reply.send({ data: rows[0] });
  });

  // §31.2: "what Atlas chose not to tell you is a first-class resource."
  app.get('/v1/suppressions', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { rows } = await pool.query(
      `SELECT sup.id, sup.class, sup.reason, sup.created_at, b.headline
         FROM suppressions sup LEFT JOIN briefs b ON b.id = sup.brief_id
        WHERE sup.user_id = $1 ORDER BY sup.created_at DESC LIMIT 100`,
      [user.id],
    );
    return reply.send({ data: rows });
  });

  // US-NOT-02: "actually, tell me about these next time" — one click that
  // retrains the threshold. The retrain raises the user's weekly notification
  // budget (§18.3) so more of what the Ranker suppressed gets through, and logs
  // the signal (§28.3). 'stop_telling_me' is the opposite nudge.
  const feedbackSchema = z.object({ signal: z.enum(['tell_me_next_time', 'stop_telling_me']) });
  const MAX_DELTA = 5;
  const MIN_DELTA = -5;
  app.post('/v1/suppressions/:id/feedback', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const parsed = feedbackSchema.safeParse(req.body);
    if (!parsed.success) return problem(reply, req, 400, 'validation', 'signal is required');

    const sup = await pool.query(`SELECT id FROM suppressions WHERE id = $1 AND user_id = $2`, [id, user.id]);
    if (sup.rows.length === 0) return problem(reply, req, 404, 'not-found', 'Suppression not found');

    const step = parsed.data.signal === 'tell_me_next_time' ? 1 : -1;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO notification_feedback (user_id, suppression_id, signal) VALUES ($1, $2, $3)`,
        [user.id, id, parsed.data.signal],
      );
      const { rows } = await client.query(
        `INSERT INTO user_notification_prefs (user_id, weekly_budget_delta)
         VALUES ($1, LEAST($3::int, GREATEST($2::int, $4::int)))
         ON CONFLICT (user_id) DO UPDATE
           SET weekly_budget_delta = LEAST($3::int, GREATEST($2::int, user_notification_prefs.weekly_budget_delta + $4::int)),
               updated_at = now()
         RETURNING weekly_budget_delta`,
        [user.id, MIN_DELTA, MAX_DELTA, step],
      );
      await client.query('COMMIT');
      return reply.send({ data: { weekly_budget_delta: rows[0].weekly_budget_delta } });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  app.get('/v1/decisions', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { rows } = await pool.query(
      `SELECT d.id, d.action, d.security_id, s.name AS security_name, d.thesis_id, d.brief_id,
              d.quantity::text, d.price::text, d.currency, d.reason_free_text, d.decided_at
         FROM decisions d LEFT JOIN securities s ON s.id = d.security_id
        WHERE d.user_id = $1 ORDER BY d.decided_at DESC LIMIT 200`,
      [user.id],
    );
    return reply.send({ data: rows });
  });

  app.post('/v1/decisions', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) {
      return problem(reply, req, 400, 'validation', 'Invalid decision payload', parsed.error.issues[0]?.message);
    }
    const d = parsed.data;
    if (d.price !== undefined && d.currency === undefined) {
      return problem(reply, req, 400, 'validation', 'price requires currency (no implicit currency)');
    }
    if (d.thesis_id) {
      const t = await pool.query(`SELECT 1 FROM theses WHERE id = $1 AND user_id = $2`, [d.thesis_id, user.id]);
      if (t.rows.length === 0) return problem(reply, req, 404, 'not-found', 'Thesis not found');
    }
    if (d.brief_id) {
      const b = await pool.query(`SELECT 1 FROM briefs WHERE id = $1 AND user_id = $2`, [d.brief_id, user.id]);
      if (b.rows.length === 0) return problem(reply, req, 404, 'not-found', 'Brief not found');
    }
    // Copilot attribution must reference the user's OWN thread — an entry can't
    // claim to come from a conversation that isn't yours.
    if (d.source_thread_id) {
      const t = await pool.query(`SELECT 1 FROM copilot_threads WHERE id = $1 AND user_id = $2`, [d.source_thread_id, user.id]);
      if (t.rows.length === 0) return problem(reply, req, 404, 'not-found', 'Copilot thread not found');
    }
    if (d.source === 'copilot' && !d.source_thread_id) {
      return problem(reply, req, 400, 'validation', 'a copilot-sourced decision must reference its source_thread_id');
    }
    const { rows } = await pool.query(
      `INSERT INTO decisions (user_id, security_id, thesis_id, brief_id, action,
                              quantity, price, currency, reason_free_text, source, source_thread_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, action, decided_at, source`,
      [
        user.id,
        d.security_id ?? null,
        d.thesis_id ?? null,
        d.brief_id ?? null,
        d.action,
        d.quantity ?? null,
        d.price ?? null,
        d.currency?.toUpperCase() ?? null,
        d.reason,
        d.source,
        d.source_thread_id ?? null,
      ],
    );
    await audit(pool, user.id, 'decision.record', 'decision', rows[0].id, req.traceId, { action: d.action, source: d.source });
    return reply.status(201).send({ data: rows[0] });
  });
}
