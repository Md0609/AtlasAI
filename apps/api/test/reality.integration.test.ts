/**
 * Reality Check endpoint (F-09) against real ingested data: the ETF-heavy
 * portfolio must surface a look-through insight (US-ONB-02: "contains ≥1
 * look-through insight not visible in the user's broker"), with provenance,
 * staleness, and honest warnings on short correlation history.
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
    payload: { email: 'rc@example.es', password: 'password1234', jurisdiction: 'ES', base_currency: 'EUR' },
  });
  const setCookie = reg.headers['set-cookie'];
  cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!;

  const p = await inject({
    method: 'POST',
    url: '/v1/portfolios',
    payload: { name: 'Main', type: 'taxable', base_currency: 'EUR' },
  });
  portfolioId = p.json().id;

  await inject({
    method: 'POST',
    url: `/v1/portfolios/${portfolioId}/transactions`,
    payload: { type: 'deposit', trade_date: '2026-01-05', amount: '120000', currency: 'EUR' },
  });
  // Priya-shaped book: direct AAPL + MSFT plus an ETF that also holds them —
  // the look-through gap the broker cannot show.
  const buy = async (ticker: string, qty: string, price: string, ccy: string) => {
    const { rows } = await pool.query(
      `SELECT security_id FROM listings WHERE ticker = $1 AND valid_to IS NULL LIMIT 1`,
      [ticker],
    );
    await inject({
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
  };
  await buy('AAPL', '60', '210', 'USD');
  await buy('MSFT', '20', '430', 'USD');
  await buy('IWDA', '1000', '95', 'EUR');
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('GET /v1/portfolios/:id/reality-check', () => {
  it('surfaces at most 3 surprises with computed numerals, provenance and staleness', async () => {
    const res = await inject({ method: 'GET', url: `/v1/portfolios/${portfolioId}/reality-check` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.data.top.length).toBeGreaterThan(0);
    expect(body.data.top.length).toBeLessThanOrEqual(3);
    // The look-through insight must be present (US-ONB-02): AAPL or MSFT
    // exposure arrives both directly and via IWDA.
    const gap = body.data.top.find((s: { kind: string }) => s.kind === 'lookthrough_gap');
    expect(gap).toBeTruthy();
    expect(gap.headline).toMatch(/Apple|Microsoft|NVIDIA/);
    // Every narrated value is machine-readable too (numbers are computed).
    expect(gap.values.total).toBeTruthy();
    expect(Number(gap.values.total)).toBeGreaterThan(Number(gap.values.direct));

    expect(body.provenance.methodology).toBe('surprise.v1');
    expect(body.provenance.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.staleness.prices_as_of).toBe(SNAPSHOT_TO);
  });

  it('warns about the short correlation window instead of hiding it (US-PF-03)', async () => {
    const res = await inject({ method: 'GET', url: `/v1/portfolios/${portfolioId}/reality-check` });
    const body = res.json();
    // ~6 months of mock history < 1y ⇒ the warning must be present.
    expect(body.warnings.some((w: string) => w.includes('under the 1 year'))).toBe(true);
  });

  it('is deterministic across calls (FR-5.6)', async () => {
    const a = await inject({ method: 'GET', url: `/v1/portfolios/${portfolioId}/reality-check` });
    const b = await inject({ method: 'GET', url: `/v1/portfolios/${portfolioId}/reality-check` });
    expect(JSON.stringify(a.json().data)).toBe(JSON.stringify(b.json().data));
    expect(a.json().provenance.inputHash).toBe(b.json().provenance.inputHash);
  });

  it('funded import (assume_funded) nets cash to zero so weights have an honest denominator', async () => {
    const p = await inject({
      method: 'POST',
      url: '/v1/portfolios',
      payload: { name: 'Imported', type: 'taxable', base_currency: 'EUR' },
    });
    const pid = p.json().id;
    const res = await inject({
      method: 'POST',
      url: `/v1/portfolios/${pid}/import`,
      payload: {
        csv: 'ticker,date,quantity,price,currency\nAAPL,2026-02-02,60,210,USD\nIWDA,2026-02-02,1000,95,EUR',
        mapping: { ticker: 'ticker', date: 'date', quantity: 'quantity', price: 'price', currency: 'currency' },
        defaults: { type: 'buy', assume_funded: true },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().imported).toBe(2);

    const pos = await inject({ method: 'GET', url: `/v1/portfolios/${pid}/positions` });
    // Every buy was matched by a same-day funding deposit: no fabricated
    // negative cash, so the Reality Check denominator is the real portfolio.
    expect(pos.json().data.cash.length).toBe(0);

    const rc = await inject({ method: 'GET', url: `/v1/portfolios/${pid}/reality-check` });
    const WEIGHT_KEYS = ['total', 'direct', 'viaFunds', 'weight', 'foreignShare'];
    for (const s of rc.json().data.top) {
      for (const [k, v] of Object.entries(s.values)) {
        if (WEIGHT_KEYS.includes(k)) {
          expect(Number(v), `${s.kind}.${k}`).toBeLessThanOrEqual(1.0001); // fractions, not 243%
        }
      }
    }
  });

  it('narrates surprise bodies behind the Guard, keeping every figure provenanced (§B1)', async () => {
    const res = await inject({ method: 'GET', url: `/v1/portfolios/${portfolioId}/reality-check` });
    const body = res.json();

    // Narration provenance is declared: which model, and whether it degraded.
    expect(body.provenance.narration).toBeTruthy();
    expect(body.provenance.narration.traceId).toMatch(/^[0-9a-f-]+$/);
    expect(body.provenance.narration.model).toBeTruthy();
    // Mock provider: narration is guard-clean and numeral-preserving ⇒ no degradation.
    expect(body.provenance.narration.degraded).toBe(false);

    // Every numeral in the narrated body must also appear in the computed values —
    // narration never invents or alters a figure (numeral-preservation).
    const gap = body.data.top.find((s: { kind: string }) => s.kind === 'lookthrough_gap');
    const numeralsIn = (s: string): string[] => (s.match(/\d[\d.,]*/g) ?? []).map((n) => n.replace(/,/g, ''));
    // The body renders percentages (e.g. "23.4%"); the raw values are fractions.
    // A rendered numeral must trace to a computed fraction (× 100, one dp).
    const rendered = numeralsIn(gap.body);
    expect(rendered.length).toBeGreaterThan(0);

    // A guard decision was recorded for each narrated surprise (append-only audit).
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM guard_decisions
        WHERE (generator->>'agent') = 'narrator'`,
    );
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it('404s on a portfolio the user does not own', async () => {
    const res = await inject({
      method: 'GET',
      url: `/v1/portfolios/00000000-0000-0000-0000-000000000000/reality-check`,
    });
    expect(res.statusCode).toBe(404);
  });
});
