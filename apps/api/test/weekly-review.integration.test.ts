/**
 * Weekly Review (F-25, §6.5) — "the retention engine", and the design
 * constraint that matters: it must be worth reading on a week when nothing
 * happened. Covers the deterministic sections, the week-over-week diff, the
 * restraint section (§18.7 / FR-8.3), idempotency, self-scheduling, and that it
 * does NOT spend the §18.6 notification budget.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { migrate, resetDatabase } from '@atlas/schema';
import {
  CollectingEventSink,
  IngestPipeline,
  MockVendorAdapter,
  SNAPSHOT_FROM,
  SNAPSHOT_TO,
} from '@atlas/ingest';
import { buildServer } from '@atlas/api';
import { enqueue } from '@atlas/bus';
import { buildRunner, deliveryAtForWeek, scheduleWeeklyReviews, weekStartUtc } from '@atlas/workers';

const TEST_URL =
  process.env.ATLAS_TEST_DATABASE_URL ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';

let pool: pg.Pool;
let app: FastifyInstance;
let cookie = '';
let userId = '';
let aaplId = '';

const inject = (opts: { method: 'GET' | 'POST' | 'PATCH'; url: string; payload?: unknown }) =>
  app.inject({
    method: opts.method,
    url: opts.url,
    payload: opts.payload as never,
    headers: { ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}), cookie },
  });

/** Run the review now, regardless of its Sunday schedule. */
const runReview = async (): Promise<void> => {
  await enqueue(pool, 'weekly.review', userId, { userId });
  const { stats } = await buildRunner(pool).drain();
  expect(stats.dead).toBe(0);
};

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);
  await new IngestPipeline(pool, new MockVendorAdapter(), new CollectingEventSink()).run(SNAPSHOT_FROM, SNAPSHOT_TO);
  app = await buildServer(pool);

  const reg = await inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'weekly@example.es', password: 'password1234', jurisdiction: 'ES', base_currency: 'EUR' },
  });
  cookie = String(reg.headers['set-cookie']).split(';')[0]!;
  userId = reg.json().id;
  aaplId = (await pool.query(`SELECT security_id FROM listings WHERE ticker='AAPL' AND valid_to IS NULL LIMIT 1`)).rows[0].security_id;

  const p = await inject({ method: 'POST', url: '/v1/portfolios', payload: { name: 'Main', type: 'taxable', base_currency: 'EUR' } });
  const pid = p.json().id;
  await inject({ method: 'POST', url: `/v1/portfolios/${pid}/transactions`, payload: { type: 'deposit', trade_date: '2026-01-05', amount: '100000', currency: 'EUR' } });
  await inject({ method: 'POST', url: `/v1/portfolios/${pid}/transactions`, payload: { type: 'buy', security_id: aaplId, trade_date: '2026-02-02', quantity: '100', price: '210', currency: 'USD' } });
  await buildRunner(pool).drain();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('the review is worth reading on a quiet week (§6.5)', () => {
  it('generates all five MVP sections with a one-thing, even when nothing happened', async () => {
    await runReview();

    const res = await inject({ method: 'GET', url: '/v1/weekly-reviews/latest' });
    expect(res.statusCode).toBe(200);
    const r = res.json().data;
    expect(r).toBeTruthy();
    expect(r.week_start).toBe(weekStartUtc());

    // §1 the one thing — a single sentence, present on a quiet week too.
    expect(typeof r.one_thing).toBe('string');
    expect(r.one_thing.length).toBeGreaterThan(0);

    const types = r.sections.map((s: { type: string }) => s.type);
    expect(types).toEqual(['what_changed', 'what_didnt_change', 'your_rules', 'open_questions']);

    // §2 first review ⇒ nothing to diff against yet, said plainly.
    const changed = r.sections.find((s: { type: string }) => s.type === 'what_changed');
    expect(changed.lines.join(' ')).toMatch(/first review/i);

    // §3 the restraint section is present and concrete.
    const noise = r.sections.find((s: { type: string }) => s.type === 'what_didnt_change');
    expect(noise.lines.join(' ')).toMatch(/Atlas (reviewed|watched)/);

    // It went to the email channel too.
    const { rows: mail } = await pool.query(`SELECT subject FROM email_outbox WHERE user_id = $1`, [userId]);
    expect(mail.some((m) => m.subject === 'Your week in Atlas')).toBe(true);
  });

  it('does NOT spend the §18.6 notification budget — it is a scheduled digest, not an interruption', async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM notification_budget_ledger WHERE user_id = $1`,
      [userId],
    );
    expect(rows[0].n).toBe(0);
  });

  it('is idempotent: one review per user per week however often the job runs', async () => {
    await runReview();
    await runReview();
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM weekly_reviews WHERE user_id = $1 AND week_start = $2`,
      [userId, weekStartUtc()],
    );
    expect(rows[0].n).toBe(1);
  });

  it('reports breached rules with the reason the user gave, and open questions', async () => {
    // A rule AAPL immediately breaches (it is ~the whole portfolio).
    await inject({
      method: 'POST',
      url: '/v1/rules',
      payload: { type: 'max_single_name', params: { limit: '0.05' }, stated_reason: 'No single name over 5%.' },
    });
    await buildRunner(pool).drain();

    // Regenerate for a fresh week by clearing this week's row.
    await pool.query(`DELETE FROM weekly_reviews WHERE user_id = $1`, [userId]);
    await runReview();

    const r = (await inject({ method: 'GET', url: '/v1/weekly-reviews/latest' })).json().data;
    const rules = r.sections.find((s: { type: string }) => s.type === 'your_rules');
    expect(rules.lines.join(' ')).toContain('No single name over 5%.'); // quoted back (§14.6)
    expect(r.one_thing).toMatch(/max_single_name|outside the limit/i);
  });

  it('diffs against last week once there is a previous snapshot (§6.5 §2)', async () => {
    // Age the existing review into last week so the next one has a baseline.
    const lastWeek = new Date(Date.parse(`${weekStartUtc()}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
    await pool.query(`UPDATE weekly_reviews SET week_start = $2 WHERE user_id = $1`, [userId, lastWeek]);
    await runReview();

    const r = (await inject({ method: 'GET', url: '/v1/weekly-reviews/latest' })).json().data;
    expect(r.week_start).toBe(weekStartUtc());
    const changed = r.sections.find((s: { type: string }) => s.type === 'what_changed');
    // No longer the "first review" line — it compared against the stored snapshot.
    expect(changed.lines.join(' ')).not.toMatch(/first review/i);
  });

  it('marks a review read', async () => {
    const latest = (await inject({ method: 'GET', url: '/v1/weekly-reviews/latest' })).json().data;
    const res = await inject({ method: 'PATCH', url: `/v1/weekly-reviews/${latest.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.read_at).not.toBeNull();
  });
});

