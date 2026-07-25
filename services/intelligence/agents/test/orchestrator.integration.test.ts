/**
 * Intelligence plane end-to-end (Phase 4b) on the deterministic mock provider:
 * fan-out → Red Team → PSA → egress guard; anchored tensions quoting the user;
 * numbers rendered by signal reference; shared Layer-1 amortized across two
 * users; personal contextualization never cached; the §31.4 envelope.
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
import { contextualize } from '../src/index.js';
import { isRejected } from '@atlas/egress';

const TEST_URL =
  process.env.ATLAS_TEST_DATABASE_URL ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';

let pool: pg.Pool;
let app: FastifyInstance;
let aaplId = '';

interface Session {
  cookie: string;
  userId: string;
}

async function register(email: string): Promise<Session> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: 'password1234', jurisdiction: 'ES', base_currency: 'EUR' },
    headers: { 'content-type': 'application/json' },
  });
  const setCookie = res.headers['set-cookie'];
  return { cookie: String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!, userId: res.json().id };
}

async function fundAndBuyAapl(s: Session): Promise<string> {
  const p = await app.inject({
    method: 'POST',
    url: '/v1/portfolios',
    payload: { name: 'Main', type: 'taxable', base_currency: 'EUR' },
    headers: { 'content-type': 'application/json', cookie: s.cookie },
  });
  const portfolioId = p.json().id;
  const post = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/v1/portfolios/${portfolioId}/transactions`,
      payload,
      headers: { 'content-type': 'application/json', cookie: s.cookie },
    });
  await post({ type: 'deposit', trade_date: '2026-01-05', amount: '100000', currency: 'EUR' });
  // Heavy AAPL → breaches a 15% single-name rule.
  await post({ type: 'buy', security_id: aaplId, trade_date: '2026-02-02', quantity: '300', price: '230', currency: 'USD' });
  return portfolioId;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);
  await new IngestPipeline(pool, new MockVendorAdapter(), new CollectingEventSink()).run(
    SNAPSHOT_FROM,
    SNAPSHOT_TO,
  );
  app = await buildServer(pool);
  const { rows } = await pool.query(
    `SELECT security_id FROM listings WHERE ticker = 'AAPL' AND valid_to IS NULL LIMIT 1`,
  );
  aaplId = rows[0].security_id;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('contextualize orchestration (§21–§22)', () => {
  let priya: Session;

  it('runs the full fan-out and produces a guard-approved, user-anchored contextualization', async () => {
    priya = await register('priya-ctx@example.es');
    await fundAndBuyAapl(priya);

    // A rule Priya set (breached by the heavy AAPL buy) and a fired thesis
    // condition give the PSA anchored T1/T2 tensions to quote back.
    await app.inject({
      method: 'POST',
      url: '/v1/rules',
      payload: {
        type: 'max_single_name',
        params: { limit: '0.15' },
        stated_reason: 'Concentration burned me in 2021. Never again over fifteen percent.',
      },
      headers: { 'content-type': 'application/json', cookie: priya.cookie },
    });
    const thesis = await app.inject({
      method: 'POST',
      url: '/v1/theses',
      payload: {
        security_id: aaplId,
        statement: 'Services growth makes Apple a compounder.',
        conditions: [
          {
            condition_nl: 'Wrong if the price closes below one hundred and fifty',
            condition: {
              metric: { kind: 'price', securityId: aaplId },
              operator: 'lt',
              target: { kind: 'literal', value: '150' },
            },
          },
        ],
      },
      headers: { 'content-type': 'application/json', cookie: priya.cookie },
    });
    expect(thesis.statusCode).toBe(201);
    // Mark the condition met directly (the radar chain is exercised elsewhere).
    await pool.query(
      `UPDATE thesis_conditions SET status = 'met', met_at = now()
        WHERE thesis_id = (SELECT id FROM theses WHERE user_id = $1 AND security_id = $2 AND status='active')`,
      [priya.userId, aaplId],
    );

    const result = await contextualize(pool, {
      userId: priya.userId,
      baseCurrency: 'EUR',
      securityId: aaplId,
    });

    expect(isRejected(result.egress)).toBe(false);
    if (isRejected(result.egress)) return;
    const text = result.egress.text;
    expect(result.egress.guard.approved).toBe(true);
    // The user's own words, verbatim (T1 rule + T2 thesis condition).
    expect(text).toContain('Concentration burned me in 2021');
    expect(text).toContain('Wrong if the price closes below one hundred and fifty');
    // A number rendered by reference (the look-through weight), not generated.
    expect(text).toMatch(/look-through exposure to this name is \d+\.\d%/);
    // The Red Team's countercase and the honest unknown are present.
    expect(text).toContain('strongest case against');
    expect(text).toContain('What Atlas cannot tell you');
    // What-would-change-it is non-empty (§17.4).
    expect(text).toContain('What would change this:');

    // Five agents traced (financial, valuation, news, red_team, psa).
    const { rows: agents } = await pool.query(
      `SELECT DISTINCT agent FROM agent_messages`,
    );
    const names = new Set(agents.map((r) => r.agent));
    for (const a of ['financial_analysis', 'valuation', 'news_filings', 'red_team', 'psa']) {
      expect(names.has(a), `missing trace for ${a}`).toBe(true);
    }
    // The guard verdict was recorded (§29.1).
    const { rows: gd } = await pool.query(`SELECT verdict FROM guard_decisions ORDER BY id DESC LIMIT 1`);
    expect(gd[0].verdict).toBe('approved');
  });

  it('caches shared Layer-1 analysis and amortizes it across a second holder (§40)', async () => {
    const { rows: before } = await pool.query(
      `SELECT count(*)::int AS n FROM shared_analysis_cache`,
    );
    expect(before[0].n).toBe(4); // financial, valuation, news, red_team

    const david = await register('david-ctx@example.es');
    await fundAndBuyAapl(david);
    const { rows: hitsBefore } = await pool.query(
      `SELECT count(*)::int AS n FROM agent_messages WHERE cache_hit = true`,
    );
    await contextualize(pool, { userId: david.userId, baseCurrency: 'EUR', securityId: aaplId });

    // The four Layer-1 agents were served from cache for David — no new cache rows.
    const { rows: after } = await pool.query(`SELECT count(*)::int AS n FROM shared_analysis_cache`);
    expect(after[0].n).toBe(4);
    const { rows: hitsAfter } = await pool.query(
      `SELECT count(*)::int AS n FROM agent_messages WHERE cache_hit = true`,
    );
    expect(hitsAfter[0].n - hitsBefore[0].n).toBe(4);
  });

  it('never caches the personal contextualization (§40.4)', async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM shared_analysis_cache WHERE agent = 'psa'`,
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('POST /v1/contextualize (§31.2 / §31.4 envelope)', () => {
  it('returns confidence, provenance and gaps as required fields', async () => {
    const s = await register('env-ctx@example.es');
    await fundAndBuyAapl(s);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/contextualize',
      payload: { security_id: aaplId },
      headers: { 'content-type': 'application/json', cookie: s.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.text.length).toBeGreaterThan(0);
    expect(body.confidence.what_would_change_it.length).toBeGreaterThan(0);
    expect(body.provenance.length).toBeGreaterThan(0);
    expect(body.guard.verdict).toBe('approved');
    // Provenance carries the signal that the look-through weight was rendered from.
    expect(body.provenance.some((p: { claim_id: string }) => p.claim_id === 'portfolio.look_through_weight')).toBe(true);
  });

  it('404s on an unknown security', async () => {
    const s = await register('nf-ctx@example.es');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/contextualize',
      payload: { security_id: '00000000-0000-0000-0000-000000000000' },
      headers: { 'content-type': 'application/json', cookie: s.cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});
