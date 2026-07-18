/**
 * Phase 3 worker handlers — the deterministic loop (§24.2):
 *
 *   security.changed  → which users hold it? → user.recompute per user
 *   user.recompute    → consolidated signals + rules re-evaluated
 *                       → signal.recomputed event recorded
 *
 * Radar evaluation and brief generation attach to this chain in their own
 * modules; every handler is idempotent and safe to replay (D-010).
 */
import type pg from 'pg';
import { enqueue, recordEvent, type Job } from '@atlas/bus';
import { computePortfolioSignals } from '@atlas/signal-engine';
import { evaluateAndPersistUserRules, loadConsolidatedInputs } from '@atlas/api/internal';

/**
 * security.changed {securityId}: fan out to every user exposed to it —
 * directly or through a fund that holds it (look-through, depth ≤ 3 via a
 * recursive CTE; §30.1).
 */
export async function handleSecurityChanged(pool: pg.Pool, job: Job): Promise<void> {
  const securityId = String(job.payload.securityId ?? '');
  if (!securityId) throw new Error('security.changed without securityId');

  const { rows } = await pool.query(
    `WITH RECURSIVE exposed AS (
       SELECT $1::uuid AS security_id
       UNION
       SELECT fh.fund_security_id FROM fund_holdings fh
         JOIN exposed e ON e.security_id = fh.holding_security_id
     )
     SELECT DISTINCT p.user_id
       FROM positions pos
       JOIN portfolios p ON p.id = pos.portfolio_id AND p.deleted_at IS NULL
      WHERE pos.security_id IN (SELECT security_id FROM exposed)`,
    [securityId],
  );
  for (const r of rows) {
    await enqueue(pool, 'user.recompute', r.user_id, { userId: r.user_id });
  }
}

/**
 * user.recompute {userId}: recompute the consolidated view, persist rule
 * evaluations (same discipline as the in-transaction path), and record the
 * signal.recomputed event that downstream consumers (radars) key on.
 */
export async function handleUserRecompute(pool: pg.Pool, job: Job): Promise<void> {
  const userId = String(job.payload.userId ?? '');
  if (!userId) throw new Error('user.recompute without userId');

  const { rows } = await pool.query(
    `SELECT base_currency FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  if (rows.length === 0) return; // user gone; nothing to do

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inputs = await loadConsolidatedInputs(client, userId, rows[0].base_currency);
    const signals = computePortfolioSignals(inputs, new Date().toISOString());
    await evaluateAndPersistUserRules(client, userId, rows[0].base_currency);
    await recordEvent(client, signals.event);
    await enqueue(client, 'radar.evaluate', userId, { userId });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
