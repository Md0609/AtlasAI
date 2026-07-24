/**
 * Observability (P0-2). The server previously ran with `logger: false`: the
 * trace_id handed to users in every problem+json pointed at nothing on our
 * side, so a user could quote one and we had no way to look it up.
 *
 * These tests care about two things above all: that the correlation actually
 * works end to end, and that turning logging on did not turn PII logging on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { Writable } from 'node:stream';
import { migrate, resetDatabase } from '@atlas/schema';
import { buildServer } from '@atlas/api';

const TEST_URL =
  process.env.ATLAS_TEST_DATABASE_URL ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';

let pool: pg.Pool;
let app: FastifyInstance;
/** Every line pino writes during the suite. */
const logLines: string[] = [];

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);

  const sink = new Writable({
    write(chunk, _enc, cb) {
      logLines.push(String(chunk));
      cb();
    },
  });
  app = await buildServer(pool, { logStream: sink });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const lines = () => logLines.join('\n');

describe('structured logging', () => {
  it('logs a request with its traceId, and that traceId is the one the user is given', async () => {
    // Force an error response so the body carries a trace_id.
    const res = await app.inject({ method: 'GET', url: '/v1/portfolios' });
    expect(res.statusCode).toBe(401);
    const traceId = res.json().trace_id;
    expect(traceId).toMatch(/^[0-9a-f-]{36}$/);

    // The same id must appear in the log, or the correlation is theatre.
    expect(lines()).toContain(traceId);
  });

  it('never writes a password to the log', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'logged@example.es',
        password: 'sup3rsecret-canary',
        jurisdiction: 'ES',
        base_currency: 'EUR',
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(lines()).not.toContain('sup3rsecret-canary');
  });

  it('never writes a session cookie to the log', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'cookie@example.es',
        password: 'password1234',
        jurisdiction: 'ES',
        base_currency: 'EUR',
      },
      headers: { 'content-type': 'application/json' },
    });
    const cookie = String(reg.headers['set-cookie']).split(';')[0]!;
    const token = cookie.split('=')[1]!;
    await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });

    // A session token in a log is a session token in whatever ships the logs.
    expect(token.length).toBeGreaterThan(20);
    expect(lines()).not.toContain(token);
  });

  it('does not log the query string, where portfolio ids live', async () => {
    await app.inject({ method: 'GET', url: '/v1/profile/scenarios?capital_band=%3C25k' });
    expect(lines()).not.toContain('capital_band=');
  });
});

describe('/metrics', () => {
  it('is absent unless a scrape token is configured', async () => {
    delete process.env.ATLAS_METRICS_TOKEN;
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(404);
  });

  it('requires the token, and exposes counters plus queue depth with it', async () => {
    process.env.ATLAS_METRICS_TOKEN = 'scrape-me';
    try {
      const noAuth = await app.inject({ method: 'GET', url: '/metrics' });
      expect(noAuth.statusCode).toBe(401);

      const wrong = await app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: 'Bearer nope' },
      });
      expect(wrong.statusCode).toBe(401);

      const ok = await app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: 'Bearer scrape-me' },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.body).toContain('atlas_http_requests_total');
      // Queue depth is read from the database, not from a counter that a
      // restart would clear — a stuck queue must survive the restart it caused.
      expect(ok.body).toContain('atlas_job_queue_depth{status="dead"}');
    } finally {
      delete process.env.ATLAS_METRICS_TOKEN;
    }
  });

  it('exposes no per-user dimension — counters are aggregate only (§35)', async () => {
    process.env.ATLAS_METRICS_TOKEN = 'scrape-me';
    try {
      const ok = await app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: 'Bearer scrape-me' },
      });
      expect(ok.body).not.toMatch(/user_id|user="|email/);
    } finally {
      delete process.env.ATLAS_METRICS_TOKEN;
    }
  });
});
