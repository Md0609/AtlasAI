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

describe('exposure endpoint (Signal Engine over real data)', () => {
  it('returns weights summing to 1, an explicit unknown slice, provenance and staleness', async () => {
    const res = await inject({
      method: 'GET',
      url: `/v1/portfolios/${portfolioId}/exposure?dimension=sector`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const sum = body.data.weights.reduce(
      (a: InstanceType<typeof dec>, w: { weight: string }) => a.plus(w.weight),
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

describe('CSV import at scale (issue #4)', () => {
  // A second user, so the session's portfolio cap and the "empty portfolio"
  // assumption above are untouched.
  let viaImport = '';
  let viaTransactions = '';
  const mapping = { ticker: 'symbol', date: 'trade_date', type: 'side', quantity: 'qty', price: 'unit_price', currency: 'ccy', fee: 'fee' };

  const txCount = async (portfolio: string): Promise<number> => {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM transactions WHERE portfolio_id = $1', [portfolio]);
    return rows[0].n;
  };

  beforeAll(async () => {
    const reg = await inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'bulk@example.es', password: 'password1234', jurisdiction: 'ES', base_currency: 'EUR' },
      auth: false,
    });
    expect(reg.statusCode).toBe(201);
    const setCookie = reg.headers['set-cookie'];
    cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!;
    for (const name of ['import', 'transactions']) {
      const res = await inject({
        method: 'POST',
        url: '/v1/portfolios',
        payload: { name, type: 'taxable', base_currency: 'EUR' },
      });
      expect(res.statusCode).toBe(201);
      if (name === 'import') viaImport = res.json().id;
      else viaTransactions = res.json().id;
    }
  });

  it('derives the same positions and cash as writing the rows one by one', async () => {
    // Mixed: buys and sells, two currencies, fees, a sell that moves average
    // cost. Distinct dates per security keep the fold order unambiguous.
    const lines = [
      ['AAPL', '2026-02-02', 'buy', '50', '210', 'USD', '1.5'],
      ['IWDA', '2026-02-02', 'buy', '400', '95', 'EUR', '0'],
      ['AAPL', '2026-02-09', 'buy', '30', '220.25', 'USD', '1.5'],
      ['AAPL', '2026-02-16', 'sell', '20', '230', 'USD', '2'],
      ['IWDA', '2026-02-16', 'sell', '100', '97.5', 'EUR', '0.75'],
      ['NVDA', '2026-02-16', 'buy', '10', '900', 'USD', '0'],
    ];
    const csv = [Object.values(mapping).join(','), ...lines.map((l) => l.join(','))].join('\n');
    const imp = await inject({
      method: 'POST',
      url: `/v1/portfolios/${viaImport}/import`,
      payload: { csv, mapping },
    });
    expect(imp.statusCode).toBe(200);
    expect(imp.json()).toEqual({ imported: lines.length, skipped: [] });

    for (const [ticker, date, side, qty, price, ccy, fee] of lines) {
      const res = await inject({
        method: 'POST',
        url: `/v1/portfolios/${viaTransactions}/transactions`,
        payload: {
          type: side,
          security_id: await secIdByTicker(ticker!),
          trade_date: date,
          quantity: qty,
          price,
          currency: ccy,
          fee,
        },
      });
      expect(res.statusCode).toBe(201);
    }

    const a = (await inject({ method: 'GET', url: `/v1/portfolios/${viaImport}/positions` })).json().data;
    const b = (await inject({ method: 'GET', url: `/v1/portfolios/${viaTransactions}/positions` })).json().data;
    expect(a).toEqual(b);
    expect(a.positions.length).toBe(3);
    const aapl = a.positions.find((p: { name: string }) => /apple/i.test(p.name));
    expect(dec(aapl.quantity).eq('60')).toBe(true);
    // USD cash: −(50×210+1.5) − (30×220.25+1.5) + (20×230−2) − 10×900
    const usd = a.cash.find((c: { currency: string }) => c.currency === 'USD');
    expect(dec(usd.amount).eq('-21512.5')).toBe(true);
  });

  it('imports 2000 rows in one request and folds them all', async () => {
    const before = await txCount(viaImport);
    const rowsCsv = Array.from({ length: 2000 }, () => 'MSFT,2026-03-02,buy,1,400,USD,0');
    const csv = [Object.values(mapping).join(','), ...rowsCsv].join('\n');
    const started = Date.now();
    const res = await inject({ method: 'POST', url: `/v1/portfolios/${viaImport}/import`, payload: { csv, mapping } });
    const elapsed = Date.now() - started;
    expect(res.statusCode).toBe(200);
    expect(res.json().imported).toBe(2000);
    expect(await txCount(viaImport)).toBe(before + 2000);
    const msft = (await inject({ method: 'GET', url: `/v1/portfolios/${viaImport}/positions` }))
      .json()
      .data.positions.find((p: { name: string }) => /microsoft/i.test(p.name));
    expect(dec(msft.quantity).eq('2000')).toBe(true);
    console.info(`CSV import of 2000 rows took ${elapsed} ms`);
  });

  it('rejects a CSV over the row cap with problem+json and imports nothing', async () => {
    const before = await txCount(viaImport);
    const rowsCsv = Array.from({ length: 5001 }, () => 'MSFT,2026-03-02,buy,1,400,USD,0');
    const csv = [Object.values(mapping).join(','), ...rowsCsv].join('\n');
    const res = await inject({ method: 'POST', url: `/v1/portfolios/${viaImport}/import`, payload: { csv, mapping } });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json().title).toContain('5000');
    expect(res.json().trace_id).toBeTruthy();
    expect(await txCount(viaImport)).toBe(before);
  });

  it('accepts exactly the cap', async () => {
    const rowsCsv = Array.from({ length: 5000 }, () => 'MSFT,2026-03-02,buy,1,400,USD,0');
    const csv = [Object.values(mapping).join(','), ...rowsCsv].join('\n');
    const res = await inject({ method: 'POST', url: `/v1/portfolios/${viaTransactions}/import`, payload: { csv, mapping } });
    expect(res.statusCode).toBe(200);
    expect(res.json().imported).toBe(5000);
  });
});

describe('ledger input validation (issue #6)', () => {
  let pid = '';
  let aapl = '';
  let msft = '';
  const mapping = { ticker: 'symbol', date: 'trade_date', type: 'side', quantity: 'qty', price: 'unit_price', currency: 'ccy', fee: 'fee' };

  const snapshot = async () => {
    const data = (await inject({ method: 'GET', url: `/v1/portfolios/${pid}/positions` })).json().data;
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM transactions WHERE portfolio_id = $1', [pid]);
    return { data, txs: rows[0].n as number };
  };
  const postTx = (payload: Record<string, unknown>) =>
    inject({
      method: 'POST',
      url: `/v1/portfolios/${pid}/transactions`,
      payload: { currency: 'USD', ...payload },
    });
  const expectRejected = async (res: Awaited<ReturnType<typeof inject>>, before: Awaited<ReturnType<typeof snapshot>>) => {
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json().trace_id).toBeTruthy();
    expect(await snapshot()).toEqual(before);
  };

  beforeAll(async () => {
    const reg = await inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'validation@example.es', password: 'password1234', jurisdiction: 'ES', base_currency: 'EUR' },
      auth: false,
    });
    expect(reg.statusCode).toBe(201);
    const setCookie = reg.headers['set-cookie'];
    cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!;
    const res = await inject({ method: 'POST', url: '/v1/portfolios', payload: { name: 'v', type: 'taxable', base_currency: 'EUR' } });
    pid = res.json().id;
    aapl = await secIdByTicker('AAPL');
    msft = await secIdByTicker('MSFT');
    const buy = await postTx({ type: 'buy', security_id: aapl, trade_date: '2026-02-02', quantity: '10', price: '200' });
    expect(buy.statusCode).toBe(201);
  });

  it.each([
    ['negative quantity', { type: 'buy', quantity: '-3', price: '100' }],
    ['zero quantity', { type: 'buy', quantity: '0', price: '100' }],
    ['negative price', { type: 'buy', quantity: '1', price: '-100' }],
    ['negative fee', { type: 'buy', quantity: '1', price: '100', fee: '-1' }],
    ['negative sell quantity', { type: 'sell', quantity: '-1', price: '100' }],
    ['non-numeric quantity', { type: 'buy', quantity: 'abc', price: '100' }],
    ['non-numeric price', { type: 'buy', quantity: '1', price: '1e3' }],
    ['non-numeric fee', { type: 'buy', quantity: '1', price: '100', fee: 'x' }],
    ['impossible date', { type: 'buy', quantity: '1', price: '100', trade_date: '2026-02-30' }],
  ])('POST /transactions rejects %s with 400 and changes nothing', async (_name, body) => {
    const before = await snapshot();
    await expectRejected(await postTx({ security_id: aapl, trade_date: '2026-02-10', ...body }), before);
  });

  it('POST /transactions rejects a non-numeric amount with 400', async () => {
    const before = await snapshot();
    await expectRejected(await postTx({ type: 'deposit', trade_date: '2026-02-10', amount: 'abc', currency: 'EUR' }), before);
  });

  it('rejects a sell with no position', async () => {
    const before = await snapshot();
    const res = await postTx({ type: 'sell', security_id: msft, trade_date: '2026-02-10', quantity: '1000', price: '100' });
    await expectRejected(res, before);
    expect(res.json().title).toMatch(/negative holding/);
  });

  it('rejects a sell above the holding and a backdated sell before the buy', async () => {
    const before = await snapshot();
    await expectRejected(await postTx({ type: 'sell', security_id: aapl, trade_date: '2026-02-10', quantity: '11', price: '210' }), before);
    await expectRejected(await postTx({ type: 'sell', security_id: aapl, trade_date: '2026-01-15', quantity: '5', price: '210' }), before);
  });

  it('accepts selling exactly the holding, then refuses the next sell', async () => {
    const sell = await postTx({ type: 'sell', security_id: aapl, trade_date: '2026-02-10', quantity: '10', price: '210' });
    expect(sell.statusCode).toBe(201);
    const after = await snapshot();
    expect(after.data.positions.find((p: { security_id: string }) => p.security_id === aapl)).toBeUndefined();
    await expectRejected(await postTx({ type: 'sell', security_id: aapl, trade_date: '2026-02-11', quantity: '1', price: '210' }), after);
  });

  it.each([
    ['negative quantity', { quantity: '-5', price: '100' }],
    ['non-numeric quantity', { quantity: 'abc', price: '100' }],
    ['negative price', { quantity: '5', price: '-1' }],
    ['impossible date', { quantity: '5', price: '100', trade_date: '2026-02-30' }],
  ])('POST /positions rejects %s with 400', async (_name, body) => {
    const before = await snapshot();
    const res = await inject({
      method: 'POST',
      url: `/v1/portfolios/${pid}/positions`,
      payload: { security_id: msft, currency: 'USD', trade_date: '2026-02-10', ...body },
    });
    await expectRejected(res, before);
  });

  it('CSV import skips invalid rows with a reason and still imports the valid ones', async () => {
    const before = await snapshot();
    const lines = [
      // newest first, as many broker exports are: the sell is covered by the older buy below
      'MSFT,2026-03-09,sell,4,410,USD,0', // line 2: ok
      'MSFT,2026-03-02,buy,10,400,USD,1', // line 3: ok
      'MSFT,2026-03-02,buy,-10,100,USD,0', // line 4: negative quantity
      'MSFT,2026-02-30,buy,1,400,USD,0', // line 5: impossible date
      'MSFT,2026-03-02,buy,1,-400,USD,0', // line 6: negative price
      'MSFT,2026-03-02,buy,1,400,USD,-1', // line 7: negative fee
      'MSFT,2026-03-02,buy,1,400,USD,abc', // line 8: non-numeric fee
      'MSFT,2026-03-02,buy,abc,400,USD,0', // line 9: non-numeric quantity
      'MSFT,2026-03-10,sell,7,420,USD,0', // line 10: 10 − 4 = 6 held → oversell
      'NVDA,2026-03-02,sell,1,900,USD,0', // line 11: no position
      'MSFT,2026-03-01,sell,1,400,USD,0', // line 12: before the buy
    ];
    const csv = [Object.values(mapping).join(','), ...lines].join('\n');
    const res = await inject({ method: 'POST', url: `/v1/portfolios/${pid}/import`, payload: { csv, mapping } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.imported).toBe(2);
    expect(body.skipped.map((s: { line: number }) => s.line)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const reason = (line: number) => body.skipped.find((s: { line: number }) => s.line === line).reason;
    expect(reason(4)).toMatch(/quantity must be greater than 0/);
    expect(reason(5)).toMatch(/date/);
    expect(reason(6)).toMatch(/price/);
    expect(reason(7)).toMatch(/fee/);
    expect(reason(8)).toMatch(/fee not numeric/);
    expect(reason(9)).toMatch(/not numeric/);
    for (const line of [10, 11, 12]) expect(reason(line)).toMatch(/exceeds the holding/);

    const after = await snapshot();
    expect(after.txs).toBe(before.txs + 2);
    const pos = after.data.positions.find((p: { security_id: string }) => p.security_id === msft);
    expect(dec(pos.quantity).eq('6')).toBe(true);
  });

  it('no route has left a negative position anywhere in this suite', async () => {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM positions WHERE quantity < 0');
    expect(rows[0].n).toBe(0);
  });
});
