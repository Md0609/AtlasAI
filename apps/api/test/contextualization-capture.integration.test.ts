/**
 * Every claim Atlas makes must be recorded (P0-8; FR-10.1, FR-12.4, §51.4).
 *
 * POST /v1/contextualize built the full intelligence document — sections,
 * signals, confidence, and `whatWouldChangeIt`, which is the falsifier set a
 * grader needs — serialised it to the client, and returned. A grep of the
 * handler for INSERT/recordEvent returned zero.
 *
 * §51.4 calls this the one MVP cut that cannot be undone: "retrofitting them
 * would mean the first 12 months of claims are ungradeable forever." The v1.1
 * Scorecard is a nightly job over this table. Nothing here builds the grader —
 * only the capture it will need.
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
import { buildRunner } from '@atlas/workers';

const TEST_URL =
  process.env.ATLAS_TEST_DATABASE_URL ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';

let pool: pg.Pool;
let app: FastifyInstance;
let cookie = '';
let userId = '';
let securityId = '';

const contextualize = () =>
  app.inject({
    method: 'POST',
    url: '/v1/contextualize',
    payload: { security_id: securityId } as never,
    headers: { 'content-type': 'application/json', cookie },
  });

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);
  await new IngestPipeline(pool, new MockVendorAdapter(), new CollectingEventSink()).run(
    SNAPSHOT_FROM,
    SNAPSHOT_TO,
  );
  app = await buildServer(pool);

  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      email: 'capture@example.es',
      password: 'password1234',
      jurisdiction: 'ES',
      base_currency: 'EUR',
    } as never,
    headers: { 'content-type': 'application/json' },
  });
  cookie = String(reg.headers['set-cookie']).split(';')[0]!;
  userId = reg.json().id;

  const { rows } = await pool.query(
    `SELECT security_id FROM listings WHERE ticker='AAPL' AND valid_to IS NULL LIMIT 1`,
  );
  securityId = rows[0].security_id;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('capture', () => {
  it('records the claim, not just returns it', async () => {
    const res = await contextualize();
    expect(res.statusCode).toBe(200);

    const { rows } = await pool.query(
      `SELECT * FROM contextualizations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].security_id).toBe(securityId);
  });

  it('keeps the falsifier set, which is what makes a claim gradeable at all', async () => {
    // Without `whatWouldChangeIt` there is no way to decide, a year later,
    // whether the claim turned out to be right. This is the column §51.4 is
    // actually about.
    const { rows } = await pool.query(
      `SELECT what_would_change_it, confidence_level FROM contextualizations
        WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    expect(rows[0].what_would_change_it).toBeDefined();
    expect(['high', 'medium', 'low', 'insufficient']).toContain(rows[0].confidence_level);
  });

  it('keeps what the user actually READ, which is not always the document', async () => {
    // FR-12.4 says reconstruct any output SHOWN. Egress may substitute a safe
    // fallback, so storing the doc alone would reconstruct something the user
    // never saw.
    const res = await contextualize();
    const shown = res.json().data.text;
    const { rows } = await pool.query(
      `SELECT rendered_text, output_hash FROM contextualizations
        WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    expect(rows[0].rendered_text).toBe(shown);
    expect(rows[0].output_hash).toMatch(/^[0-9a-f]{16,}$/);
  });

  it('records which guard and which model produced it', async () => {
    // A recalibration has to know what it is recalibrating.
    const { rows } = await pool.query(
      `SELECT guard_verdict, guard_ruleset_version, generator_agent,
              generator_prompt_version, generator_model, generative, degraded
         FROM contextualizations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    expect(rows[0].guard_verdict).toBe('approved');
    expect(rows[0].guard_ruleset_version).toBeTruthy();
    expect(rows[0].generator_agent).toBe('psa');
    expect(rows[0].generator_prompt_version).toBeTruthy();
    // N-7: the fixture writes the deterministic draft, so this claim is NOT
    // model analysis — recording it as such would corrupt the record the whole
    // calibration rests on.
    expect(rows[0].generative).toBe(false);
  });

  it('appends rather than replaces — two claims about one security are two rows', async () => {
    const before = Number(
      (await pool.query(`SELECT count(*)::int n FROM contextualizations WHERE user_id = $1`, [userId]))
        .rows[0].n,
    );
    await contextualize();
    const after = Number(
      (await pool.query(`SELECT count(*)::int n FROM contextualizations WHERE user_id = $1`, [userId]))
        .rows[0].n,
    );
    expect(after).toBe(before + 1);
  });
});

describe('immutability', () => {
  it('refuses an UPDATE — a claim Atlas cannot revise after the fact', async () => {
    // The whole point: Atlas must not be able to edit what it said once it
    // knows whether it was right.
    await expect(
      pool.query(`UPDATE contextualizations SET confidence_level = 'low' WHERE user_id = $1`, [userId]),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses a DELETE', async () => {
    await expect(
      pool.query(`DELETE FROM contextualizations WHERE user_id = $1`, [userId]),
    ).rejects.toThrow(/append-only/);
  });
});

describe('erasure', () => {
  it('severs the portfolio content but retains the calibration metadata', async () => {
    // Art. 17(3)(b): the row stays because it records what ATLAS claimed, but
    // doc, rendered_text and the falsifiers all describe this user's holdings
    // and must go. The stated cost is that these rows can no longer be graded
    // for correctness — only counted.
    // The grace period is read when the job is ENQUEUED, so it has to be set
    // before the request, not before the drain. Setting it after schedules the
    // erasure 30 days out and drain() correctly declines to run it.
    process.env.ATLAS_ERASURE_GRACE_DAYS = '0';
    try {
      const del = await app.inject({
        method: 'DELETE',
        url: '/v1/account',
        payload: { password: 'password1234' } as never,
        headers: { 'content-type': 'application/json', cookie },
      });
      expect(del.statusCode).toBe(202);
      await buildRunner(pool).drain();
    } finally {
      delete process.env.ATLAS_ERASURE_GRACE_DAYS;
    }

    const { rows } = await pool.query(
      `SELECT user_id, doc, rendered_text, what_would_change_it, confidence_level
         FROM contextualizations WHERE security_id = $1`,
      [securityId],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.user_id).toBeNull();
      expect(row.doc).toEqual({ pseudonymized: true });
      expect(row.rendered_text).toBe('[pseudonymized]');
      expect(row.what_would_change_it).toEqual({ pseudonymized: true });
      // Retained, because calibrating on declared confidence needs no identity.
      expect(row.confidence_level).toBeTruthy();
    }
  });
});
