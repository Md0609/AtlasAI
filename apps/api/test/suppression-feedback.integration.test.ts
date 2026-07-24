/**
 * Suppression transparency retrain (Phase 5, F-23 / US-NOT-02): "actually, tell
 * me about these next time" raises the user's weekly notification budget so what
 * the Relevance Ranker suppressed gets through next time, and the signal is
 * logged (§28.3).
 *
 * This test used to drive the whole loop with C2 briefs pushed over the weekly
 * budget. Per §18.4 that can no longer happen — C0/C1/C2 are budget-exempt —
 * and the only budgeted classes (C3–C6) are not yet storable: migration 009
 * constrains `class` to C0/C1/C2 with the note "C3+ arrive with the
 * intelligence plane".
 *
 * So the retrain loop is exercised where it is actually reachable: a seeded
 * weekly-budget suppression (the row the dispatcher writes for a budgeted
 * class), the real feedback endpoint, and the real budget resolver — rather
 * than a C2 the PRD says must always be delivered.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { migrate, resetDatabase } from '@atlas/schema';
import { buildServer } from '@atlas/api';
import { enqueue } from '@atlas/bus';
import { buildRunner, effectiveWeeklyBudget, personaForUser } from '@atlas/workers';

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

  // The suppression the dispatcher writes when a BUDGETED brief runs out of
  // weekly allowance — seeded directly, because no budgeted class is storable
  // yet (see the file header). The reason string is the dispatcher's own.
  const bid = await mkBrief(await mkSecurity('OverBudgetCo'));
  await pool.query(
    `INSERT INTO suppressions (user_id, brief_id, class, reason)
     VALUES ($1,$2,'C2',$3)`,
    [
      userId,
      bid,
      "weekly budget: persona 'unknown' allows 3 budgeted notifications/week (§18.3)",
    ],
  );
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('suppression transparency + retrain (US-NOT-02)', () => {
  it('"tell me next time" raises the weekly budget and logs the signal', async () => {
    // No profile ⇒ 'unknown' persona ⇒ base weekly budget of 3 (§18.6).
    const persona = await personaForUser(pool, userId);
    expect(await effectiveWeeklyBudget(pool, userId, persona)).toBe(3);

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

    // …and the delta is actually applied to the budget the dispatcher reads.
    expect(await effectiveWeeklyBudget(pool, userId, persona)).toBe(4);
  });

  it('a C2 radar fire is delivered regardless of the week (§18.4)', async () => {
    // The user armed this radar. The budget above has nothing to say about it —
    // this is the guarantee the old version of this test contradicted.
    const armed = await mkBrief(await mkSecurity('ArmedCo'));
    await dispatch(armed);
    expect(await deliveredCount(armed)).toBe(2); // in_app + email
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
