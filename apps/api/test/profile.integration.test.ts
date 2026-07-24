/**
 * Investor Profile integration tests (Phase 2): versioning + immutability,
 * scenario calibration to the user's actual money, server-side band mapping,
 * stated/revealed divergence flag, deterministic strategy inference.
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
  const pipeline = new IngestPipeline(pool, new MockVendorAdapter(), new CollectingEventSink());
  await pipeline.run(SNAPSHOT_FROM, SNAPSHOT_TO);
  app = await buildServer(pool);

  const reg = await inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'priya@example.es', password: 'password1234', jurisdiction: 'ES', base_currency: 'EUR' },
  });
  const setCookie = reg.headers['set-cookie'];
  cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!;

  const p = await inject({
    method: 'POST',
    url: '/v1/portfolios',
    payload: { name: 'Main', type: 'taxable', base_currency: 'EUR' },
  });
  portfolioId = p.json().id;

  // Fund it and buy a concentrated equity book (AAPL-heavy so inference has
  // signal: US tech, P/E available from the mock fundamentals).
  await inject({
    method: 'POST',
    url: `/v1/portfolios/${portfolioId}/transactions`,
    payload: { type: 'deposit', trade_date: '2026-01-05', amount: '200000', currency: 'EUR' },
  });
  const buy = async (ticker: string, qty: string, price: string, ccy: string) => {
    const { rows } = await pool.query(
      `SELECT security_id FROM listings WHERE ticker = $1 AND valid_to IS NULL LIMIT 1`,
      [ticker],
    );
    const res = await inject({
      method: 'POST',
      url: `/v1/portfolios/${portfolioId}/transactions`,
      payload: {
        type: 'buy',
        security_id: rows[0].security_id,
        trade_date: '2026-02-02',
        quantity: qty,
        price,
        currency: ccy,
      },
    });
    expect(res.statusCode).toBe(201);
  };
  await buy('AAPL', '300', '210', 'USD');
  await buy('MSFT', '80', '430', 'USD');
  await buy('SIE', '100', '178', 'EUR');
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('profile lifecycle (FR-2.1..2.5)', () => {
  it('starts with no profile', async () => {
    const res = await inject({ method: 'GET', url: '/v1/profile' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeNull();
  });

  it('creates version 1 with server-derived revealed band and divergence flag', async () => {
    const res = await inject({
      method: 'POST',
      url: '/v1/profile',
      payload: {
        experience_level: 'intermediate',
        horizon_years: 10,
        capital_band: '100k-500k',
        stated_strategy: 'quality_growth',
        risk_stated: 5,
        scenario_answers: [
          { scenario_id: 'market_drawdown', prompt: 'p', answer: 'sell_everything' },
          { scenario_id: 'single_position_loss', prompt: 'p', answer: 'trim_some' },
          { scenario_id: 'flat_years', prompt: 'p', answer: 'move_to_cash' },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const d = res.json().data;
    expect(d.version).toBe(1);
    expect(d.riskStated).toBe(5);
    // bands 1,2,1 → mean 1.33 → revealed 1; |5−1| > 2 → divergence
    expect(d.riskRevealed).toBe(1);
    expect(d.riskDivergenceFlag).toBe(true);
    expect(d.strategySource).toBe('stated');
    expect(d.scenarioResponses.length).toBe(3);
    expect(d.scenarioResponses[0].answerBand).toBe(1); // server-mapped, not client-claimed
  });

  it('rejects an unknown scenario answer instead of trusting a client band', async () => {
    const res = await inject({
      method: 'POST',
      url: '/v1/profile',
      payload: {
        change_reason: 'testing',
        scenario_answers: [{ scenario_id: 'market_drawdown', prompt: 'p', answer: 'yolo' }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires change_reason for version 2+ (FR-2.1) then versions correctly', async () => {
    const missing = await inject({
      method: 'POST',
      url: '/v1/profile',
      payload: { risk_stated: 3 },
    });
    expect(missing.statusCode).toBe(400);

    const ok = await inject({
      method: 'POST',
      url: '/v1/profile',
      payload: { risk_stated: 3, change_reason: 'recalibrated after reality check' },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().data.version).toBe(2);

    const versions = await inject({ method: 'GET', url: '/v1/profile/versions' });
    expect(versions.json().data.length).toBe(2);
  });

  it('profile versions are immutable at the database level (§27.3.1)', async () => {
    await expect(
      pool.query(`UPDATE profile_versions SET risk_stated = 1 WHERE valid_to IS NOT NULL`),
    ).rejects.toThrow(/immutable/);
    await expect(pool.query(`DELETE FROM profile_versions`)).rejects.toThrow(/append-only/);
  });
});

describe('scenario calibration (US-ONB-04)', () => {
  it('calibrates scenarios to the actual portfolio value and largest position', async () => {
    const res = await inject({
      method: 'GET',
      url: `/v1/profile/scenarios?portfolio_id=${portfolioId}`,
    });
    expect(res.statusCode).toBe(200);
    const scenarios = res.json().data;
    expect(scenarios.length).toBe(3);
    // The drawdown prompt carries concrete EUR amounts, not a generic slider.
    expect(scenarios[0].prompt).toMatch(/EUR/);
    expect(scenarios[0].prompt).toMatch(/32%/);
    // Largest look-through name appears in the single-position scenario.
    expect(scenarios[1].prompt).toMatch(/Apple|NVIDIA|Microsoft|Siemens/);
    // Every option carries a server-owned band.
    for (const s of scenarios) {
      for (const o of s.options) expect(o.band).toBeGreaterThanOrEqual(1);
    }
  });

  it('falls back to the capital band midpoint when there is no portfolio', async () => {
    const res = await inject({ method: 'GET', url: `/v1/profile/scenarios?capital_band=<25k` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data[0].prompt).toContain('12000');
    expect(res.json().basis).toBe('capital_band');
  });

  it('reports which basis it used, so the UI cannot claim a real figure it never had', async () => {
    // A portfolio_id does NOT mean the portfolio had value. Without this the UI
    // told a user who skipped the import that a band midpoint was "your actual
    // portfolio value" (US-AI-02).
    const withValue = await inject({
      method: 'GET',
      url: `/v1/profile/scenarios?portfolio_id=${portfolioId}`,
    });
    expect(withValue.json().basis).toBe('portfolio');

    const { rows } = await pool.query(
      `INSERT INTO portfolios (user_id, name, type, base_currency)
       SELECT user_id, 'Empty', 'taxable', 'EUR' FROM portfolios WHERE id = $1 RETURNING id`,
      [portfolioId],
    );
    const empty = await inject({
      method: 'GET',
      url: `/v1/profile/scenarios?portfolio_id=${rows[0].id}&capital_band=100k-500k`,
    });
    expect(empty.json().basis).toBe('capital_band');
    // …and it uses the band the USER chose, not the default. Sending only
    // portfolio_id used to silently calibrate to the 25k-100k midpoint.
    expect(empty.json().data[0].prompt).toContain('250000');
    expect(empty.json().data[0].prompt).not.toContain('60000');
  });
});

describe('strategy inference (F-04, US-ONB-03)', () => {
  it('returns a deterministic hypothesis with evidence, confidence and provenance', async () => {
    const res = await inject({
      method: 'GET',
      url: `/v1/portfolios/${portfolioId}/strategy-inference`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.hypothesis).toBeTruthy();
    expect(Number(body.data.confidence)).toBeGreaterThan(0);
    expect(body.data.evidence.length).toBeGreaterThan(0);
    expect(body.provenance.methodology).toBe('strategy.v1');

    // Deterministic: same inputs, same inference (FR-5.6 discipline).
    const again = await inject({
      method: 'GET',
      url: `/v1/portfolios/${portfolioId}/strategy-inference`,
    });
    expect(JSON.stringify(again.json().data)).toBe(JSON.stringify(body.data));
  });

  it('accepting the inference records strategy_source = inferred', async () => {
    const inf = await inject({
      method: 'GET',
      url: `/v1/portfolios/${portfolioId}/strategy-inference`,
    });
    const { hypothesis, confidence } = inf.json().data;
    const res = await inject({
      method: 'POST',
      url: '/v1/profile',
      payload: {
        change_reason: 'accepted the inferred strategy',
        accepted_inference: { hypothesis, confidence },
      },
    });
    expect(res.statusCode).toBe(201);
    const d = res.json().data;
    expect(d.strategySource).toBe('inferred');
    expect(d.inferredStrategy).toBe(hypothesis);
  });
});
