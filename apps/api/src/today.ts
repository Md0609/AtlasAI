/**
 * Today — the quiet-day dashboard (§13.3, F-25 adjacent).
 *
 * "This screen is the product." On a quiet day it must read as a *positive
 * assertion of work done*, not an empty page. Three trust elements, every
 * number sourced from real events (US-AI-02 — no fabricated counts):
 *
 *   1. whether anything actually needs attention (unread briefs);
 *   2. what Atlas reviewed — the count of security updates it processed across
 *      the user's holdings, and how many changed something material (a brief);
 *   3. that the silence is deliberate — the receipt of what was looked at, plus
 *      the quiet-day streak that normalizes inaction (§13.4).
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireUser } from './auth.js';

const REVIEW_WINDOW_DAYS = 7;
const STREAK_WINDOW_DAYS = 30;

/** The next Sunday (UTC) — when the Weekly Review lands (§6.5). */
function nextSunday(from = new Date()): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const daysUntilSunday = (7 - d.getUTCDay()) % 7 || 7; // always the upcoming Sunday
  d.setUTCDate(d.getUTCDate() + daysUntilSunday);
  return d.toISOString().slice(0, 10);
}

export function registerTodayRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.get('/v1/today', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;

    // Held securities — the surface Atlas watches for this user.
    const held = await pool.query(
      `SELECT DISTINCT po.security_id AS id
         FROM positions po JOIN portfolios pf ON pf.id = po.portfolio_id
        WHERE pf.user_id = $1 AND pf.deleted_at IS NULL
          AND po.security_id IS NOT NULL AND po.quantity <> 0`,
      [user.id],
    );
    const securityIds = held.rows.map((r) => r.id as string);

    // What Atlas reviewed: security-update events touching those holdings in the
    // window, per security (the receipt), and the total.
    const reviewedRows = securityIds.length
      ? (
          await pool.query(
            `SELECT e.partition_key AS security_id, s.name, count(*)::int AS updates
               FROM events e JOIN securities s ON s.id = e.partition_key::uuid
              WHERE e.type = 'security.changed'
                AND e.partition_key = ANY($1)
                AND e.recorded_at >= now() - ($2 || ' days')::interval
              GROUP BY e.partition_key, s.name
              ORDER BY updates DESC`,
            [securityIds, String(REVIEW_WINDOW_DAYS)],
          )
        ).rows
      : [];
    const updates = reviewedRows.reduce((n, r) => n + Number(r.updates), 0);

    // What changed something material to the user: briefs raised in the window.
    const material = Number(
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM briefs
            WHERE user_id = $1 AND created_at >= now() - ($2 || ' days')::interval`,
          [user.id, String(REVIEW_WINDOW_DAYS)],
        )
      ).rows[0].n,
    );

    // Does anything need attention right now? Unread briefs.
    const unread = Number(
      (await pool.query(`SELECT count(*)::int AS n FROM briefs WHERE user_id = $1 AND read_at IS NULL`, [user.id]))
        .rows[0].n,
    );

    // The quiet-day streak (§13.4 — "23 quiet days out of your last 30").
    const daysWithBriefs = Number(
      (
        await pool.query(
          `SELECT count(DISTINCT created_at::date)::int AS n FROM briefs
            WHERE user_id = $1 AND created_at >= now() - ($2 || ' days')::interval`,
          [user.id, String(STREAK_WINDOW_DAYS)],
        )
      ).rows[0].n,
    );

    // Open questions: met falsification conditions and rules currently in breach.
    const metConditions = (
      await pool.query(
        `SELECT tc.condition_nl AS text, s.name AS security
           FROM thesis_conditions tc
           JOIN theses t ON t.id = tc.thesis_id
           LEFT JOIN securities s ON s.id = t.security_id
          WHERE t.user_id = $1 AND t.status = 'active' AND tc.status = 'met'`,
        [user.id],
      )
    ).rows;
    const breachedRules = (
      await pool.query(
        `SELECT r.rule_type AS text,
                (SELECT e.observed FROM rule_evaluations e WHERE e.rule_id = r.id
                  ORDER BY e.evaluated_at DESC LIMIT 1) AS observed
           FROM rules r
          WHERE r.user_id = $1 AND r.removed_at IS NULL
            AND (SELECT e.status FROM rule_evaluations e WHERE e.rule_id = r.id
                  ORDER BY e.evaluated_at DESC LIMIT 1) = 'breach'`,
        [user.id],
      )
    ).rows;
    const openQuestions = [
      ...metConditions.map((r) => ({ kind: 'thesis_condition', text: r.text, security: r.security })),
      ...breachedRules.map((r) => ({ kind: 'rule_breach', text: r.text, observed: r.observed })),
    ];

    return reply.send({
      data: {
        needs_attention: unread > 0,
        attention_count: unread,
        reviewed: {
          holdings: securityIds.length,
          updates,
          material,
          window_days: REVIEW_WINDOW_DAYS,
        },
        // The receipt — "show me what you looked at".
        receipt: reviewedRows.map((r) => ({ security_id: r.security_id, name: r.name, updates: Number(r.updates) })),
        quiet_days: { quiet: STREAK_WINDOW_DAYS - daysWithBriefs, of: STREAK_WINDOW_DAYS },
        open_questions: openQuestions,
        weekly_review: { next: nextSunday() },
      },
      provenance: {
        methodology: 'today.v1',
        // Every count above is a COUNT over recorded events / briefs — nothing
        // is generated or estimated (US-AI-02).
        source: 'events + briefs',
        generated_at: new Date().toISOString(),
      },
    });
  });
}
