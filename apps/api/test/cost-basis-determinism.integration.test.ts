/**
 * Cost basis must not depend on row order (P0-4).
 *
 * Both money folds ordered by (trade_date, created_at), and neither column
 * breaks a tie within a day: `created_at` defaults to now(), which is
 * transaction_timestamp() and therefore constant across a whole transaction, so
 * a CSV import writes every row with an identical value. `id` is a random uuid.
 *
 * Verified against this database before the fix: three rows inserted in one
 * transaction produced ONE distinct created_at.
 *
 * The fold's sell branch computes `avg = p.qty.isZero() ? 0 : cost / qty`, so a
 * sell folded before its buys relieves nothing:
 *
 *   buy 10@100, buy 10@200, sell 10  (one date)
 *     insertion order -> qty 10, cost 1500   (avg 150)
 *     sell folded first -> qty 10, cost 3000   (avg 300)
 *
 * recomputeDerivedState DELETEs and re-INSERTs positions, so the persisted
 * number could change between two runs over identical data, with no gap
 * declared. It feeds every unrealized gain the user sees.
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
let aaplId = '';

const post = (url: string, payload: unknown) =>
  app.inject({
    method: 'POST',
    url,
    payload: payload as never,
    headers: { 'content-type': 'application/json', cookie },
  });

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);
  // The security universe: the fold needs real securities to attach to.
  const pipeline = new IngestPipeline(pool, new MockVendorAdapter(), new CollectingEventSink());
  await pipeline.run(SNAPSHOT_FROM, SNAPSHOT_TO);
  app = await buildServer(pool);

  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      email: 'costbasis@example.es',
      password: 'password1234',
      jurisdiction: 'ES',
      base_currency: 'EUR',
    } as never,
    headers: { 'content-type': 'application/json' },
  });
  cookie = String(reg.headers['set-cookie']).split(';')[0]!;

  const p = await post('/v1/portfolios', { name: 'Fold', type: 'taxable', base_currency: 'EUR' });
  portfolioId = p.json().id;

  const { rows } = await pool.query(
    `SELECT security_id FROM listings WHERE ticker='AAPL' AND valid_to IS NULL LIMIT 1`,
  );
  aaplId = rows[0].security_id;

  await post(`/v1/portfolios/${portfolioId}/transactions`, {
    type: 'deposit',
    trade_date: '2026-01-05',
    amount: '100000',
    currency: 'EUR',
  });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const positions = async () =>
  (await app.inject({
    method: 'GET',
    url: `/v1/portfolios/${portfolioId}/positions`,
    headers: { cookie },
  })).json().data.positions;

describe('same-day transactions fold in a defined order', () => {
  it('gives every row a distinct seq even when created_at ties', async () => {
    // Three writes on one date. The API writes each in its own transaction, but
    // an import writes them in one — seq must separate them either way.
    for (const tx of [
      { type: 'buy', quantity: '10', price: '100' },
      { type: 'buy', quantity: '10', price: '200' },
      { type: 'sell', quantity: '10', price: '250' },
    ]) {
      const res = await post(`/v1/portfolios/${portfolioId}/transactions`, {
        ...tx,
        security_id: aaplId,
        trade_date: '2026-02-02',
        currency: 'USD',
      });
      expect(res.statusCode).toBe(201);
    }

    const { rows } = await pool.query(
      `SELECT seq, created_at FROM transactions
        WHERE portfolio_id = $1 AND trade_date = '2026-02-02' ORDER BY seq`,
      [portfolioId],
    );
    expect(rows.length).toBe(3);
    expect(new Set(rows.map((r) => String(r.seq))).size).toBe(3);
    // Ascending and gap-free relative to each other: this is the fold order.
    expect(Number(rows[1].seq)).toBeGreaterThan(Number(rows[0].seq));
    expect(Number(rows[2].seq)).toBeGreaterThan(Number(rows[1].seq));
  });

  it('folds buys before the sell, giving the average cost of what was bought', async () => {
    // 10@100 + 10@200 = 20 @ avg 150. Selling 10 relieves 10*150 = 1500,
    // leaving qty 10 and cost 1500. If the sell folded first, p.qty would be
    // zero, avg would be 0, nothing would be relieved, and cost would be 3000.
    const pos = await positions();
    const aapl = pos.find((p: { security_id: string }) => p.security_id === aaplId);
    expect(aapl).toBeDefined();
    expect(Number(aapl.quantity)).toBe(10);
    expect(Number(aapl.avg_cost)).toBe(150);
  });

  it('is stable across repeated recomputation of the same data', async () => {
    // recomputeDerivedState DELETEs and re-INSERTs positions on every write.
    // Under the old tie the persisted number could differ between two runs;
    // the guarantee is that identical data yields an identical answer.
    const before = (await positions()).find(
      (p: { security_id: string }) => p.security_id === aaplId,
    ).avg_cost;

    for (let i = 0; i < 3; i++) {
      // A no-op-ish write on another date forces a full refold.
      await post(`/v1/portfolios/${portfolioId}/transactions`, {
        type: 'deposit',
        trade_date: '2026-03-01',
        amount: '1',
        currency: 'EUR',
      });
      const after = (await positions()).find(
        (p: { security_id: string }) => p.security_id === aaplId,
      ).avg_cost;
      expect(after).toBe(before);
    }
  });

  it('orders an imported batch by its file order, not by heap order', async () => {
    // The case the tie actually broke: every row of an import shares one
    // created_at because they are written inside a single transaction.
    // A sell is an explicit type, not a negative quantity: with assume_funded
    // the latter would generate a negative deposit, which the cash-sign
    // invariant correctly rejects.
    const csv = [
      'ticker,date,type,quantity,price,currency',
      'MSFT,2026-04-01,buy,5,300,USD',
      'MSFT,2026-04-01,buy,5,500,USD',
      'MSFT,2026-04-01,sell,5,600,USD',
    ].join('\n');

    const res = await post(`/v1/portfolios/${portfolioId}/import`, {
      csv,
      mapping: {
        ticker: 'ticker',
        date: 'date',
        type: 'type',
        quantity: 'quantity',
        price: 'price',
        currency: 'currency',
      },
      defaults: { assume_funded: true },
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);

    const { rows } = await pool.query(
      `SELECT count(DISTINCT created_at)::int AS stamps, count(DISTINCT seq)::int AS seqs
         FROM transactions WHERE portfolio_id = $1 AND trade_date = '2026-04-01'`,
      [portfolioId],
    );
    // The premise of the bug, pinned: one timestamp, distinct sequences.
    expect(rows[0].stamps).toBe(1);
    expect(rows[0].seqs).toBeGreaterThan(1);
  });
});
