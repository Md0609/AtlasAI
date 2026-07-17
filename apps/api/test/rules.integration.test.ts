/**
 * Rules engine integration tests (Phase 2): mandatory stated_reason,
 * removal-requires-reason, evaluation in the same DB transaction as a
 * portfolio write (§27.4), breach duration, and suggestions derived from
 * the actual portfolio.
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

const inject = (opts: { method: 'GET' | 'POST' | 'DELETE'; url: string; payload?: unknown }) =>
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
    payload: { email: 'rules@example.es', password: 'password1234', jurisdiction: 'ES', base_currency: 'EUR' },
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
    payload: { type: 'deposit', trade_date: '2026-01-05', amount: '100000', currency: 'EUR' },
  });
  const { rows } = await pool.query(
    `SELECT security_id FROM listings WHERE ticker = 'AAPL' AND valid_to IS NULL LIMIT 1`,
  );
  aaplId = rows[0].security_id;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('rule lifecycle (§14.6, US-ONB-05)', () => {
  it('rejects a rule without a stated_reason — the reason is the mechanism', async () => {
    const res = await inject({
      method: 'POST',
      url: '/v1/rules',
      payload: { type: 'max_single_name', params: { limit: '0.15' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates a rule and evaluates it immediately (a rule is born evaluated)', async () => {
    const res = await inject({
      method: 'POST',
      url: '/v1/rules',
      payload: {
        type: 'max_single_name',
        params: { limit: '0.15' },
        stated_reason: 'I got destroyed by a 30% position in 2021. Never again.',
      },
    });
    expect(res.statusCode).toBe(201);
    const list = await inject({ method: 'GET', url: '/v1/rules' });
    const rule = list.json().data[0];
    expect(rule.stated_reason).toContain('destroyed');
    expect(rule.evaluation).not.toBeNull();
    expect(rule.evaluation.status).toBe('ok'); // all cash, nothing over 15%
  });

  it('a portfolio write re-evaluates rules in the SAME transaction (§27.4)', async () => {
    const before = await pool.query(`SELECT count(*)::int AS n FROM rule_evaluations`);
    // Buy enough AAPL to blow through the 15% limit (~63k EUR of a 100k pot).
    const res = await inject({
      method: 'POST',
      url: `/v1/portfolios/${portfolioId}/transactions`,
      payload: { type: 'buy', security_id: aaplId, trade_date: '2026-02-02', quantity: '300', price: '210', currency: 'USD' },
    });
    expect(res.statusCode).toBe(201);
    const after = await pool.query(`SELECT count(*)::int AS n FROM rule_evaluations`);
    expect(after.rows[0].n).toBeGreaterThan(before.rows[0].n);

    const list = await inject({ method: 'GET', url: '/v1/rules' });
    const rule = list.json().data[0];
    expect(rule.evaluation.status).toBe('breach');
    expect(rule.evaluation.observed.detail).toContain('Apple');
    expect(rule.evaluation.breach_since).toBeTruthy();
  });

  it('breach_since marks the START of the current streak across writes', async () => {
    const list1 = await inject({ method: 'GET', url: '/v1/rules' });
    const since1 = list1.json().data[0].evaluation.breach_since;
    // Another write: still in breach; breach_since must not move forward.
    await inject({
      method: 'POST',
      url: `/v1/portfolios/${portfolioId}/transactions`,
      payload: { type: 'deposit', trade_date: '2026-02-03', amount: '1000', currency: 'EUR' },
    });
    const list2 = await inject({ method: 'GET', url: '/v1/rules' });
    expect(list2.json().data[0].evaluation.breach_since).toBe(since1);
  });

  it('removal requires a reason and is a soft delete', async () => {
    const list = await inject({ method: 'GET', url: '/v1/rules' });
    const id = list.json().data[0].id;

    const noReason = await inject({ method: 'DELETE', url: `/v1/rules/${id}`, payload: {} });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().type).toContain('rule-removal-reason-required');

    const ok = await inject({
      method: 'DELETE',
      url: `/v1/rules/${id}`,
      payload: { reason: 'Testing removal friction' },
    });
    expect(ok.statusCode).toBe(204);

    const after = await inject({ method: 'GET', url: '/v1/rules' });
    expect(after.json().data.length).toBe(0);
    const { rows } = await pool.query(`SELECT removal_reason FROM rules WHERE id = $1`, [id]);
    expect(rows[0].removal_reason).toContain('friction');
  });

  it('the DB refuses a removal without a reason even if the API is bypassed', async () => {
    await expect(
      pool.query(`UPDATE rules SET removed_at = now(), removal_reason = NULL WHERE true`),
    ).rejects.toThrow();
  });
});

describe('every advertised rule type round-trips', () => {
  it('creates and evaluates one rule of each remaining type', async () => {
    const payloads = [
      { type: 'max_sector', params: { sector: 'Information Technology', limit: '0.30' } },
      { type: 'min_cash', params: { limit: '0.03' } },
      { type: 'max_cash', params: { limit: '0.9' } },
      { type: 'no_buy_list', params: { securityIds: [aaplId], label: 'no more Apple' } },
      { type: 'max_positions', params: { count: 30 } },
      { type: 'min_holding_period', params: { months: 12 } },
    ];
    for (const p of payloads) {
      const res = await inject({
        method: 'POST',
        url: '/v1/rules',
        payload: { ...p, stated_reason: 'test reason' },
      });
      expect(res.statusCode, `${p.type} should create`).toBe(201);
    }
    const list = await inject({ method: 'GET', url: '/v1/rules' });
    const byType = new Map(list.json().data.map((r: { type: string; evaluation: unknown }) => [r.type, r]));
    expect(byType.size).toBe(6);
    for (const [type, r] of byType) {
      expect((r as { evaluation: { status: string } }).evaluation, `${type} evaluated`).not.toBeNull();
    }
    // The no-buy-list rule must breach: AAPL is held.
    const nbl = byType.get('no_buy_list') as { evaluation: { status: string; observed: { detail: string } } };
    expect(nbl.evaluation.status).toBe('breach');
    expect(nbl.evaluation.observed.detail).toContain('Apple');
  });
});

describe('rule suggestions (D-002: derived from the actual portfolio)', () => {
  it('suggests a single-name cap above the current largest look-through weight', async () => {
    const res = await inject({ method: 'GET', url: '/v1/rules/suggestions' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const single = body.data.find((s: { type: string }) => s.type === 'max_single_name');
    expect(single).toBeTruthy();
    expect(Number(single.params.limit)).toBeGreaterThan(Number(single.current));
    expect(single.rationale).toMatch(/now/);
    expect(body.provenance.methodology).toBe('rule_suggestions.v1');
  });
});
