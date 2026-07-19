/**
 * Auth hardening (architectural review P1): the session cookie carries the
 * right flags, and the credential endpoints — the brute-force surface — are
 * rate limited per IP.
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

const post = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, payload: payload as never, headers: { 'content-type': 'application/json' } });

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);
  // Tight limits so the test exercises the limiter in a few requests. Read at
  // route registration, so they must be set before buildServer().
  process.env.ATLAS_RATE_LIMIT_LOGIN = '3';
  process.env.ATLAS_RATE_LIMIT_REGISTER = '2';
  app = await buildServer(pool);
});

afterAll(async () => {
  delete process.env.ATLAS_RATE_LIMIT_LOGIN;
  delete process.env.ATLAS_RATE_LIMIT_REGISTER;
  await app.close();
  await pool.end();
});

describe('session cookie flags', () => {
  it('is httpOnly, SameSite=Lax and path-scoped', async () => {
    const res = await post('/v1/auth/register', {
      email: 'flags@example.es',
      password: 'password1234',
      jurisdiction: 'ES',
      base_currency: 'EUR',
    });
    expect(res.statusCode).toBe(201);
    const raw = res.headers['set-cookie'];
    const cookie = String(Array.isArray(raw) ? raw[0] : raw);
    expect(cookie).toContain('atlas_session=');
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//i);
  });

  it('omits Secure under HTTP (dev/test) and sets it when configured', async () => {
    // Default here (NODE_ENV is not production) ⇒ no Secure, so the cookie
    // still works over plaintext localhost.
    const res = await post('/v1/auth/login', { email: 'flags@example.es', password: 'password1234' });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).not.toMatch(/Secure/i);

    // With ATLAS_COOKIE_SECURE=true the flag is set — the production posture.
    process.env.ATLAS_COOKIE_SECURE = 'true';
    const secureRes = await post('/v1/auth/login', {
      email: 'flags@example.es',
      password: 'password1234',
    });
    expect(String(secureRes.headers['set-cookie'])).toMatch(/Secure/i);
    delete process.env.ATLAS_COOKIE_SECURE;
  });
});

describe('credential endpoints are rate limited (per IP)', () => {
  it('429s repeated login attempts past the limit', async () => {
    const attempt = () => post('/v1/auth/login', { email: 'nobody@example.es', password: 'wrongpassword' });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await attempt()).statusCode);

    // The window is shared with the cookie tests above, so don't assume how
    // many attempts remain — assert the shape: normal auth failures until the
    // limiter engages, and everything after it is refused.
    const first429 = codes.indexOf(429);
    expect(first429, `expected the limiter to engage, got ${codes.join(',')}`).toBeGreaterThan(-1);
    expect(codes.slice(0, first429).every((c) => c === 401)).toBe(true);
    expect(codes.slice(first429).every((c) => c === 429)).toBe(true);
  });

  it('429s repeated registrations past the limit', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await post('/v1/auth/register', {
        email: `flood${i}@example.es`,
        password: 'password1234',
        jurisdiction: 'ES',
        base_currency: 'EUR',
      });
      codes.push(res.statusCode);
    }
    // Limit is 2 here; 'flags@example.es' already consumed none of this window
    // (separate route counter), so two succeed then the limiter engages.
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
  });
});
