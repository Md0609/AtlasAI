/**
 * API entry point.
 *
 * Startup order is deliberate and each step gates the next:
 *
 *   1. validate configuration      — a misconfigured deploy must not start
 *   2. apply migrations            — N-4: serving against an old schema 500s
 *   3. install lifecycle handlers  — before listening, so the first SIGTERM is
 *                                    already handled
 *   4. listen
 *
 * Configuration used to be validated nowhere, migrations were applied by hand,
 * and there were no signal handlers at all. Measured before this: SIGTERM
 * during a 3s request gave `curl exit=52 http=000` — the connection severed
 * mid-response — and an unhandled rejection exited the process before a 500ms
 * timer could fire.
 */
import { ConfigError, assertConfig, boolEnv, intEnv, isProduction } from '@atlas/config';
import { installLifecycle } from '@atlas/lifecycle';
import { assertDatabaseConfig, createPool, migrate, pendingMigrations } from '@atlas/schema';
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
    () => intEnv('ATLAS_SHUTDOWN_GRACE_MS', { fallback: 10_000, min: 1 }),
    () => boolEnv('ATLAS_MIGRATE_ON_START', { fallback: true }),
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

/**
 * Migrate before serving (N-4).
 *
 * The dev database ran two migrations behind and every Copilot call returned
 * 500 until the CLI was run by hand. Nothing in the repository stated that
 * migrations must precede start, so nothing did it.
 *
 * Concurrency-safe: migrate() takes a Postgres advisory lock, so several
 * instances booting together serialise rather than race on the same DDL.
 *
 * Can be disabled for a deployment that runs migrations as a separate release
 * step — but the process still REFUSES to start with a schema behind the code,
 * because that is the failure this exists to prevent, not the mechanism.
 */
if (boolEnv('ATLAS_MIGRATE_ON_START', { fallback: true })) {
  const { applied } = await migrate(pool);
  if (applied.length > 0) console.log(`[startup] applied ${applied.length} migration(s)`);
} else {
  const pending = await pendingMigrations(pool);
  if (pending.length > 0) {
    console.error(
      `[startup] refusing to start: ${pending.length} unapplied migration(s): ${pending.join(', ')}. ` +
        'Run the migration step, or unset ATLAS_MIGRATE_ON_START to apply them here.',
    );
    await pool.end();
    process.exit(1);
  }
}

const app = await buildServer(pool);

// Installed BEFORE listen: a signal arriving during startup is still a signal,
// and the window without a handler is exactly when a deploy is most likely to
// send one.
installLifecycle({
  logger: app.log,
  tasks: [
    // Order matters. Stop accepting first, so in-flight requests can finish
    // against a pool that is still open; closing the pool first is what cuts
    // them off mid-statement.
    { name: 'http', run: () => app.close() },
    { name: 'database', run: () => pool.end() },
  ],
});

const port = intEnv('PORT', { fallback: 3000, min: 1, max: 65_535 });
await app.listen({ port, host: '0.0.0.0' });
console.log(`atlas api listening on :${port}`);
