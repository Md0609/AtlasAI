/**
 * Today — quiet-day dashboard (§13.3). The counts are real (sourced from events
 * and briefs), the quiet state is a positive assertion, and the receipt of what
 * Atlas reviewed makes the silence credible.
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
import { buildRunner } from '@atlas/workers';

const TEST_URL =
  process.env.ATLAS_TEST_DATABASE_URL ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';

let pool: pg.Pool;
let app: FastifyInstance;
let cookie = '';
let portfolioId = '';
let aaplId = '';

const inject = (opts: { method: 'GET' | 'POST'; url: string; payload?: unknown }) =>
  app.inject({
    method: opts.method,
    url: opts.url,
    payload: opts.payload as never,
    headers: { ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}), cookie },
  });

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);
  await new IngestPipeline(pool, new MockVendorAdapter(), new CollectingEventSink()).run(SNAPSHOT_FROM, SNAPSHOT_TO);
  app = await buildServer(pool);

  const reg = await inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'today@example.es', password: 'password1234', jurisdiction: 'ES', base_currency: 'EUR' },
  });
  cookie = String(reg.headers['set-cookie']).split(';')[0]!;

  const p = await inject({ method: 'POST', url: '/v1/portfolios', payload: { name: 'Main', type: 'taxable', base_currency: 'EUR' } });
  portfolioId = p.json().id;
  await inject({ method: 'POST', url: `/v1/portfolios/${portfolioId}/transactions`, payload: { type: 'deposit', trade_date: '2026-01-05', amount: '100000', currency: 'EUR' } });
  aaplId = (await pool.query(`SELECT security_id FROM listings WHERE ticker='AAPL' AND valid_to IS NULL LIMIT 1`)).rows[0].security_id;
  await inject({ method: 'POST', url: `/v1/portfolios/${portfolioId}/transactions`, payload: { type: 'buy', security_id: aaplId, trade_date: '2026-02-02', quantity: '100', price: '210', currency: 'USD' } });
  await buildRunner(pool).drain();

  // Three security updates Atlas reviewed this week for the held name.
  await pool.query(`SELECT ensure_events_partition(now())`);
  for (let i = 0; i < 3; i++) {
    await pool.query(
      `INSERT INTO events (event_id, type, occurred_at, partition_key, payload)
       VALUES ($1, 'security.changed', now(), $2, '{}'::jsonb)`,
      [`today-sec-${i}`, aaplId],
    );
  }
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('GET /v1/today (quiet day)', () => {
  it('is a positive assertion: nothing needs attention, with a sourced receipt of what was reviewed', async () => {
    const res = await inject({ method: 'GET', url: '/v1/today' });
    expect(res.statusCode).toBe(200);
    const d = res.json().data;

    expect(d.needs_attention).toBe(false); // no unread briefs
    expect(d.reviewed.holdings).toBe(1);
    expect(d.reviewed.updates).toBe(3); // the three security.changed events
    expect(d.reviewed.material).toBe(0); // none produced a brief

    // The receipt — what Atlas looked at — is concrete, per security.
    expect(d.receipt).toHaveLength(1);
    expect(d.receipt[0].name).toMatch(/Apple/);
    expect(d.receipt[0].updates).toBe(3);

    // Silence is intentional: the quiet-day streak normalizes it (§13.4) — but
    // the window can never exceed the age of the account. A brand-new user has
    // no history, so Atlas claims none (it used to assert a fabricated "30 of
    // 30" to an account minutes old).
    expect(d.account_age_days).toBe(0);
    expect(d.quiet_days.of).toBe(0);
    expect(d.quiet_days.quiet).toBe(0);

    // Every number is a count over recorded data (US-AI-02).
    expect(res.json().provenance.methodology).toBe('today.v1');

    // The next Weekly Review is a Sunday.
    expect(new Date(`${d.weekly_review.next}T00:00:00Z`).getUTCDay()).toBe(0);
  });

  it('flips to needs-attention with an open question when a rule breaches', async () => {
    // A rule AAPL blows through immediately (it is ~the whole portfolio).
    await inject({ method: 'POST', url: '/v1/rules', payload: { type: 'max_single_name', params: { limit: '0.05' }, stated_reason: 'No single name over 5%.' } });
    await buildRunner(pool).drain();

    const res = await inject({ method: 'GET', url: '/v1/today' });
    const d = res.json().data;
    expect(d.needs_attention).toBe(true);
    expect(d.attention_count).toBeGreaterThan(0);
    expect(d.reviewed.material).toBeGreaterThan(0); // the breach raised a brief
    expect(d.open_questions.some((q: { kind: string }) => q.kind === 'rule_breach')).toBe(true);
    // Still no fabricated history: the window is bounded by account age.
    expect(d.quiet_days.of).toBe(0);
    expect(d.quiet_days.quiet).toBe(0);
  });
});
