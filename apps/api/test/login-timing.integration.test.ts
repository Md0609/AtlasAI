/**
 * Login must not leak account existence through the clock (P1-1).
 *
 * The response body was already generic ("Invalid email or password"). The
 * timing was not: an unknown email returned before argon2 ran at all, so a
 * miss answered in ~0.1ms while a real account took ~28ms. Measured at 388x —
 * enough to enumerate an entire user base cheaply and silently, and the kind of
 * list that gets sold on precisely because the accounts are known to be real.
 *
 * This lives in its own file because the rate limit in auth-hardening is set
 * to 3 attempts, and a timing measurement needs samples.
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

const KNOWN = 'known-account@example.es';
const UNKNOWN = 'no-such-account@example.es';

const login = (email: string) =>
  app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: 'definitely-the-wrong-password' } as never,
    headers: { 'content-type': 'application/json' },
  });

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);
  // The limiter would otherwise 429 the samples and flatten both curves to the
  // same near-zero, which would make this test pass for the wrong reason.
  process.env.ATLAS_RATE_LIMIT_LOGIN = '100000';
  app = await buildServer(pool);
  await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: KNOWN, password: 'password1234', jurisdiction: 'ES', base_currency: 'EUR' } as never,
    headers: { 'content-type': 'application/json' },
  });
});

afterAll(async () => {
  delete process.env.ATLAS_RATE_LIMIT_LOGIN;
  await app.close();
  await pool.end();
});

/** Median, not mean: one scheduler hiccup should not decide a security test. */
async function medianMs(email: string, runs = 15): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const started = process.hrtime.bigint();
    await login(email);
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}

describe('login timing', () => {
  it('answers a wrong password in the same time whether or not the account exists', async () => {
    // Warm up: the decoy hash is computed lazily once, and that one-off cost
    // belongs to neither measurement.
    await login(UNKNOWN);
    await login(KNOWN);

    const known = await medianMs(KNOWN);
    const unknown = await medianMs(UNKNOWN);
    const ratio = Math.max(known, unknown) / Math.min(known, unknown);

    // Both paths now run argon2. The threshold is deliberately loose — this
    // asserts "no oracle", not "identical clocks", and CI machines are noisy.
    // The bug it guards against measured 388x; anything near 1x is correct.
    expect(ratio).toBeLessThan(3);
    // Sanity: if argon2 were skipped on BOTH paths this test would pass
    // vacuously, so pin that real work happened.
    expect(Math.min(known, unknown)).toBeGreaterThan(1);
  });

  it('still rejects both, with an identical generic response', async () => {
    const a = await login(KNOWN);
    const b = await login(UNKNOWN);
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json().title).toBe(b.json().title);
  });

  it('a correct password still logs in', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: KNOWN, password: 'password1234' } as never,
      headers: { 'content-type': 'application/json' },
    });
    expect(ok.statusCode).toBe(200);
    expect(String(ok.headers['set-cookie'])).toContain('atlas_session=');
  });
});
