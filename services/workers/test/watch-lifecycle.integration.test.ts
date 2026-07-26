/**
 * The worker process must run, sweep, and stop on a signal (P0-5, P0-6).
 *
 * Two defects, one process:
 *
 *   * `npm run workers` was `drain` — process until quiet, then EXIT. Nothing
 *     would ever handle a job enqueued a second later, and nothing anywhere
 *     called scheduleWeeklyReviews outside tests, so no user would have
 *     received a Weekly Review at all.
 *   * `watch` was an unbreakable `while (true)` with no signal handling. SIGTERM
 *     killed it mid-job and its `finally` — which closes the pool — was
 *     unreachable.
 *
 * This spawns the real CLI rather than importing it, because the thing under
 * test is process behaviour: signal handling, exit code, and the loop actually
 * terminating. An in-process test could not fail the way production did.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate, resetDatabase } from '@atlas/schema';

const TEST_URL =
  process.env.ATLAS_TEST_DATABASE_URL ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = resolve(ROOT, 'services/workers/dist/cli.js');

let pool: pg.Pool;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);
});

afterAll(async () => {
  await pool.end();
});

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  out: string;
}

/** Spawn the CLI, wait for it to be up, send a signal, and collect the result. */
function runWatch(signal: NodeJS.Signals, afterMs: number): Promise<Run> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [CLI, 'watch'], {
      cwd: ROOT,
      env: {
        ...process.env,
        ATLAS_DATABASE_URL: TEST_URL,
        ATLAS_LOG: 'off',
        // Sweep immediately so the test does not wait a minute for evidence.
        ATLAS_SWEEP_INTERVAL_MS: '1000',
        ATLAS_SHUTDOWN_GRACE_MS: '5000',
      },
    });

    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (out += String(d)));
    child.on('error', rejectRun);
    child.on('exit', (code, sig) => resolveRun({ code, signal: sig, out }));

    setTimeout(() => child.kill(signal), afterMs);
    // Backstop: if the loop never stops, fail loudly rather than hang the suite.
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        rejectRun(new Error(`worker did not exit within 12s of ${signal}\n${out}`));
      }
    }, 12_000);
  });
}

describe('worker watch mode', () => {
  it('starts, and stops cleanly on SIGTERM', async () => {
    const run = await runWatch('SIGTERM', 2_500);

    expect(run.out).toContain('workers: watching');
    // The loop broke rather than the process being killed: this line is printed
    // after the while() exits, and was unreachable before.
    expect(run.out).toContain('workers: loop stopped');
    // A deploy is not a fault.
    expect(run.code).toBe(0);
    expect(run.signal).toBeNull();
  }, 30_000);

  it('stops cleanly on SIGINT too', async () => {
    const run = await runWatch('SIGINT', 2_000);
    expect(run.out).toContain('workers: loop stopped');
    expect(run.code).toBe(0);
  }, 30_000);

  it('refuses to start when the schema is behind (N-4)', async () => {
    const { rows } = await pool.query(
      `SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1`,
    );
    const latest = rows[0].name as string;
    await pool.query(`DELETE FROM schema_migrations WHERE name = $1`, [latest]);

    try {
      const run = await new Promise<Run>((resolveRun, rejectRun) => {
        const child = spawn(process.execPath, [CLI, 'watch'], {
          cwd: ROOT,
          env: { ...process.env, ATLAS_DATABASE_URL: TEST_URL, ATLAS_LOG: 'off' },
        });
        let out = '';
        child.stdout.on('data', (d) => (out += String(d)));
        child.stderr.on('data', (d) => (out += String(d)));
        child.on('error', rejectRun);
        child.on('exit', (code, sig) => resolveRun({ code, signal: sig, out }));
      });

      // Refusing beats processing jobs against a schema the code does not
      // expect — which is how the dev database served 500s until someone
      // noticed.
      expect(run.code).toBe(1);
      expect(run.out).toContain('unapplied migration');
      expect(run.out).toContain(latest);
    } finally {
      await pool.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [latest]);
    }
  }, 30_000);
});
