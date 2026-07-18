/**
 * radar.evaluate {userId} — the deterministic firing decision (§16.1).
 *
 *  - Edge-triggered: a radar fires on the false→true transition of its
 *    condition, never on every evaluation while true.
 *  - A fire records provenance (observed value, target, engine inputs),
 *    records the radar.fired event (+ thesis.falsified for thesis radars),
 *    and enqueues brief generation.
 *  - Thesis radars archive themselves after firing — the promise was "tell
 *    me the moment it happens", and it happened. The thesis STATUS stays
 *    untouched: that decision belongs to the user (P1).
 *  - Manual radars auto-suppress after >3 fires in 30 days (§16.5, FR-7.6).
 */
import type pg from 'pg';
import { enqueue, recordEvent, type Job } from '@atlas/bus';
import type { RadarCondition } from '@atlas/contracts';
import { evaluateRadarCondition } from '@atlas/signal-engine';
import { conditionSecurityIds, loadRadarContext } from '@atlas/api/internal';

const AUTO_SUPPRESS_FIRES = 3;
const AUTO_SUPPRESS_WINDOW_DAYS = 30;

export async function handleRadarEvaluate(pool: pg.Pool, job: Job): Promise<void> {
  const userId = String(job.payload.userId ?? '');
  if (!userId) throw new Error('radar.evaluate without userId');

  const { rows: userRows } = await pool.query(
    `SELECT base_currency FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  if (userRows.length === 0) return;

  const { rows: radars } = await pool.query(
    `SELECT id, security_id, condition_ast, condition_nl, source, thesis_condition_id, last_met
       FROM radars
      WHERE user_id = $1 AND status = 'active'
        AND (snoozed_until IS NULL OR snoozed_until <= now()::date)
      ORDER BY created_at`,
    [userId],
  );
  if (radars.length === 0) return;

  const ctx = await loadRadarContext(
    pool,
    userId,
    userRows[0].base_currency,
    conditionSecurityIds(radars.map((r) => r.condition_ast as { metric: { kind: string; securityId?: string } })),
  );

  for (const radar of radars) {
    const evaluation = evaluateRadarCondition(radar.condition_ast as RadarCondition, ctx);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE radars SET last_observed = $2, last_evaluated_at = now(),
                last_met = COALESCE($3, last_met)
          WHERE id = $1`,
        [radar.id, JSON.stringify(evaluation), evaluation.met],
      );

      const fired = evaluation.met === true && radar.last_met === false;
      if (fired) {
        const firedAt = new Date().toISOString();
        const { rows: fireRows } = await client.query(
          `INSERT INTO radar_fires (radar_id, user_id, observed)
           VALUES ($1,$2,$3) RETURNING id::text`,
          [radar.id, userId, JSON.stringify(evaluation)],
        );
        const eventId = `radar-fired-${radar.id}-${fireRows[0].id}`;
        await client.query(`UPDATE radar_fires SET event_id = $2 WHERE id = $1::bigint`, [
          fireRows[0].id,
          eventId,
        ]);
        await recordEvent(client, {
          type: 'radar.fired',
          eventId,
          occurredAt: firedAt,
          radarId: radar.id,
          userId,
        });

        if (radar.source === 'thesis' && radar.thesis_condition_id) {
          const { rows: condRows } = await client.query(
            `UPDATE thesis_conditions SET status = 'met', met_at = now()
              WHERE id = $1 AND status = 'watching' RETURNING thesis_id`,
            [radar.thesis_condition_id],
          );
          // The radar's job is done; it archives itself (§16.4: "the moment
          // it happens"). The thesis status decision belongs to the user.
          await client.query(
            `UPDATE radars SET status = 'archived', archived_at = now(),
                    paused_reason = 'condition met — job done'
              WHERE id = $1`,
            [radar.id],
          );
          if (condRows.length > 0) {
            await recordEvent(client, {
              type: 'thesis.falsified',
              eventId: `thesis-cond-met-${radar.thesis_condition_id}`,
              occurredAt: firedAt,
              thesisId: condRows[0].thesis_id,
              conditionId: radar.thesis_condition_id,
              userId,
            });
          }
        } else {
          // FR-7.6: auto-suppression, with a prompt to refine (via the UI).
          const { rows: countRows } = await client.query(
            `SELECT count(*)::int AS n FROM radar_fires
              WHERE radar_id = $1 AND fired_at > now() - ($2 || ' days')::interval`,
            [radar.id, String(AUTO_SUPPRESS_WINDOW_DAYS)],
          );
          if (countRows[0].n > AUTO_SUPPRESS_FIRES) {
            await client.query(
              `UPDATE radars SET status = 'paused',
                      paused_reason = 'auto-suppressed: fired more than ${AUTO_SUPPRESS_FIRES} times in ${AUTO_SUPPRESS_WINDOW_DAYS} days — refine the condition'
                WHERE id = $1`,
              [radar.id],
            );
          }
        }

        await enqueue(client, 'brief.generate', userId, { fireId: fireRows[0].id, userId });
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
