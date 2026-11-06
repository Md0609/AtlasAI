/**
 * Issue #7: positions, cash and performance must not depend on the order of
 * the CSV rows, nor on the insertion order of transactions within one day.
 *
 * `created_at` defaults to now() — constant for a whole DB transaction — so it
 * never broke a tie inside an import. A sell folded before the same-day buys
 * relieved nothing (avg = 0) and the average cost came out wrong.
 *
 * Convention (ADR-000, decision 7): within a trade date every quantity
 * increase is folded before any sell — the same end-of-day reading the
 * holding check already uses.
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

const HEADER = 'ticker,date,type,qty,price';
const MAPPING = { ticker: 'ticker', date: 'date', type: 'type', quantity: 'qty', price: 'price' };

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

/**
 * Fresh user + EUR portfolio with an earlier deposit, then one import request
 * per batch of rows. Returns positions, cash and performance.
 */
async function stateAfter(batches: string[][]) {
  userSeq += 1;
  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: `intraday${userSeq}@example.es`, password: 'password1234', jurisdiction: 'ES', base_currency: 'EUR' },
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

  const p = await call('POST', '/v1/portfolios', { name: 'I', type: 'taxable', base_currency: 'EUR' });
  expect(p.statusCode).toBe(201);
  const id = p.json().id as string;
  const dep = await call('POST', `/v1/portfolios/${id}/transactions`, {
    type: 'deposit', trade_date: '2026-01-02', amount: '10000', currency: 'EUR',
  });
  expect(dep.statusCode).toBe(201);

  for (const rows of batches) {
    const imp = await call('POST', `/v1/portfolios/${id}/import`, {
      csv: [HEADER, ...rows].join('\n') + '\n',
      mapping: MAPPING,
      defaults: { exchange: 'XAMS' },
    });
    expect(imp.statusCode).toBe(200);
    expect(imp.json().skipped).toEqual([]);
    expect(imp.json().imported).toBe(rows.length);
  }

  const positions = await call('GET', `/v1/portfolios/${id}/positions`);
  expect(positions.statusCode).toBe(200);
  const perf = await call('GET', `/v1/portfolios/${id}/performance?method=both`);
  expect(perf.statusCode).toBe(200);
  const perfData = perf.json().data;
  // input_hash covers the portfolio id; everything else must match exactly.
  const { input_hash: _hash, ...perfComparable } = perfData ?? {};
  return { positions: positions.json().data, perf: perfComparable, gaps: perf.json().gaps };
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

describe('intraday order does not change the fold (issue #7)', () => {
  it('a same-day buy and sell give avg_cost 100 whichever row comes first', async () => {
    const buy = 'ASML,2026-01-05,buy,10,100';
    const sell = 'ASML,2026-01-05,sell,5,120';
    const buyFirst = await stateAfter([[buy, sell]]);
    const sellFirst = await stateAfter([[sell, buy]]);

    expect(buyFirst.positions.positions).toHaveLength(1);
    const pos = buyFirst.positions.positions[0];
    expect(dec(pos.quantity).eq(5)).toBe(true);
    expect(dec(pos.avg_cost).eq(100)).toBe(true);
    // 10000 − 1000 + 600
    expect(buyFirst.positions.cash).toEqual([{ currency: 'EUR', amount: expect.any(String) }]);
    expect(dec(buyFirst.positions.cash[0].amount).eq(9600)).toBe(true);

    expect(sellFirst.positions).toEqual(buyFirst.positions);
    expect(buyFirst.perf.twr).toBeDefined();
    expect(sellFirst.perf).toEqual(buyFirst.perf);
    expect(sellFirst.gaps).toEqual(buyFirst.gaps);
  });

  it('two buys at different prices and a sell: every row order gives avg_cost 150', async () => {
    const rows = ['ASML,2026-01-05,buy,10,100', 'ASML,2026-01-05,buy,10,200', 'ASML,2026-01-05,sell,10,180'];
    const results = [];
    for (const order of permutations(rows)) results.push(await stateAfter([order]));

    const ref = results[0]!;
    expect(ref.positions.positions).toHaveLength(1);
    expect(dec(ref.positions.positions[0].quantity).eq(10)).toBe(true);
    expect(dec(ref.positions.positions[0].avg_cost).eq(150)).toBe(true);
    // 10000 − 1000 − 2000 + 1800
    expect(dec(ref.positions.cash[0].amount).eq(8800)).toBe(true);
    for (const r of results.slice(1)) {
      expect(r.positions).toEqual(ref.positions);
      expect(r.perf).toEqual(ref.perf);
      expect(r.gaps).toEqual(ref.gaps);
    }
  });

  it('insertion order across requests within the same day does not matter either', async () => {
    // Earlier-day history so both scenarios carry a non-trivial cost into the day.
    const before = ['ASML,2026-01-02,buy,4,90'];
    const a = await stateAfter([before, ['ASML,2026-01-05,buy,10,200'], ['ASML,2026-01-05,sell,6,180', 'ASML,2026-01-05,buy,10,100']]);
    const b = await stateAfter([before, ['ASML,2026-01-05,buy,10,100', 'ASML,2026-01-05,sell,6,180'], ['ASML,2026-01-05,buy,10,200']]);

    // (4×90 + 10×100 + 10×200) / 24 = 3360 / 24 = 140, unchanged by the sell.
    expect(dec(a.positions.positions[0].quantity).eq(18)).toBe(true);
    expect(dec(a.positions.positions[0].avg_cost).eq(140)).toBe(true);
    expect(b.positions).toEqual(a.positions);
    expect(b.perf).toEqual(a.perf);
  });
});
