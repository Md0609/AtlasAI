/**
 * Weekly Review surface (F-25, §6.5). The generator worker writes the review;
 * this is the read side — the in-app counterpart to the email.
 *
 * Read receipts mirror briefs (§31.2 PATCH): knowing whether the review is read
 * is a genuine engagement signal, not a badge mechanic (§18.7 forbids those).
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireUser } from './auth.js';
import { problem } from './http.js';

const COLS = `id, week_start::text AS week_start, one_thing, sections, narrated, model,
              generated_at, read_at`;

export function registerWeeklyReviewRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.get('/v1/weekly-reviews', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { rows } = await pool.query(
      `SELECT ${COLS} FROM weekly_reviews WHERE user_id = $1 ORDER BY week_start DESC LIMIT 52`,
      [user.id],
    );
    return reply.send({ data: rows });
  });

  app.get('/v1/weekly-reviews/latest', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { rows } = await pool.query(
      `SELECT ${COLS} FROM weekly_reviews WHERE user_id = $1 ORDER BY week_start DESC LIMIT 1`,
      [user.id],
    );
    // No review yet is a normal state, not an error — the first one lands Sunday.
    return reply.send({ data: rows[0] ?? null });
  });

  app.patch('/v1/weekly-reviews/:id', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const { rows } = await pool.query(
      `UPDATE weekly_reviews SET read_at = COALESCE(read_at, now())
        WHERE id = $1 AND user_id = $2 RETURNING id, read_at`,
      [id, user.id],
    );
    if (rows.length === 0) return problem(reply, req, 404, 'not-found', 'Weekly review not found');
    return reply.send({ data: rows[0] });
  });
}
