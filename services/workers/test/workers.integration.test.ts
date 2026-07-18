/**
 * Event bus + workers (Phase 3): routing, per-partition ordering, retry with
 * backoff → dead letter, and the ingest → security.changed → user.recompute →
 * signal.recomputed chain over a real Postgres.
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
import { enqueue, queueStats, routeEvents } from '@atlas/bus';
import { WorkerRunner } from '../src/runner.js';
import { buildRunner } from '../src/index.js';

const TEST_URL =
  process.env.ATLAS_TEST_DATABASE_URL ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';

let pool: pg.Pool;
let app: FastifyInstance;
let cookie = '';
let events: CollectingEventSink;

const inject = (opts: { method: 'GET' | 'POST'; url: string; payload?: unknown }) =>
  app.inject({
    method: opts.method,
    url: opts.url,
    payload: opts.payload as never,
    headers: {
      ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
  });

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);
  events = new CollectingEventSink();
  const pipeline = new IngestPipeline(pool, new MockVendorAdapter(), events);
  await pipeline.run(SNAPSHOT_FROM, SNAPSHOT_TO);
  app = await buildServer(pool);

  const reg = await inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'loop@example.es', password: 'password1234', jurisdiction: 'ES', base_currency: 'EUR' },
  });
  const setCookie = reg.headers['set-cookie'];
  cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!;

  const p = await inject({
    method: 'POST',
    url: '/v1/portfolios',
    payload: { name: 'Main', type: 'taxable', base_currency: 'EUR' },
  });
  const pid = p.json().id;
  await inject({
    method: 'POST',
    url: `/v1/portfolios/${pid}/transactions`,
    payload: { type: 'deposit', trade_date: '2026-01-05', amount: '100000', currency: 'EUR' },
  });
  const { rows } = await pool.query(
    `SELECT security_id FROM listings WHERE ticker = 'FOF' AND valid_to IS NULL LIMIT 1`,
  );
  // Hold the fund-of-funds: exposure to constituents arrives only through
  // recursive look-through, which the fan-out must traverse.
  await inject({
    method: 'POST',
    url: `/v1/portfolios/${pid}/transactions`,
    payload: { type: 'buy', security_id: rows[0].security_id, trade_date: '2026-02-02', quantity: '1000', price: '31', currency: 'EUR' },
  });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('event routing (§24.2)', () => {
  it('records every event append-only and collapses bars to one job per security', async () => {
    const { jobsEnqueued } = await routeEvents(pool, events.events);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM events`);
    expect(rows[0].n).toBe(events.events.length);
    const distinctSecurities = new Set(
      events.events.map((e) => ('securityId' in e ? e.securityId : (e as { fundSecurityId?: string }).fundSecurityId)),
    );
    expect(jobsEnqueued).toBe(distinctSecurities.size);

    await expect(pool.query(`DELETE FROM events`)).rejects.toThrow(/append-only/);
  });
});

describe('worker chain: security.changed → user.recompute → signal.recomputed', () => {
  it('drains the queue and records a consolidated signal.recomputed for the exposed user', async () => {
    const runner = buildRunner(pool);
    const { processed, stats } = await runner.drain();
    expect(processed).toBeGreaterThan(0);
    expect(stats.pending).toBe(0);
    expect(stats.dead).toBe(0);

    // The user holds only FOF (a fund of funds); the fan-out must still reach
    // them via recursive look-through when e.g. AAPL (held via IWDA via FOF)
    // changes.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM events WHERE type = 'signal.recomputed'`,
    );
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it('is idempotent: replaying the same security.changed converges, no duplicates beyond the log', async () => {
    const { rows: aapl } = await pool.query(
      `SELECT security_id FROM listings WHERE ticker = 'AAPL' AND valid_to IS NULL LIMIT 1`,
    );
    const before = await pool.query(`SELECT count(*)::int AS n FROM job_queue WHERE status = 'dead'`);
    await enqueue(pool, 'security.changed', aapl[0].security_id, { securityId: aapl[0].security_id });
    await enqueue(pool, 'security.changed', aapl[0].security_id, { securityId: aapl[0].security_id });
    const runner = buildRunner(pool);
    const { stats } = await runner.drain();
    expect(stats.dead).toBe(before.rows[0].n);
  });
});

describe('queue semantics (§26)', () => {
  it('preserves per-partition ordering', async () => {
    const seen: string[] = [];
    const runner = new WorkerRunner(pool).register('order.test', async (_pool, job) => {
      seen.push(String(job.payload.n));
    });
    for (const n of [1, 2, 3]) await enqueue(pool, 'order.test', 'same-key', { n });
    await runner.drain();
    expect(seen).toEqual(['1', '2', '3']);
  });

  it('retries with backoff and dead-letters after max_attempts (§26.2)', async () => {
    let calls = 0;
    const runner = new WorkerRunner(pool).register('fail.test', async () => {
      calls += 1;
      throw new Error('boom');
    });
    await enqueue(pool, 'fail.test', 'k', {}, { maxAttempts: 2 });
    // First drain: attempt 1 fails, retry scheduled in the future → drain ends.
    await runner.drain();
    expect(calls).toBe(1);
    // Make the retry runnable now, drain again → attempt 2 → dead letter.
    await pool.query(`UPDATE job_queue SET run_after = now() WHERE topic = 'fail.test'`);
    await runner.drain();
    expect(calls).toBe(2);
    const { rows } = await pool.query(
      `SELECT status, last_error FROM job_queue WHERE topic = 'fail.test'`,
    );
    expect(rows[0].status).toBe('dead');
    expect(rows[0].last_error).toContain('boom');
  });

  it('an unknown topic dead-letters instead of blocking the queue', async () => {
    await enqueue(pool, 'nobody.handles.this', 'k', {}, { maxAttempts: 1 });
    const runner = buildRunner(pool);
    const { stats } = await runner.drain();
    expect(stats.pending).toBe(0);
    const { rows } = await pool.query(
      `SELECT status FROM job_queue WHERE topic = 'nobody.handles.this'`,
    );
    expect(rows[0].status).toBe('dead');
    await pool.query(`DELETE FROM job_queue WHERE status = 'dead'`); // clean for later suites
  });
});
