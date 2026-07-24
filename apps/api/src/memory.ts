/**
 * Memory a user can see, edit and delete (§30.6).
 *
 * "An AI with an invisible model of you is creepy; an AI with a visible,
 * editable model of you is a tool. The same data, the same inferences, opposite
 * emotional valence." So every remembered item is listable with its source and
 * date, and individually deletable — which is also GDPR rectification/erasure
 * (FR-10.5) and a free correction mechanism.
 *
 * Strictly tenant-scoped (FR-10.6): every query filters on the session user.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireUser } from './auth.js';
import { problem } from './http.js';

export function registerMemoryRoutes(app: FastifyInstance, pool: pg.Pool): void {
  // Settings → "What Atlas knows about you", grouped by kind with provenance.
  app.get('/v1/memory', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { rows } = await pool.query(
      `SELECT m.id, m.kind, m.content, m.source, m.source_ref, m.security_id,
              s.name AS security_name, m.occurred_at
         FROM memory_items m LEFT JOIN securities s ON s.id = m.security_id
        WHERE m.user_id = $1
        ORDER BY m.occurred_at DESC
        LIMIT 500`,
      [user.id],
    );
    return reply.send({ data: rows });
  });

  // Individually deletable (§30.6). The embedding and any links cascade.
  app.delete('/v1/memory/:id', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const { rowCount } = await pool.query(`DELETE FROM memory_items WHERE id = $1 AND user_id = $2`, [
      id,
      user.id,
    ]);
    if (!rowCount) return problem(reply, req, 404, 'not-found', 'Memory item not found');
    return reply.status(204).send();
  });
}
