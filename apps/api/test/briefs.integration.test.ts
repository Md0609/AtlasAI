/**
 * Briefs + notifications + decisions (Phase 3): the M3 exit criterion —
 * a falsification condition fires end-to-end (price event → radar →
 * templated brief → email) with provenance and the user's own words —
 * plus dedup, the C0 budget exemption, the 2/day hard cap, C1 rule-breach
 * briefs, suppression logging, and append-only decisions.
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
import { enqueue } from '@atlas/bus';
import { buildRunner } from '@atlas/workers';

const TEST_URL =
  process.env.ATLAS_TEST_DATABASE_URL ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';

let pool: pg.Pool;
let app: FastifyInstance;
let cookie = '';
let portfolioId = '';
let aaplId = '';
let msftId = '';
let sieId = '';

const inject = (opts: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string; payload?: unknown }) =>
  app.inject({
    method: opts.method,
    url: opts.url,
    payload: opts.payload as never,
    headers: {
      ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
  });

async function priceMoveAndDrain(securityId: string, close: string, currency: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT max(bar_date)::text AS d FROM price_bars WHERE security_id = $1`,
    [securityId],
  );
  const next = new Date(Date.parse(`${rows[0].d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  await pool.query(`SELECT ensure_price_bars_partition($1::date)`, [next]);
  await pool.query(
    `INSERT INTO price_bars (security_id, bar_date, open, high, low, close, adjusted_close, volume, currency, source)
     VALUES ($1,$2,$3,$3,$3,$3,$3, 1000, $4, 'test')`,
    [securityId, next, close, currency],
  );
  await enqueue(pool, 'security.changed', securityId, { securityId });
  const { stats } = await buildRunner(pool).drain();
  expect(stats.dead).toBe(0);
}

const tickerId = async (ticker: string): Promise<string> => {
  const { rows } = await pool.query(
    `SELECT security_id FROM listings WHERE ticker = $1 AND valid_to IS NULL LIMIT 1`,
    [ticker],
  );
  return rows[0].security_id;
};

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
    payload: { email: 'briefs@example.es', password: 'password1234', jurisdiction: 'ES', base_currency: 'EUR' },
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
    payload: { type: 'deposit', trade_date: '2026-01-05', amount: '200000', currency: 'EUR' },
  });
  aaplId = await tickerId('AAPL');
  msftId = await tickerId('MSFT');
  sieId = await tickerId('SIE');
  for (const [sid, qty, price, ccy] of [
    [aaplId, '100', '210', 'USD'],
    [msftId, '50', '430', 'USD'],
    [sieId, '100', '178', 'EUR'],
  ] as const) {
    await inject({
      method: 'POST',
      url: `/v1/portfolios/${portfolioId}/transactions`,
      payload: { type: 'buy', security_id: sid, trade_date: '2026-02-02', quantity: qty, price, currency: ccy },
    });
  }
  // Baseline: drain whatever the writes enqueued so tests start quiet.
  await buildRunner(pool).drain();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('M3: the deterministic money journey ends in a brief and an email', () => {
  it('thesis falsification → C0 brief quoting the user, email in the outbox, budget-exempt', async () => {
    const thesis = await inject({
      method: 'POST',
      url: '/v1/theses',
      payload: {
        security_id: aaplId,
        statement: 'Compounder thesis: services carry it. Wrong below 150.',
        conditions: [
          {
            condition_nl: 'Wrong if the price closes below 150',
            condition: {
              metric: { kind: 'price', securityId: aaplId },
              operator: 'lt',
              target: { kind: 'literal', value: '150' },
            },
          },
        ],
      },
    });
    expect(thesis.statusCode).toBe(201);

    await priceMoveAndDrain(aaplId, '140', 'USD');

    const briefs = await inject({ method: 'GET', url: '/v1/briefs' });
    const c0 = briefs.json().data.find((b: { class: string }) => b.class === 'C0');
    expect(c0).toBeTruthy();
    expect(c0.headline).toContain('your own falsification condition');
    expect(c0.body).toContain('Wrong below 150'); // the thesis, verbatim
    expect(c0.body).toContain('Wrong if the price closes below 150'); // their condition, verbatim
    expect(c0.body).toContain('140'); // observed value — computed, not generated
    expect(c0.thesis_id).toBeTruthy();

    // §B1: the body went through narration behind the Guard; provenance records
    // it. Under the mock the body is the template verbatim (so the verbatim
    // quotes above still hold) and narration did not degrade.
    const { rows: prov } = await pool.query(
      `SELECT provenance->'narration' AS narration FROM briefs WHERE id = $1`,
      [c0.id],
    );
    expect(prov[0].narration).toBeTruthy();
    expect(prov[0].narration.model).toBeTruthy();
    expect(prov[0].narration.degraded).toBe(false);
    // The narration was screened and recorded as a guard decision.
    const { rows: gd } = await pool.query(
      `SELECT count(*)::int AS n FROM guard_decisions WHERE (generator->>'agent') = 'narrator'`,
    );
    expect(gd[0].n).toBeGreaterThan(0);

    const { rows: mail } = await pool.query(`SELECT to_email, subject, body_text FROM email_outbox`);
    expect(mail.length).toBe(1);
    expect(mail[0].to_email).toBe('briefs@example.es');
    expect(mail[0].subject).toContain('falsification');
    expect(mail[0].body_text).toContain('Wrong below 150');

    const { rows: ledger } = await pool.query(
      `SELECT class FROM notification_budget_ledger WHERE class = 'C0'`,
    );
    expect(ledger.length).toBe(1); // C0 in the ledger but exempt from caps
  });

  it('two same-day fires on the same story are one delivery (§24.3 semantic dedup)', async () => {
    // Two manual radars watching the same MSFT story with nearby thresholds —
    // "four outlets reporting one story is one story."
    const mk = async (name: string, threshold: string) =>
      inject({
        method: 'POST',
        url: '/v1/radars',
        payload: {
          name,
          security_id: msftId,
          condition_nl: `MSFT below ${threshold}`,
          condition: {
            metric: { kind: 'price', securityId: msftId },
            operator: 'lt',
            target: { kind: 'literal', value: threshold },
          },
        },
      });
    await mk('MSFT dip A', '400');
    await mk('MSFT dip B', '405');
    await priceMoveAndDrain(msftId, '390', 'USD'); // both radars fire

    const { rows: briefRows } = await pool.query(
      `SELECT count(*)::int AS n FROM briefs WHERE class = 'C2' AND security_id = $1`,
      [msftId],
    );
    expect(briefRows[0].n).toBe(2); // both briefs exist in the inbox…
    const { rows: mail } = await pool.query(
      `SELECT count(*)::int AS n FROM email_outbox WHERE to_email = 'briefs@example.es'`,
    );
    expect(mail[0].n).toBe(2); // …but only one NEW email (C0 earlier + this one)
    const sup = await inject({ method: 'GET', url: '/v1/suppressions' });
    expect(sup.json().data.some((s: { reason: string }) => s.reason.includes('duplicate'))).toBe(true);
  });

  it('the 2/day hard cap suppresses the third non-C0 delivery (§18.6), with the DB as backstop', async () => {
    // C2 #2: SIE (held). C2 #3: ASML — NOT held, which also verifies radars
    // on candidates evaluate via the radar-owner fan-out (§15.1).
    const asmlId = await tickerId('ASML');
    const mk = async (sid: string, name: string, threshold: string) =>
      inject({
        method: 'POST',
        url: '/v1/radars',
        payload: {
          name,
          security_id: sid,
          condition_nl: `${name} threshold`,
          condition: {
            metric: { kind: 'price', securityId: sid },
            operator: 'lt',
            target: { kind: 'literal', value: threshold },
          },
        },
      });
    await mk(sieId, 'SIE dip', '170');
    await mk(asmlId, 'ASML entry', '700');
    await priceMoveAndDrain(sieId, '165', 'EUR'); // C2 #2 → delivered
    await priceMoveAndDrain(asmlId, '650', 'EUR'); // C2 #3 → over the cap → suppressed

    const { rows: ledger } = await pool.query(
      `SELECT count(*)::int AS n FROM notification_budget_ledger WHERE class <> 'C0'`,
    );
    expect(ledger[0].n).toBe(2);
    const sup = await inject({ method: 'GET', url: '/v1/suppressions' });
    expect(sup.json().data.some((s: { reason: string }) => s.reason.includes('daily cap'))).toBe(true);

    // The schema constraint is the real mechanism (§29.1): a direct insert
    // beyond the cap is rejected below the application layer.
    const { rows: briefRows } = await pool.query(`SELECT user_id FROM briefs LIMIT 1`);
    await expect(
      pool.query(
        `INSERT INTO notification_budget_ledger (user_id, brief_id, class, day_bucket, week_bucket)
         SELECT $1, b.id, 'C2', now()::date, date_trunc('week', now()::date)::date
           FROM briefs b LIMIT 1`,
        [briefRows[0].user_id],
      ),
    ).rejects.toThrow(/hard cap|budget/);
  });
});

describe('C1 rule-breach briefs quote the stated reason (§14.6)', () => {
  it('an ok→breach transition generates one light-tone brief with the user quoted', async () => {
    await inject({
      method: 'POST',
      url: '/v1/rules',
      payload: {
        type: 'max_cash',
        params: { limit: '0.9' },
        stated_reason: 'Cash drag killed my 2019 returns.',
      },
    });
    // Sell everything AAPL to blow cash above 90%? Simpler: min_cash breach —
    // create a rule that's ok now and flips on the next write.
    await inject({
      method: 'POST',
      url: '/v1/rules',
      payload: {
        type: 'max_single_name',
        params: { limit: '0.4' },
        stated_reason: 'Never again more than 40% in one name.',
      },
    });
    // Buy a lot more AAPL → its weight crosses 40% on the next evaluation.
    const res = await inject({
      method: 'POST',
      url: `/v1/portfolios/${portfolioId}/transactions`,
      payload: { type: 'buy', security_id: aaplId, trade_date: '2026-03-02', quantity: '700', price: '145', currency: 'USD' },
    });
    expect(res.statusCode).toBe(201);
    await buildRunner(pool).drain();

    const briefs = await inject({ method: 'GET', url: '/v1/briefs' });
    const c1 = briefs.json().data.find((b: { class: string }) => b.class === 'C1');
    expect(c1).toBeTruthy();
    expect(c1.tone).toBe('light');
    expect(c1.headline).toContain('Heads up');
    expect(c1.body).toContain('Never again more than 40% in one name.'); // quoted back
  });

  it('staying in breach does not re-brief (transition-triggered, not level-triggered)', async () => {
    const before = await pool.query(`SELECT count(*)::int AS n FROM briefs WHERE class = 'C1'`);
    await inject({
      method: 'POST',
      url: `/v1/portfolios/${portfolioId}/transactions`,
      payload: { type: 'deposit', trade_date: '2026-03-03', amount: '100', currency: 'EUR' },
    });
    await buildRunner(pool).drain();
    const after = await pool.query(`SELECT count(*)::int AS n FROM briefs WHERE class = 'C1'`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe('decisions (P-03: reasoning captured, append-only)', () => {
  it('records a decision from a brief with a mandatory reason', async () => {
    const briefs = await inject({ method: 'GET', url: '/v1/briefs' });
    const c0 = briefs.json().data.find((b: { class: string }) => b.class === 'C0');

    const noReason = await inject({
      method: 'POST',
      url: '/v1/decisions',
      payload: { action: 'no_change', brief_id: c0.id, reason: '' },
    });
    expect(noReason.statusCode).toBe(400);

    const res = await inject({
      method: 'POST',
      url: '/v1/decisions',
      payload: {
        action: 'no_change',
        brief_id: c0.id,
        thesis_id: c0.thesis_id,
        security_id: c0.security_id,
        reason: 'SMB weakness reads cyclical to me; enterprise net-new is intact. Revisit at Q4.',
      },
    });
    expect(res.statusCode).toBe(201);

    const list = await inject({ method: 'GET', url: '/v1/decisions' });
    expect(list.json().data[0].reason_free_text).toContain('cyclical');
  });

  it('decisions are immutable at the database level', async () => {
    await expect(pool.query(`UPDATE decisions SET reason_free_text = 'edited'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(pool.query(`DELETE FROM decisions`)).rejects.toThrow(/append-only/);
  });

  it('marks a brief read via PATCH (read receipt)', async () => {
    const briefs = await inject({ method: 'GET', url: '/v1/briefs' });
    const id = briefs.json().data[0].id;
    const res = await inject({ method: 'PATCH', url: `/v1/briefs/${id}`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.read_at).toBeTruthy();
  });
});
