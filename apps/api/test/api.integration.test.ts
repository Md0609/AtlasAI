/**
 * API integration test against atlas_test (server built in-process, real DB,
 * real ingested market data from the mock vendor).
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
import { dec } from '@atlas/domain';

const TEST_URL =
  process.env.ATLAS_TEST_DATABASE_URL ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';

let pool: pg.Pool;
let app: FastifyInstance;
let cookie = '';
let portfolioId = '';

const inject = (opts: {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  payload?: unknown;
  auth?: boolean;
}) =>
  app.inject({
    method: opts.method,
    url: opts.url,
    payload: opts.payload as never,
    headers: {
      ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.auth === false ? {} : cookie ? { cookie } : {}),
    },
  });

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);
  const pipeline = new IngestPipeline(pool, new MockVendorAdapter(), new CollectingEventSink());
  await pipeline.run(SNAPSHOT_FROM, SNAPSHOT_TO);
  app = await buildServer(pool);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const secIdByTicker = async (ticker: string): Promise<string> => {
  const { rows } = await pool.query(
    `SELECT security_id FROM listings WHERE ticker = $1 AND valid_to IS NULL LIMIT 1`,
    [ticker],
  );
  return rows[0].security_id;
};

describe('auth & jurisdiction gate', () => {
  it('US registration is rejected 403 with problem+json before anything else exists (FR-1.3/1.4)', async () => {
    const res = await inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'us@example.com', password: 'password1234', jurisdiction: 'US', base_currency: 'USD' },
      auth: false,
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = res.json();
    expect(body.type).toContain('jurisdiction-not-supported');
    expect(body.trace_id).toBeTruthy();
  });

  it('ES registration succeeds and sets a session cookie', async () => {
    const res = await inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'ana@example.es', password: 'password1234', jurisdiction: 'es', base_currency: 'EUR' },
      auth: false,
    });
    expect(res.statusCode).toBe(201);
    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeTruthy();
    cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!;
  });

  it('unauthenticated /v1/me is a 401 problem', async () => {
    const res = await inject({ method: 'GET', url: '/v1/me', auth: false });
    expect(res.statusCode).toBe(401);
    expect(res.json().trace_id).toBeTruthy();
  });

  it('authenticated /v1/me returns the profile', async () => {
    const res = await inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(200);
    expect(res.json().jurisdiction).toBe('ES');
  });
});

describe('portfolios: cap and CRUD', () => {
  it('creates up to 3 portfolios, then 409s (Design §A5)', async () => {
    for (let i = 1; i <= 3; i++) {
      const res = await inject({
        method: 'POST',
        url: '/v1/portfolios',
        payload: { name: `P${i}`, type: 'taxable', base_currency: 'EUR' },
      });
      expect(res.statusCode).toBe(201);
      if (i === 1) portfolioId = res.json().id;
    }
    const over = await inject({
      method: 'POST',
      url: '/v1/portfolios',
      payload: { name: 'P4', type: 'taxable', base_currency: 'EUR' },
    });
    expect(over.statusCode).toBe(409);
    expect(over.json().type).toContain('portfolio-limit');
  });

  it('soft delete frees a slot', async () => {
    const list = await inject({ method: 'GET', url: '/v1/portfolios' });
    const last = list.json().data[2];
    const del = await inject({ method: 'DELETE', url: `/v1/portfolios/${last.id}` });
    expect(del.statusCode).toBe(204);
    const list2 = await inject({ method: 'GET', url: '/v1/portfolios' });
    expect(list2.json().data.length).toBe(2);
  });
});

describe('transactions are the source of truth (§27.3.4)', () => {
  it('deposit then buys derive positions and cash in the same DB transaction', async () => {
    const dep = await inject({
      method: 'POST',
      url: `/v1/portfolios/${portfolioId}/transactions`,
      payload: { type: 'deposit', trade_date: '2026-01-05', amount: '100000', currency: 'EUR' },
    });
    expect(dep.statusCode).toBe(201);

    const aapl = await secIdByTicker('AAPL');
    const iwda = await secIdByTicker('IWDA');
    for (const [sid, qty, price, ccy, date] of [
      [aapl, '50', '210', 'USD', '2026-02-02'],
      [iwda, '400', '95', 'EUR', '2026-02-02'],
    ] as const) {
      const res = await inject({
        method: 'POST',
        url: `/v1/portfolios/${portfolioId}/transactions`,
        payload: { type: 'buy', security_id: sid, trade_date: date, quantity: qty, price, currency: ccy },
      });
      expect(res.statusCode).toBe(201);
    }

    const pos = await inject({ method: 'GET', url: `/v1/portfolios/${portfolioId}/positions` });
    const data = pos.json().data;
    expect(data.positions.length).toBe(2);
    const cashEur = data.cash.find((c: { currency: string }) => c.currency === 'EUR');
    // 100000 − 400×95 = 62000 EUR
    expect(dec(cashEur.amount).eq('62000')).toBe(true);
    const cashUsd = data.cash.find((c: { currency: string }) => c.currency === 'USD');
    // −50×210 = −10500 USD (unfunded leg is honest, not hidden)
    expect(dec(cashUsd.amount).eq('-10500')).toBe(true);
  });

  it('CSV import resolves the OLD ticker TICK via its historical listing window', async () => {
    const csv = [
      'symbol,trade_date,qty,unit_price,ccy',
      'TICK,2026-02-16,100,45.5,EUR', // before the 2026-03-02 rename → must resolve
      'NVDA,2026-02-16,10,900,USD',
      'NOPE,2026-02-16,1,1,EUR', // unresolvable → skipped with reason
      'MSFT,bad-date,1,1,USD', // unparseable date → skipped with reason
    ].join('\n');
    const res = await inject({
      method: 'POST',
      url: `/v1/portfolios/${portfolioId}/import`,
      payload: {
        csv,
        mapping: { ticker: 'symbol', date: 'trade_date', quantity: 'qty', price: 'unit_price', currency: 'ccy' },
        defaults: { type: 'buy' },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.imported).toBe(2);
    expect(body.skipped.length).toBe(2);
    expect(body.skipped.map((s: { line: number }) => s.line).sort()).toEqual([4, 5]);

    // TICK resolved to the same security as TCKR
    const pos = await inject({ method: 'GET', url: `/v1/portfolios/${portfolioId}/positions` });
    const names = pos.json().data.positions.map((p: { name: string }) => p.name);
    expect(names.join(' ')).toContain('Synthetic Renamed Corp'); // TCKR security identity from the mock universe
  });
});

describe('transaction sign conventions (behavior-gap integrity)', () => {
  it('rejects a withdrawal with a positive amount instead of silently inflating cash', async () => {
    const res = await inject({
      method: 'POST',
      url: `/v1/portfolios/${portfolioId}/transactions`,
      payload: { type: 'withdrawal', trade_date: '2026-03-02', amount: '5000', currency: 'EUR' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().title).toContain('negative');
  });

  it('rejects a deposit with a negative amount', async () => {
    const res = await inject({
      method: 'POST',
      url: `/v1/portfolios/${portfolioId}/transactions`,
      payload: { type: 'deposit', trade_date: '2026-03-02', amount: '-5000', currency: 'EUR' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts a correctly signed withdrawal', async () => {
    const res = await inject({
      method: 'POST',
      url: `/v1/portfolios/${portfolioId}/transactions`,
      payload: { type: 'withdrawal', trade_date: '2026-03-02', amount: '-5000', currency: 'EUR' },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe('exposure endpoint (Signal Engine over real data)', () => {
  it('returns weights summing to 1, an explicit unknown slice, provenance and staleness', async () => {
    const res = await inject({
      method: 'GET',
      url: `/v1/portfolios/${portfolioId}/exposure?dimension=sector`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const sum = body.data.weights.reduce(
      (a: ReturnType<typeof dec>, w: { weight: string }) => a.plus(w.weight),
      dec(0),
    );
    expect(sum.minus(1).abs().lt('1e-15')).toBe(true);

    // IWDA has ~85% undisclosed holdings → UNKNOWN bucket must be present
    const unknown = body.data.slices.find((s: { key: string }) => s.key === 'UNKNOWN');
    expect(unknown).toBeTruthy();
    expect(dec(unknown.weight).gt(0)).toBe(true);

    expect(body.provenance.engineVersion).toBeTruthy();
    expect(body.provenance.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.provenance.methodology).toBe('exposure.sector.v1');
    expect(body.staleness.prices_as_of).toBe(SNAPSHOT_TO);
    expect(body.data.concentration.nominalN).toBeGreaterThan(0);
  });

  it('is deterministic: same portfolio, same inputHash across calls (FR-5.6)', async () => {
    const a = await inject({ method: 'GET', url: `/v1/portfolios/${portfolioId}/exposure` });
    const b = await inject({ method: 'GET', url: `/v1/portfolios/${portfolioId}/exposure` });
    expect(a.json().provenance.inputHash).toBe(b.json().provenance.inputHash);
    expect(JSON.stringify(a.json().data)).toBe(JSON.stringify(b.json().data));
  });

  it('validates dimension with problem+json', async () => {
    const res = await inject({
      method: 'GET',
      url: `/v1/portfolios/${portfolioId}/exposure?dimension=zodiac`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('problem+json');
  });
});

describe('performance endpoint', () => {
  it('returns TWR, MWR, drawdown and FR-3.6 local-vs-FX decomposition', async () => {
    const res = await inject({
      method: 'GET',
      url: `/v1/portfolios/${portfolioId}/performance?method=both`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).not.toBeNull();
    expect(body.data.twr).not.toBeNull();
    expect(body.data.mwr).not.toBeNull();
    expect(body.data.max_drawdown).not.toBeNull();
    const ccys = body.data.currency_decomposition.map((c: { currency: string }) => c.currency).sort();
    expect(ccys).toContain('USD');
    expect(ccys).toContain('EUR');
    const usd = body.data.currency_decomposition.find((c: { currency: string }) => c.currency === 'USD');
    expect(usd.localReturn).not.toBeNull();
    expect(usd.fxReturn).not.toBeNull();
    expect(body.provenance.methodology).toBe('performance.v1');
  });

  it('an empty portfolio declares a gap instead of inventing numbers', async () => {
    const list = await inject({ method: 'GET', url: '/v1/portfolios' });
    const empty = list.json().data.find((p: { id: string }) => p.id !== portfolioId);
    const res = await inject({ method: 'GET', url: `/v1/portfolios/${empty.id}/performance` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toBeNull();
    expect(body.gaps.length).toBeGreaterThan(0);
  });
});

describe('audit trail', () => {
  it('audit rows carry the request trace_id and cover the session actions', async () => {
    const { rows } = await pool.query(
      `SELECT action, trace_id FROM audit_log WHERE action IN
        ('user.register','portfolio.create','transaction.create','portfolio.import_csv','portfolio.delete')`,
    );
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ['user.register', 'portfolio.create', 'transaction.create', 'portfolio.import_csv', 'portfolio.delete']) {
      expect(actions.has(a), `missing audit action ${a}`).toBe(true);
    }
    expect(rows.every((r) => typeof r.trace_id === 'string' && r.trace_id.length > 0)).toBe(true);
  });
});
