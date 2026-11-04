/**
 * Issue #2: transactions dated on a Saturday or Sunday must enter the
 * performance series. Convention: they are booked on the next trading day
 * (tradingDayOnOrAfter), so the result equals the same transaction dated on
 * the following Monday.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { migrate, resetDatabase } from '@atlas/schema';
import { CollectingEventSink, IngestPipeline, MockVendorAdapter, SNAPSHOT_FROM, SNAPSHOT_TO } from '@atlas/ingest';
import { buildServer } from '@atlas/api';
import { dec } from '@atlas/domain';

const TEST_URL =
  process.env.ATLAS_TEST_DATABASE_URL ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';

let pool: pg.Pool;
let app: FastifyInstance;
let iwda = '';
let userSeq = 0;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);
  await new IngestPipeline(pool, new MockVendorAdapter(), new CollectingEventSink()).run(SNAPSHOT_FROM, SNAPSHOT_TO);
  app = await buildServer(pool);
  const { rows } = await pool.query(
    `SELECT security_id FROM listings WHERE ticker = 'IWDA' AND valid_to IS NULL LIMIT 1`,
  );
  iwda = rows[0].security_id;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

/** Fresh user + EUR portfolio with a deposit and a 50 × IWDA @ 95 EUR buy. */
async function performanceFor(depositDate: string, buyDate: string) {
  userSeq += 1;
  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: `weekend${userSeq}@example.es`, password: 'password1234', jurisdiction: 'ES', base_currency: 'EUR' },
  });
  expect(reg.statusCode).toBe(201);
  const setCookie = reg.headers['set-cookie'];
  const cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!;
  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      payload: payload as never,
      headers: { cookie, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
    });

  const p = await call('POST', '/v1/portfolios', { name: 'W', type: 'taxable', base_currency: 'EUR' });
  expect(p.statusCode).toBe(201);
  const id = p.json().id as string;
  const dep = await call('POST', `/v1/portfolios/${id}/transactions`, {
    type: 'deposit', trade_date: depositDate, amount: '10000', currency: 'EUR',
  });
  expect(dep.statusCode).toBe(201);
  const buy = await call('POST', `/v1/portfolios/${id}/transactions`, {
    type: 'buy', security_id: iwda, trade_date: buyDate, quantity: '50', price: '95', currency: 'EUR',
  });
  expect(buy.statusCode).toBe(201);

  const perf = await call('GET', `/v1/portfolios/${id}/performance?method=both`);
  expect(perf.statusCode).toBe(200);
  const exposure = await call('GET', `/v1/portfolios/${id}/exposure`);
  expect(exposure.statusCode).toBe(200);
  return { perf: perf.json(), exposure: exposure.json() };
}

describe('performance with weekend-dated transactions (issue #2)', () => {
  it('a Saturday or Sunday buy gives the same result as the same buy on the next Monday', async () => {
    const monday = await performanceFor('2026-02-02', '2026-02-09');
    const saturday = await performanceFor('2026-02-02', '2026-02-07');
    const sunday = await performanceFor('2026-02-02', '2026-02-08');

    // The weekday reference is a real, non-trivial result.
    expect(monday.perf.data).not.toBeNull();
    expect(monday.perf.data.currency_decomposition.length).toBeGreaterThan(0);
    expect(dec(monday.perf.data.mwr).isZero()).toBe(false);

    expect(saturday.perf.data).toEqual(monday.perf.data);
    expect(sunday.perf.data).toEqual(monday.perf.data);
    expect(saturday.perf.gaps).toEqual(monday.perf.gaps);
  });

  it('a weekend buy contributes to performance like it does to exposure', async () => {
    const { perf, exposure } = await performanceFor('2026-02-02', '2026-02-07');
    expect(exposure.data.weights.length).toBeGreaterThan(0);
    const eur = perf.data.currency_decomposition.find((c: { currency: string }) => c.currency === 'EUR');
    expect(eur).toBeTruthy();
    expect(dec(perf.data.twr).isZero()).toBe(false);
    expect(dec(perf.data.max_drawdown).isZero()).toBe(false);
  });

  it('a weekend deposit, also as the first transaction of the window, equals a Monday deposit', async () => {
    const monday = await performanceFor('2026-02-02', '2026-02-06');
    const sunday = await performanceFor('2026-02-01', '2026-02-06');
    const saturday = await performanceFor('2026-01-31', '2026-02-06');
    expect(monday.perf.data).not.toBeNull();
    expect(sunday.perf.data).toEqual(monday.perf.data);
    expect(saturday.perf.data).toEqual(monday.perf.data);
  });
});
