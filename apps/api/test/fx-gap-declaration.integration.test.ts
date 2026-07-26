/**
 * Missing FX must be declared, not silently deducted (P0-3, backend half).
 *
 * The performance series had two bare `if (rate === null) continue;` — one for
 * positions, one for cash — with no gap recorded, sitting directly after a
 * missing-PRICE branch that does push one, and in a file whose deposit branch
 * declares exactly this gap a few lines above. The engine handles it correctly
 * too (valuation.ts). So it was an omission, not a convention.
 *
 * The consequence: on any day without a rate, that position vanishes from the
 * value series. TWR, MWR, max drawdown and current drawdown are computed over
 * the understated series and returned with `gaps: []`. When the rate reappears
 * the value jumps, and the user reads a return that never happened.
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

const TEST_URL =
  process.env.ATLAS_TEST_DATABASE_URL ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';

let pool: pg.Pool;
let app: FastifyInstance;
let cookie = '';
let portfolioId = '';

const post = (url: string, payload: unknown) =>
  app.inject({
    method: 'POST',
    url,
    payload: payload as never,
    headers: { 'content-type': 'application/json', cookie },
  });

const performance = async () =>
  (await app.inject({
    method: 'GET',
    url: `/v1/portfolios/${portfolioId}/performance?method=both`,
    headers: { cookie },
  })).json();

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);
  const pipeline = new IngestPipeline(pool, new MockVendorAdapter(), new CollectingEventSink());
  await pipeline.run(SNAPSHOT_FROM, SNAPSHOT_TO);
  app = await buildServer(pool);

  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      email: 'fxgap@example.es',
      password: 'password1234',
      jurisdiction: 'ES',
      base_currency: 'EUR',
    } as never,
    headers: { 'content-type': 'application/json' },
  });
  cookie = String(reg.headers['set-cookie']).split(';')[0]!;

  const p = await post('/v1/portfolios', { name: 'FX', type: 'taxable', base_currency: 'EUR' });
  portfolioId = p.json().id;

  const { rows } = await pool.query(
    `SELECT security_id FROM listings WHERE ticker='AAPL' AND valid_to IS NULL LIMIT 1`,
  );

  await post(`/v1/portfolios/${portfolioId}/transactions`, {
    type: 'deposit',
    trade_date: '2026-01-05',
    amount: '100000',
    currency: 'EUR',
  });
  // A USD-priced holding in a EUR portfolio: valuing it needs USD→EUR.
  await post(`/v1/portfolios/${portfolioId}/transactions`, {
    type: 'buy',
    security_id: rows[0].security_id,
    trade_date: '2026-02-02',
    quantity: '100',
    price: '210',
    currency: 'USD',
  });
});

afterAll(async () => {
  await pool.end();
  await app.close();
});

describe('with FX available', () => {
  it('values the position and declares no FX gap', async () => {
    const res = await performance();
    expect(res.data).not.toBeNull();
    const fxGaps = (res.gaps as Array<{ reason: string }>).filter((g) => /no FX path/.test(g.reason));
    expect(fxGaps).toEqual([]);
  });
  it('reports the OLDEST contributing price, not the newest (P1-9)', async () => {
    // The engine's half of P1-9 is covered by golden/staleness.test.ts. This is
    // the API's half — a second, independent `pricesAsOf` fold in signals.ts —
    // and a final mutation sweep found it uncovered: flipping `<` back to `>`
    // left all 495 tests green.
    //
    // It lives in THIS block on purpose: the "FX missing" block below deletes
    // the rates, and without FX the position is skipped before pricesAsOf is
    // ever assigned, so the same assertions there would pass against null.
    //
    // The series walks every day in the window recording the bar date used, so
    // the minimum is the first priced day and the maximum the last. Asserting
    // it is not the maximum is what separates the two.
    const res = await performance();
    const asOf = res.staleness.prices_as_of as string | null;
    expect(asOf).toBeTruthy();

    const { rows } = await pool.query<{ lo: string; hi: string }>(
      `SELECT min(bar_date)::text AS lo, max(bar_date)::text AS hi
         FROM price_bars
        WHERE security_id IN (
          SELECT DISTINCT security_id FROM transactions
           WHERE portfolio_id = $1 AND security_id IS NOT NULL)`,
      [portfolioId],
    );

    expect(asOf! >= rows[0]!.lo).toBe(true);
    expect(asOf! <= rows[0]!.hi).toBe(true);
    // Strictly older than the newest — which is exactly what the max reported.
    expect(asOf! < rows[0]!.hi).toBe(true);
  });
});


describe('with FX missing', () => {
  let removed = 0;

  beforeAll(async () => {
    // The vendor stores EUR/USD and fxRate() derives USD→EUR by inversion, so
    // BOTH directions have to go. Counting the delete is not ceremony: the
    // first version of this test removed 'USD'/'EUR', which does not exist,
    // and every assertion below still passed — for the wrong reason.
    const a = await pool.query(
      `DELETE FROM fx_rates WHERE base_currency = 'EUR' AND quote_currency = 'USD'`,
    );
    const b = await pool.query(
      `DELETE FROM fx_rates WHERE base_currency = 'USD' AND quote_currency = 'EUR'`,
    );
    removed = (a.rowCount ?? 0) + (b.rowCount ?? 0);
  });

  it('actually removed the rates — otherwise the assertions below prove nothing', () => {
    expect(removed).toBeGreaterThan(0);
  });

  it('declares an FX gap rather than returning gaps: []', async () => {
    const res = await performance();
    const reasons = (res.gaps as Array<{ reason: string }>).map((g) => g.reason);
    expect(reasons.some((r) => /no FX path USD→EUR/.test(r))).toBe(true);
  });

  it('names the consequence, not just the missing input', async () => {
    // A gap that says "no FX path" without saying what it cost the number is
    // only half an admission.
    const res = await performance();
    const fx = (res.gaps as Array<{ reason: string }>).find((g) => /no FX path USD→EUR/.test(g.reason));
    expect(fx!.reason).toMatch(/excluded from the value series/);
  });

  it('still returns a response rather than failing — a declared gap, not an error', async () => {
    // Degrading loudly is the contract; refusing to answer is a different
    // product decision and not this one.
    const res = await performance();
    expect(res).toHaveProperty('gaps');
    expect(Array.isArray(res.gaps)).toBe(true);
  });
});
