/**
 * Suppression transparency retrain (Phase 5, F-23 / US-NOT-02): "actually, tell
 * me about these next time" raises the user's weekly notification budget so what
 * the Relevance Ranker suppressed gets through next time, and the signal is
 * logged (§28.3). Proven end-to-end through the real dispatcher.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { migrate, resetDatabase } from '@atlas/schema';
import { buildServer } from '@atlas/api';
import { enqueue } from '@atlas/bus';
import { buildRunner } from '@atlas/workers';

const TEST_URL =
  process.env.ATLAS_TEST_DATABASE_URL ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';

let pool: pg.Pool;
let app: FastifyInstance;
let cookie = '';
let userId = '';

const inject = (opts: { method: 'GET' | 'POST'; url: string; payload?: unknown }) =>
  app.inject({
    method: opts.method,
    url: opts.url,
    payload: opts.payload as never,
    headers: { ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}), cookie },
  });

/** Distinct subjects avoid the §24.3 semantic dedup (class+subject+day). */
const mkSecurity = async (name: string): Promise<string> =>
  (await pool.query(`INSERT INTO securities (name, type, is_fund, currency) VALUES ($1,'equity',false,'USD') RETURNING id`, [name])).rows[0].id as string;

const mkBrief = async (securityId?: string): Promise<string> => {
  const { rows } = await pool.query(
    `INSERT INTO briefs (user_id, class, headline, body, security_id) VALUES ($1,'C2','h','b',$2) RETURNING id`,
    [userId, securityId ?? null],
  );
  return rows[0].id as string;
};

const dispatch = async (briefId: string): Promise<void> => {
  await enqueue(pool, 'notify.dispatch', userId, { briefId, userId });
  await buildRunner(pool).drain();
};

const deliveredCount = async (briefId: string): Promise<number> =>
  Number((await pool.query(`SELECT count(*)::int n FROM notifications WHERE brief_id=$1`, [briefId])).rows[0].n);

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);
  app = await buildServer(pool);
  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'noise@example.es', password: 'password1234', jurisdiction: 'ES', base_currency: 'EUR' },
    headers: { 'content-type': 'application/json' },
  });
  cookie = String(reg.headers['set-cookie']).split(';')[0]!;
  userId = reg.json().id;

  // No profile ⇒ 'unknown' persona ⇒ weekly budget 5. Fill this week so the
  // next non-C0 brief is over budget (dates in UTC, matching the dispatcher).
  const dayUtc = new Date().toISOString().slice(0, 10);
  const prevDayUtc = new Date(Date.parse(`${dayUtc}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  await pool.query(`ALTER TABLE notification_budget_ledger DISABLE TRIGGER notification_budget_trg`);
  try {
    for (let i = 0; i < 5; i++) {
      const bid = await mkBrief();
      await pool.query(
        `INSERT INTO notification_budget_ledger (user_id, brief_id, class, day_bucket, week_bucket)
         VALUES ($1,$2,'C2',$3::date, date_trunc('week',$4::date)::date)`,
        [userId, bid, prevDayUtc, dayUtc],
      );
    }
  } finally {
    await pool.query(`ALTER TABLE notification_budget_ledger ENABLE TRIGGER notification_budget_trg`);
  }
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('suppression transparency + retrain (US-NOT-02)', () => {
  it('suppresses over budget, then "tell me next time" lets the next one through', async () => {
    // 6th interruption this week ⇒ suppressed by the weekly budget (5).
    const sixth = await mkBrief(await mkSecurity('SixCo'));
    await dispatch(sixth);
    expect(await deliveredCount(sixth)).toBe(0);

    // The suppression is a first-class, visible resource with a reason.
    const list = await inject({ method: 'GET', url: '/v1/suppressions' });
    const sup = list.json().data.find((s: { reason: string }) => s.reason.includes('weekly budget'));
    expect(sup).toBeTruthy();

    // One click: tell me about these next time → budget delta rises.
    const fb = await inject({ method: 'POST', url: `/v1/suppressions/${sup.id}/feedback`, payload: { signal: 'tell_me_next_time' } });
    expect(fb.statusCode).toBe(200);
    expect(fb.json().data.weekly_budget_delta).toBe(1);

    // The feedback is logged (§28.3).
    const fbCount = await pool.query(`SELECT count(*)::int n FROM notification_feedback WHERE user_id=$1`, [userId]);
    expect(fbCount.rows[0].n).toBe(1);

    // Now the budget is 6, only 5 delivered this week ⇒ the next one gets through.
    const seventh = await mkBrief(await mkSecurity('SevenCo'));
    await dispatch(seventh);
    expect(await deliveredCount(seventh)).toBe(2); // in_app + email
  });

  it('404s feedback on a suppression the user does not own', async () => {
    const res = await inject({
      method: 'POST',
      url: `/v1/suppressions/00000000-0000-0000-0000-000000000000/feedback`,
      payload: { signal: 'tell_me_next_time' },
    });
    expect(res.statusCode).toBe(404);
  });
});
