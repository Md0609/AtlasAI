/**
 * Worker runner (Phase 3, §25–§26): claims jobs from the Postgres queue and
 * dispatches to registered handlers.
 *
 * Principles enforced here (§25.3):
 *  - every handler is idempotent (at-least-once delivery, D-010);
 *  - a handler failure never throws out of the runner — it retries with
 *    backoff and dead-letters after max_attempts;
 *  - drain() runs until the queue is quiet, which makes the whole pipeline
 *    synchronously testable and gives the CLI a deterministic run-once mode.
 */
import pg from 'pg';
import { claimJobs, completeJob, failJob, queueStats, type Job } from '@atlas/bus';

export type JobHandler = (pool: pg.Pool, job: Job) => Promise<void>;

export class WorkerRunner {
  private readonly handlers = new Map<string, JobHandler>();

  constructor(private readonly pool: pg.Pool) {}

  register(topic: string, handler: JobHandler): this {
    if (this.handlers.has(topic)) throw new Error(`duplicate handler for topic ${topic}`);
    this.handlers.set(topic, handler);
    return this;
  }

  /** Process one batch. Returns the number of jobs handled. */
  async tick(batchSize = 16): Promise<number> {
    const client = await this.pool.connect();
    let jobs: Job[];
    try {
      await client.query('BEGIN');
      jobs = await claimJobs(client, batchSize);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    for (const job of jobs) {
      const handler = this.handlers.get(job.topic);
      if (!handler) {
        await failJob(this.pool, job, `no handler registered for topic ${job.topic}`);
        continue;
      }
      try {
        await handler(this.pool, job);
        await completeJob(this.pool, job.id);
      } catch (err) {
        await failJob(this.pool, job, (err as Error).stack ?? String(err));
      }
    }
    return jobs.length;
  }

  /**
   * Run until the queue is quiet (no runnable jobs). Retryable jobs whose
   * backoff pushes them into the future are left for the next drain — a
   * drain must terminate even when a job keeps failing.
   */
  async drain(maxTicks = 1000): Promise<{ processed: number; stats: Awaited<ReturnType<typeof queueStats>> }> {
    let processed = 0;
    for (let i = 0; i < maxTicks; i++) {
      const n = await this.tick();
      processed += n;
      if (n === 0) break;
    }
    return { processed, stats: await queueStats(this.pool) };
  }
}
