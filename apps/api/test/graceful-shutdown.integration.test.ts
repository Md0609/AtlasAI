/**
 * Closing the server must finish what it started (P0-6 / N-6).
 *
 * Measured against a real listening server before this:
 *
 *   SIGTERM during a 3s request -> curl exit=52 http=000
 *
 * The connection was severed mid-response. Every deploy did that to whatever
 * was in flight, including SSE Copilot streams and multi-statement writes.
 *
 * The fix was not the signal handler alone. With handlers installed the request
 * STILL died, because Fastify's close() returned in 2ms without waiting. On
 * Fastify 5.10, with a request in flight:
 *
 *   forceCloseConnections default -> close 2ms, request dies
 *   forceCloseConnections 'idle'  -> close 2ms, request dies
 *   forceCloseConnections false   -> close waits, request completes
 *
 * Once the body has been read, Fastify counts a socket as idle even though
 * nobody has answered it yet.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { migrate, resetDatabase } from '@atlas/schema';
import { buildServer } from '@atlas/api';

const TEST_URL =
  process.env.ATLAS_TEST_DATABASE_URL ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';

let pool: pg.Pool;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('close() drains in-flight requests', () => {
  it('finishes a slow request instead of severing it', async () => {
    const app: FastifyInstance = await buildServer(pool);
    app.get('/slow-test', async () => {
      await new Promise((r) => setTimeout(r, 600));
      return { ok: true };
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    // Start the request, let it get into the handler, then close.
    // `Connection: close` isolates the property under test. With keep-alive the
    // socket lingers after the response and close() waits it out — measured at
    // 71s — which is real production behaviour bounded by the shutdown grace
    // timeout, but it is not what this test is about.
    const inFlight = fetch(`http://127.0.0.1:${port}/slow-test`, {
      headers: { connection: 'close' },
    }).then(
      (r) => r.status,
      (e: { cause?: { code?: string } }) => `ERR:${e.cause?.code ?? 'unknown'}`,
    );
    await new Promise((r) => setTimeout(r, 150));

    await app.close();

    // The load-bearing assertion. This was ERR:UND_ERR_SOCKET before.
    expect(await inFlight).toBe(200);
  });

  it('is the forceCloseConnections setting doing it, not luck', async () => {
    // Pin the mechanism, so an upgrade that changes the default is caught here
    // rather than by a user losing a response during a deploy.
    const app = await buildServer(pool);
    try {
      expect(app.initialConfig.forceCloseConnections).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('the default really would have severed it — the setting is load-bearing', async () => {
    // A bare Fastify with the default, same shape of test. If this ever starts
    // returning 200, the workaround can be revisited.
    const bare = Fastify({ logger: false });
    bare.get('/slow-test', async () => {
      await new Promise((r) => setTimeout(r, 600));
      return { ok: true };
    });
    await bare.listen({ port: 0, host: '127.0.0.1' });
    const addr = bare.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const inFlight = fetch(`http://127.0.0.1:${port}/slow-test`, {
      headers: { connection: 'close' },
    }).then(
      (r) => r.status,
      (e: { cause?: { code?: string } }) => `ERR:${e.cause?.code ?? 'unknown'}`,
    );
    await new Promise((r) => setTimeout(r, 150));
    await bare.close();

    expect(await inFlight).not.toBe(200);
  });
});

describe('readiness', () => {
  it('reports ready when the schema is current', async () => {
    const app = await buildServer(pool);
    try {
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(200);
      expect(res.json().ready).toBe(true);
      expect(res.json().checks.migrations).toBe('ok');
    } finally {
      await app.close();
    }
  });

  it('refuses readiness when a migration has not been applied (N-4)', async () => {
    // The failure this exists for: the dev database ran two migrations behind
    // and every Copilot call returned 500 until someone ran the CLI by hand.
    // A process serving traffic against a schema it does not expect is a
    // subtler outage than one that declines to report ready.
    const { rows } = await pool.query(
      `SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1`,
    );
    const latest = rows[0].name as string;
    await pool.query(`DELETE FROM schema_migrations WHERE name = $1`, [latest]);

    const app = await buildServer(pool);
    try {
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(503);
      expect(res.json().ready).toBe(false);
      expect(res.json().checks.migrations).toContain(latest);
    } finally {
      await app.close();
      await pool.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [latest]);
    }
  });

  it('liveness stays shallow — it must not restart the app when the DB blinks', async () => {
    // A liveness probe that checks dependencies turns a brief database outage
    // into a restart loop.
    const app = await buildServer(pool);
    try {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });
});
