/**
 * API entry point.
 *
 * Configuration is validated BEFORE anything is constructed. A misconfigured
 * deploy used to start successfully and behave wrongly — the database falling
 * back to a published development instance, the LLM falling back to a mock, a
 * non-numeric grace period becoming an Invalid Date in a GDPR deadline. Each of
 * those is now a startup failure with the reason named.
 *
 * Every problem is reported at once, because fixing a misconfigured deploy one
 * restart at a time is its own outage.
 */
import { ConfigError, assertConfig, intEnv, isProduction } from '@atlas/config';
import { assertDatabaseConfig, createPool } from '@atlas/schema';
import { getProvider } from '@atlas/runtime';
import { buildServer } from './server.js';
import { tlsExpected } from './auth.js';

try {
  assertConfig([
    assertDatabaseConfig,
    // Selecting the provider IS the check: an absent or unrecognised value
    // throws rather than silently becoming the deterministic fixture (P0-1).
    () => getProvider(),
    () => intEnv('PORT', { fallback: 3000, min: 1, max: 65_535 }),
    () => intEnv('ATLAS_ERASURE_GRACE_DAYS', { fallback: 30, min: 0, max: 30 }),
    () => intEnv('ATLAS_LLM_TIMEOUT_MS', { fallback: 30_000, min: 1 }),
    () => intEnv('ATLAS_RATE_LIMIT_LOGIN', { fallback: 20, min: 1 }),
    () => intEnv('ATLAS_RATE_LIMIT_REGISTER', { fallback: 10, min: 1 }),
    () => intEnv('ATLAS_DB_POOL_MAX', { fallback: 10, min: 1, max: 100 }),
    // Reads ATLAS_COOKIE_SECURE, which decides both the cookie's Secure flag
    // and HSTS. `TRUE` and `1` used to parse as false, silently.
    () => tlsExpected(),
    () => {
      // Not fatal: a deployment may legitimately not expose metrics. Worth
      // saying out loud, because a 404 from /metrics and an unset token are
      // indistinguishable to whoever is configuring the scraper.
      if (isProduction() && !process.env.ATLAS_METRICS_TOKEN) {
        console.warn('[config] ATLAS_METRICS_TOKEN is not set — /metrics will 404.');
      }
    },
  ]);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const pool = createPool();
const app = await buildServer(pool);
const port = intEnv('PORT', { fallback: 3000, min: 1, max: 65_535 });
await app.listen({ port, host: '0.0.0.0' });
console.log(`atlas api listening on :${port}`);
