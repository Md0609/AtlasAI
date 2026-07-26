/**
 * @atlas/schema — single source of DB schema + migrations (Design §B3).
 * Plain-SQL forward migrations tracked in schema_migrations.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import {
  ConfigError,
  DEV_DATABASE_URL,
  intEnv,
  isProduction,
  postgresUrlEnv,
} from '@atlas/config';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(HERE, '..', 'migrations');

export function connectionString(): string {
  // The development fallback stays: requiring a URL to run the suite would be
  // the wrong trade. What changed is that production must not reach it — see
  // assertDatabaseConfig, called from every process entry point.
  return postgresUrlEnv('ATLAS_DATABASE_URL', { fallback: DEV_DATABASE_URL });
}

/**
 * Refuse to start against the published development database, or with no URL
 * at all, in production. Those credentials are in this repository and in every
 * developer's shell history; reaching a real deployment is a compromise, not a
 * slip.
 */
export function assertDatabaseConfig(): void {
  if (!isProduction()) return;
  const url = process.env.ATLAS_DATABASE_URL;
  if (!url) throw new ConfigError('ATLAS_DATABASE_URL is required in production');
  postgresUrlEnv('ATLAS_DATABASE_URL');
  if (url === DEV_DATABASE_URL) {
    throw new ConfigError(
      'ATLAS_DATABASE_URL is the published development database. Refusing to start in production.',
    );
  }
}

export function createPool(url?: string): pg.Pool {
  return new pg.Pool({
    connectionString: url ?? connectionString(),
    max: intEnv('ATLAS_DB_POOL_MAX', { fallback: 10, min: 1, max: 100 }),
  });
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * A fixed key for the migration advisory lock. Any constant works; it only has
 * to be the same in every process.
 */
const MIGRATION_LOCK_KEY = 4_317_002_001;

export async function migrate(pool: pg.Pool): Promise<MigrationResult> {
  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    // Serialise migrations across processes (P1-15). This became a requirement
    // rather than a nicety when the API started migrating on boot: two
    // instances starting together would otherwise read the same pending set and
    // race on the same DDL. The lock is session-scoped and released in the
    // finally below, including on failure.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const { rows } = await client.query(
        'SELECT 1 FROM schema_migrations WHERE name = $1',
        [file],
      );
      if (rows.length > 0) {
        skipped.push(file);
        continue;
      }
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    return { applied, skipped };
  } finally {
    // The lock dies with the session anyway, but releasing it explicitly frees
    // the next process immediately instead of at pool recycle. A failure here
    // must not mask an error already propagating.
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

/**
 * Migration files that have not been applied. Used by the readiness probe: a
 * process serving traffic against a schema it does not expect is a subtler
 * outage than one that refuses to report ready.
 */
export async function pendingMigrations(pool: pg.Pool): Promise<string[]> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  return files.filter((f) => !applied.has(f));
}

/** Drop and recreate the public schema — test databases only. */
export async function resetDatabase(pool: pg.Pool): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}
