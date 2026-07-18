/**
 * Thesis Ledger + Radar integration (Phase 3): immutability at API and DB
 * level, auto-radar in the same transaction (F-14/§27.4), the deterministic
 * fire chain (price event → recompute → radar fires → thesis condition met),
 * edge-triggering, and auto-suppression (FR-7.6).
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
let userId = '';

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

/** Insert a next-day price bar and run the full worker chain (§24.2). */
async function priceMoveAndDrain(securityId: string, close: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT max(bar_date)::text AS d FROM price_bars WHERE security_id = $1`,
    [securityId],
  );
  const next = new Date(Date.parse(`${rows[0].d}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
  await pool.query(`SELECT ensure_price_bars_partition($1::date)`, [next]);
  await pool.query(
    `INSERT INTO price_bars (security_id, bar_date, open, high, low, close, adjusted_close, volume, currency, source)
     VALUES ($1,$2,$3,$3,$3,$3,$3, 1000, 'USD', 'test')`,
    [securityId, next, close],
  );
  await enqueue(pool, 'security.changed', securityId, { securityId });
  const { stats } = await buildRunner(pool).drain();
  expect(stats.dead).toBe(0);
}

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
    payload: { email: 'thesis@example.es', password: 'password1234', jurisdiction: 'ES', base_currency: 'EUR' },
  });
  userId = reg.json().id;
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
  await inject({
    method: 'POST',
    url: `/v1/portfolios/${portfolioId}/transactions`,
    payload: { type: 'buy', security_id: aaplId, trade_date: '2026-02-02', quantity: '100', price: '210', currency: 'USD' },
  });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('Thesis Ledger (§61.2, FR-4)', () => {
  let thesisId = '';

  it('creates a thesis whose falsification condition auto-generates a radar in the same txn (F-14)', async () => {
    const res = await inject({
      method: 'POST',
      url: '/v1/theses',
      payload: {
        security_id: aaplId,
        statement:
          'Services growth makes Apple a compounder; wrong if the market re-rates it below 150.',
        time_horizon_months: 60,
        confidence: 4,
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
    expect(res.statusCode).toBe(201);
    const d = res.json().data;
    thesisId = d.id;
    expect(d.radars_created.length).toBe(1);
    expect(d.radars_created[0].current.met).toBe(false); // AAPL trades well above 150
    expect(d.message).toContain("you don't have to remember");

    // §27.4: the radar exists in the same transaction as the thesis.
    const { rows } = await pool.query(
      `SELECT r.source, r.status FROM radars r
        JOIN thesis_conditions tc ON tc.radar_id = r.id WHERE tc.thesis_id = $1`,
      [thesisId],
    );
    expect(rows[0].source).toBe('thesis');
    expect(rows[0].status).toBe('active');
  });

  it('PATCH is 405: the API refuses to edit a belief (§31.2)', async () => {
    const res = await inject({
      method: 'PATCH',
      url: `/v1/theses/${thesisId}`,
      payload: { statement: 'actually I always knew' },
    });
    expect(res.statusCode).toBe(405);
    expect(res.json().type).toContain('thesis-immutable');
  });

  it('the DB refuses statement edits even if the API is bypassed', async () => {
    await expect(
      pool.query(`UPDATE theses SET statement = 'rewritten history' WHERE id = $1`, [thesisId]),
    ).rejects.toThrow(/immutable|closing/);
    await expect(pool.query(`DELETE FROM theses WHERE id = $1`, [thesisId])).rejects.toThrow(
      /never deleted/,
    );
  });

  it('only one active thesis per security; supersession versions it', async () => {
    const dup = await inject({
      method: 'POST',
      url: '/v1/theses',
      payload: { security_id: aaplId, statement: 'another view' },
    });
    expect(dup.statusCode).toBe(409);

    const v2 = await inject({
      method: 'POST',
      url: '/v1/theses',
      payload: {
        security_id: aaplId,
        statement: 'Still a compounder, but the bar moved: wrong below 170.',
        supersedes_id: thesisId,
        change_reason: 'Q2 results raised my floor',
        conditions: [
          {
            condition_nl: 'Wrong if the price closes below 170',
            condition: {
              metric: { kind: 'price', securityId: aaplId },
              operator: 'lt',
              target: { kind: 'literal', value: '170' },
            },
          },
        ],
      },
    });
    expect(v2.statusCode).toBe(201);
    expect(v2.json().data.version).toBe(2);

    const versions = await inject({ method: 'GET', url: `/v1/theses/${thesisId}/versions` });
    const list = versions.json().data;
    expect(list.length).toBe(2);
    expect(list[0].status).toBe('superseded');
    expect(list[0].statement).toContain('below 150'); // v1 text intact forever
    expect(list[1].status).toBe('active');

    // v1's radar is archived; v2's radar is live.
    const { rows } = await pool.query(
      `SELECT r.status, tc.thesis_id FROM radars r
        JOIN thesis_conditions tc ON tc.radar_id = r.id
        WHERE tc.thesis_id IN ($1, $2) ORDER BY r.created_at`,
      [thesisId, v2.json().data.id],
    );
    expect(rows[0].status).toBe('archived');
    expect(rows[1].status).toBe('active');
  });
});

describe('the deterministic money journey (Design §B2 M3)', () => {
  it('price event → recompute → radar fires → thesis condition met, with provenance and zero LLM', async () => {
    // The active v2 condition: price < 170. Drop AAPL to 165.
    await priceMoveAndDrain(aaplId, '165');

    const fires = await inject({ method: 'GET', url: '/v1/radar-fires' });
    const fire = fires.json().data.find((f: { source: string }) => f.source === 'thesis');
    expect(fire).toBeTruthy();
    expect(fire.condition_nl).toContain('below 170'); // the user's own words
    expect(Number(fire.observed.value)).toBeLessThan(170);
    expect(fire.observed.target).toBe('170');

    const theses = await inject({ method: 'GET', url: '/v1/theses?security_id=' + aaplId });
    const active = theses.json().data[0];
    expect(active.conditions[0].status).toBe('met');
    expect(active.conditions[0].met_at).toBeTruthy();
    // The thesis STATUS is untouched — that decision belongs to the user (P1).
    expect(active.status).toBe('active');
    // The thesis radar archived itself: the promise was kept.
    expect(active.conditions[0].radar.status).toBe('archived');

    // Events recorded: radar.fired and thesis.falsified (§24.2 chain).
    const { rows } = await pool.query(
      `SELECT type FROM events WHERE type IN ('radar.fired','thesis.falsified')`,
    );
    const types = new Set(rows.map((r) => r.type));
    expect(types.has('radar.fired')).toBe(true);
    expect(types.has('thesis.falsified')).toBe(true);
  });

  it('the user marks the thesis broken — recorded with a reason, radars closed', async () => {
    const theses = await inject({ method: 'GET', url: `/v1/theses?security_id=${aaplId}` });
    const id = theses.json().data[0].id;
    const res = await inject({
      method: 'POST',
      url: `/v1/theses/${id}/status`,
      payload: { status: 'falsified', reason: 'My own condition fired and the story has changed.' },
    });
    expect(res.statusCode).toBe(204);
    const after = await inject({ method: 'GET', url: `/v1/theses?security_id=${aaplId}&include_closed=true` });
    const closed = after.json().data.find((t: { id: string }) => t.id === id);
    expect(closed.status).toBe('falsified');
    expect(closed.status_reason).toContain('condition fired');
  });
});

describe('manual radars: edge-triggering and auto-suppression (§16.5)', () => {
  let radarId = '';

  it('creates a manual radar showing the current state at confirmation (§16.2)', async () => {
    const res = await inject({
      method: 'POST',
      url: '/v1/radars',
      payload: {
        name: 'AAPL gets cheap',
        security_id: aaplId,
        condition_nl: 'Tell me if Apple closes below 160',
        condition: {
          metric: { kind: 'price', securityId: aaplId },
          operator: 'lt',
          target: { kind: 'literal', value: '160' },
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const d = res.json().data;
    radarId = d.id;
    expect(d.rendered).toBe('price below 160');
    expect(d.current.met).toBe(false); // 165 right now
  });

  it('fires only on the false→true transition, and auto-suppresses after >3 fires in 30 days', async () => {
    // 4 down-crossings: each dip below 160 fires once; staying below re-arms
    // only after a recovery above.
    for (const px of ['155', '175', '150', '180', '158', '182', '152']) {
      await priceMoveAndDrain(aaplId, px);
    }
    const { rows: fireRows } = await pool.query(
      `SELECT count(*)::int AS n FROM radar_fires WHERE radar_id = $1`,
      [radarId],
    );
    expect(fireRows[0].n).toBe(4);

    const radars = await inject({ method: 'GET', url: '/v1/radars' });
    const r = radars.json().data.find((x: { id: string }) => x.id === radarId);
    expect(r.status).toBe('paused');
    expect(r.paused_reason).toContain('auto-suppressed');
  });

  it('resume re-arms the radar', async () => {
    const res = await inject({ method: 'POST', url: `/v1/radars/${radarId}/resume` });
    expect(res.statusCode).toBe(204);
    const radars = await inject({ method: 'GET', url: '/v1/radars' });
    const r = radars.json().data.find((x: { id: string }) => x.id === radarId);
    expect(r.status).toBe('active');
  });
});
