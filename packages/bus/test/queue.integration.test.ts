/**
 * Job queue semantics (§24.4, §26.2) — and the lease that stops a dead worker
 * silencing a user forever (P0-3).
 *
 * The queue had no test file at all, which is how the orphan bug survived:
 * per-partition ordering was implemented and correct, and the state it could
 * get stuck in was never exercised.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate, resetDatabase } from '@atlas/schema';
import { claimJobs, completeJob, enqueue, failJob, queueStats } from '../src/index.js';

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

beforeEach(async () => {
  await pool.query('DELETE FROM job_queue');
});

/** claimJobs needs a client, not a pool — SKIP LOCKED is per-transaction. */
async function claim(limit = 10) {
  const client = await pool.connect();
  try {
    return await claimJobs(client, limit);
  } finally {
    client.release();
  }
}

/** Simulate a worker that died holding the job: no completion, lease expires. */
async function expireLease(jobId: string) {
  await pool.query(`UPDATE job_queue SET locked_until = now() - interval '1 minute' WHERE id = $1`, [
    jobId,
  ]);
}

describe('per-partition ordering (§24.4)', () => {
  it('claims one job per partition and holds the rest behind it', async () => {
    await enqueue(pool, 'a', 'user-1', { n: 1 });
    await enqueue(pool, 'a', 'user-1', { n: 2 });
    await enqueue(pool, 'a', 'user-2', { n: 3 });

    const claimed = await claim();
    expect(claimed.map((j) => j.payload.n).sort()).toEqual([1, 3]);
  });

  it('releases the next job in a partition once the first completes', async () => {
    await enqueue(pool, 'a', 'user-1', { n: 1 });
    await enqueue(pool, 'a', 'user-1', { n: 2 });

    const first = await claim();
    await completeJob(pool, first[0]!.id);
    const second = await claim();
    expect(second.map((j) => j.payload.n)).toEqual([2]);
  });
});

describe('lease recovery (P0-3)', () => {
  it('reclaims a job whose worker died', async () => {
    await enqueue(pool, 'a', 'user-1', { n: 1 });
    const [job] = await claim();
    expect(job).toBeDefined();

    // Still held: the lease is live.
    expect(await claim()).toEqual([]);

    await expireLease(job!.id);
    const again = await claim();
    expect(again.map((j) => j.payload.n)).toEqual([1]);
    // A reclaim is a retry and must be counted, or a poison job cycles forever.
    expect(again[0]!.attempts).toBe(1);
  });

  it('a dead worker no longer blocks its partition forever', async () => {
    // The bug, exactly: job 1 stuck in 'processing' meant job 2 for the same
    // user was never claimable again. No briefs, no radar fires, no weekly
    // review — indistinguishable from the product working correctly.
    await enqueue(pool, 'a', 'user-1', { n: 1 });
    await enqueue(pool, 'a', 'user-1', { n: 2 });

    const [stuck] = await claim();
    expect(stuck!.payload.n).toBe(1);
    expect(await claim()).toEqual([]); // correct while the lease is live

    await expireLease(stuck!.id);
    const recovered = await claim();
    expect(recovered.map((j) => j.payload.n).sort()).toEqual([1, 2]);
  });

  it('treats a pre-migration row with no lease as reclaimable', async () => {
    await enqueue(pool, 'a', 'user-1', { n: 1 });
    const [job] = await claim();
    // Rows stuck in 'processing' before migration 020 have locked_until NULL.
    await pool.query(`UPDATE job_queue SET locked_until = NULL WHERE id = $1`, [job!.id]);
    expect((await claim()).map((j) => j.payload.n)).toEqual([1]);
  });

  it('retires a job whose worker keeps dying instead of cycling it forever', async () => {
    await enqueue(pool, 'a', 'user-1', { n: 1 }, { maxAttempts: 2 });
    for (let i = 0; i < 4; i++) {
      const claimed = await claim();
      if (claimed.length === 0) break;
      await expireLease(claimed[0]!.id);
    }
    const stats = await queueStats(pool);
    expect(stats.dead).toBe(1);
    expect(stats.pending + stats.processing).toBe(0);

    // …and a dead job must not block its partition either.
    await enqueue(pool, 'a', 'user-1', { n: 2 });
    expect((await claim()).map((j) => j.payload.n)).toEqual([2]);
  });

  it('a completed job clears its lease', async () => {
    await enqueue(pool, 'a', 'user-1', { n: 1 });
    const [job] = await claim();
    await completeJob(pool, job!.id);
    const { rows } = await pool.query(`SELECT status, locked_until FROM job_queue WHERE id = $1`, [
      job!.id,
    ]);
    expect(rows[0].status).toBe('done');
    expect(rows[0].locked_until).toBeNull();
  });

  it('an explicit failure still backs off and dead-letters (§26.2)', async () => {
    await enqueue(pool, 'a', 'user-1', { n: 1 }, { maxAttempts: 1 });
    const [job] = await claim();
    await failJob(pool, job!, 'boom');
    const stats = await queueStats(pool);
    expect(stats.dead).toBe(1);
  });
});
