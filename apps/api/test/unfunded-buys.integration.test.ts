/**
 * Issue #3: a portfolio imported with buys only (no deposit) leaves a negative
 * cash balance. ADR-001: that balance is kept as leverage — the value is net
 * of it — but never silently, and performance figures that need a positive
 * capital base are declared gaps instead of nonsense (TWR < −100%, drawdown
 * > 100%).
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
let userSeq = 0;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);
  await new IngestPipeline(pool, new MockVendorAdapter(), new CollectingEventSink()).run(SNAPSHOT_FROM, SNAPSHOT_TO);
  app = await buildServer(pool);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

/** Fresh user + EUR portfolio, optional deposit, then a CSV import of buys. */
async function importBuys(csvRows: string[], deposit?: { date: string; amount: string }) {
  userSeq += 1;
  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: `unfunded${userSeq}@example.es`, password: 'password1234', jurisdiction: 'ES', base_currency: 'EUR' },
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

  const p = await call('POST', '/v1/portfolios', { name: 'U', type: 'taxable', base_currency: 'EUR' });
  expect(p.statusCode).toBe(201);
  const id = p.json().id as string;
  if (deposit) {
    const dep = await call('POST', `/v1/portfolios/${id}/transactions`, {
      type: 'deposit', trade_date: deposit.date, amount: deposit.amount, currency: 'EUR',
    });
    expect(dep.statusCode).toBe(201);
  }
  const imp = await call('POST', `/v1/portfolios/${id}/import`, {
    csv: ['ticker,date,quantity,price,currency', ...csvRows].join('\n'),
    mapping: { ticker: 'ticker', date: 'date', quantity: 'quantity', price: 'price', currency: 'currency' },
    defaults: { type: 'buy' },
  });
  expect(imp.statusCode).toBe(200);
  expect(imp.json().skipped).toEqual([]);

  const perf = await call('GET', `/v1/portfolios/${id}/performance?method=both`);
  expect(perf.statusCode).toBe(200);
  const exposure = await call('GET', `/v1/portfolios/${id}/exposure`);
  expect(exposure.statusCode).toBe(200);
  return { perf: perf.json(), exposure: exposure.json() };
}

const inUnitRange = (v: string) => dec(v).gte(0) && dec(v).lte(1);
const reasons = (gaps: Array<{ reason: string }>) => gaps.map((g) => g.reason).join(' | ');

describe('buys-only import (issue #3)', () => {
  // Price = IWDA close on 2026-02-02, so the buy is worth exactly what it cost.
  const BUYS_ONLY = ['IWDA,2026-02-02,100,94.5334,EUR'];

  it('declares the unfunded purchases instead of passing the net value off as the portfolio', async () => {
    const { exposure } = await importBuys(BUYS_ONLY);
    expect(dec(exposure.data.cash_weight).isNegative()).toBe(true);
    expect(reasons(exposure.gaps)).toMatch(/negative EUR cash balance.*without a recorded deposit/);
  });

  it('never reports TWR below −100% or a drawdown outside [0, 1]: TWR and drawdown are declared gaps', async () => {
    const { perf } = await importBuys(BUYS_ONLY);
    expect(perf.data).not.toBeNull();
    expect(perf.data.twr).toBeNull();
    expect(perf.data.max_drawdown).toBeNull();
    expect(perf.data.current_drawdown).toBeNull();
    expect(reasons(perf.gaps)).toMatch(/EUR cash went negative/);
    expect(reasons(perf.gaps)).toMatch(/TWR and drawdown undefined.*no positive capital base/);
    // The local decomposition stays the honest price evolution (~ +3.7%).
    const eur = perf.data.currency_decomposition.find((c: { currency: string }) => c.currency === 'EUR');
    expect(dec(eur.localReturn).minus('0.0370').abs().lt('0.001')).toBe(true);
  });

  it('the same buy funded by a deposit gives a TWR in line with the price (~ +3.7%) and no cash gaps', async () => {
    const { perf, exposure } = await importBuys(BUYS_ONLY, { date: '2026-02-02', amount: '9453.34' });
    expect(dec(perf.data.twr).minus('0.0370').abs().lt('0.001')).toBe(true);
    expect(inUnitRange(perf.data.max_drawdown)).toBe(true);
    expect(inUnitRange(perf.data.current_drawdown)).toBe(true);
    expect(reasons(perf.gaps)).not.toMatch(/cash went negative|undefined/);
    expect(reasons(exposure.gaps)).not.toMatch(/negative .* cash balance/);
    // Total value = the holdings (~ 100 × 98.0343), not the gain.
    expect(dec(exposure.data.total_value_base).gt(9000)).toBe(true);
  });

  it('a partly funded buy (leverage on positive capital) keeps a TWR above −100% and a drawdown in [0, 1]', async () => {
    const { perf } = await importBuys(BUYS_ONLY, { date: '2026-02-02', amount: '5000' });
    if (perf.data.twr !== null) expect(dec(perf.data.twr).gt(-1)).toBe(true);
    for (const k of ['max_drawdown', 'current_drawdown'] as const) {
      if (perf.data[k] !== null) expect(inUnitRange(perf.data[k])).toBe(true);
    }
    expect(reasons(perf.gaps)).toMatch(/EUR cash went negative/);
  });
});