describe('scheduling (§25.1 weekly_review_generator — a due-based cron tick)', () => {
  it('staggers users across a 6-hour window on the Sunday that closes the week', () => {
    const week = weekStartUtc();
    const a = deliveryAtForWeek('11111111-1111-1111-1111-111111111111', week);
    const b = deliveryAtForWeek('22222222-2222-2222-2222-222222222222', week);
    for (const d of [a, b]) {
      expect(d.getUTCDay()).toBe(0); // Sunday
      expect(d.getUTCHours()).toBeGreaterThanOrEqual(6);
      expect(d.getUTCHours()).toBeLessThan(12);
    }
    expect(a.getTime()).not.toBe(b.getTime());
  });

  it('does not enqueue before the user\'s slot, and never parks a future job on their partition', async () => {
    await pool.query(`DELETE FROM job_queue WHERE topic = 'weekly.review'`);
    await pool.query(`DELETE FROM weekly_reviews WHERE user_id = $1`, [userId]);
    // Monday of this week: nobody's Sunday slot has arrived.
    const monday = new Date(Date.parse(`${weekStartUtc()}T00:00:00Z`));
    expect(await scheduleWeeklyReviews(pool, monday)).toBe(0);

    // Critically: no pending job is parked on the user's partition, which would
    // head-of-line block their recomputes and briefs (§24.4).
    const parked = await pool.query(
      `SELECT count(*)::int AS n FROM job_queue
        WHERE topic = 'weekly.review' AND partition_key = $1 AND status = 'pending'`,
      [userId],
    );
    expect(parked.rows[0].n).toBe(0);
  });

  it('enqueues an immediately-runnable job once the slot has passed, and is idempotent', async () => {
    const after = new Date(deliveryAtForWeek(userId, weekStartUtc()).getTime() + 60_000);
    expect(await scheduleWeeklyReviews(pool, after)).toBeGreaterThan(0);

    const { rows } = await pool.query(
      `SELECT run_after FROM job_queue WHERE topic = 'weekly.review' AND partition_key = $1 AND status = 'pending'`,
      [userId],
    );
    expect(rows.length).toBe(1);
    expect(new Date(rows[0].run_after).getTime()).toBeLessThanOrEqual(Date.now()); // runnable now

    // A second sweep does not double-queue.
    expect(await scheduleWeeklyReviews(pool, after)).toBe(0);

    // And once generated, the sweep stops re-queuing it.
    await buildRunner(pool).drain();
    expect(await scheduleWeeklyReviews(pool, after)).toBe(0);
  });
});
