/**
 * Security headers (P0-4). The API shipped with none: no CSP, no nosniff, no
 * frame protection, no referrer policy.
 *
 * These assertions are deliberately about the headers a browser acts on, not
 * about helmet being registered — the point is the behaviour, and a
 * misconfigured plugin is registered too.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { migrate, resetDatabase } from '@atlas/schema';
import { buildServer } from '@atlas/api';

const TEST_URL =
  process.env.ATLAS_TEST_DATABASE_URL ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';

let pool: pg.Pool;
let app: FastifyInstance;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);
  app = await buildServer(pool);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const headers = async () => (await app.inject({ method: 'GET', url: '/healthz' })).headers;

describe('security headers', () => {
  it('cannot be framed — the clickjacking fix that matters most here', async () => {
    // A framed Atlas plus a session cookie is enough to drive the UI as the
    // user. frame-ancestors is the modern control; X-Frame-Options backs it up
    // for anything that predates CSP 2.
    const h = await headers();
    expect(String(h['content-security-policy'])).toContain("frame-ancestors 'none'");
    expect(h['x-frame-options']).toBeDefined();
  });

  it('sets a CSP with no unsafe-inline anywhere', async () => {
    const csp = String((await headers())['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    // Vite emits an external bundle and stylesheet; nothing here needs inline.
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('stops MIME sniffing and referrer leakage', async () => {
    const h = await headers();
    expect(h['x-content-type-options']).toBe('nosniff');
    // Paths and query strings here identify portfolios; no referrer, ever.
    expect(h['referrer-policy']).toBe('no-referrer');
  });

  it('omits HSTS on a plaintext origin and sends it when TLS is expected', async () => {
    // Asserting the negative matters: HSTS pinned from a dev origin would be a
    // self-inflicted outage on a machine that later serves plain HTTP.
    expect((await headers())['strict-transport-security']).toBeUndefined();

    process.env.ATLAS_COOKIE_SECURE = 'true';
    let tlsApp: FastifyInstance | undefined;
    try {
      tlsApp = await buildServer(pool);
      const res = await tlsApp.inject({ method: 'GET', url: '/healthz' });
      expect(String(res.headers['strict-transport-security'])).toContain('max-age=');
    } finally {
      await tlsApp?.close();
      delete process.env.ATLAS_COOKIE_SECURE;
    }
  });

  it('applies to error responses too, not just the happy path', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/portfolios' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
