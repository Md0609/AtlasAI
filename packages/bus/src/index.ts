/**
 * @atlas/bus — the event log + Postgres-backed job queue (Phase 3, §24–§26).
 *
 * This is the seam for the §41.6 Kafka migration: producers call emitEvent /
 * enqueue, consumers claim through claimJobs. Nothing outside this package
 * touches the events or job_queue tables directly.
 *
 * Semantics (D-010): at-least-once delivery, idempotent consumers, per-
 * partition-key ordering at claim time. User-visible effects are deduped at
 * the effect boundary (notification_dedup_ledger), not here.
 */
import type pg from 'pg';
import type { DomainEvent } from '@atlas/contracts';

/** Anything with .query — a Pool, or a PoolClient inside a transaction. */
export type Db = pg.Pool | pg.PoolClient;

// ---------------------------------------------------------------------------
// Event log (§24.5: append-only; §24.4: partition_key = the ordering entity)
// ---------------------------------------------------------------------------

export function partitionKeyFor(event: DomainEvent): string {
  switch (event.type) {
    case 'market.price.eod':
    case 'corporate.action':
      return event.securityId;
    case 'fund.holdings.updated':
      return event.fundSecurityId;
    case 'signal.recomputed':
      return event.portfolioId;
    case 'radar.fired':
    case 'thesis.falsified':
      return event.userId;
    default:
      return 'global';
  }
}

/**
 * Record an event in the log. Callers that need derived work enqueue jobs in
 * the same transaction — recording and routing are one atomic step.
 */
export async function recordEvent(db: Db, event: DomainEvent): Promise<void> {
  await db.query('SELECT ensure_events_partition(now())');
  await db.query(
    `INSERT INTO events (event_id, type, occurred_at, partition_key, payload)
     VALUES ($1,$2,$3,$4,$5)`,
    [event.eventId, event.type, event.occurredAt, partitionKeyFor(event), JSON.stringify(event)],
  );
}

// ---------------------------------------------------------------------------
// Job queue (§26)
// ---------------------------------------------------------------------------

export interface Job {
  id: string; // bigint as string
  topic: string;
  partitionKey: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

export async function enqueue(
  db: Db,
  topic: string,
  partitionKey: string,
  payload: Record<string, unknown>,
  opts: { runAfter?: Date; maxAttempts?: number } = {},
): Promise<void> {
  await db.query(
    `INSERT INTO job_queue (topic, partition_key, payload, run_after, max_attempts)
     VALUES ($1,$2,$3, COALESCE($4, now()), COALESCE($5, 5))`,
    [topic, partitionKey, JSON.stringify(payload), opts.runAfter ?? null, opts.maxAttempts ?? null],
  );
}

/**
 * Claim up to `limit` runnable jobs. Per-entity ordering (§24.4): a job is
 * only claimable when no earlier job with the same partition_key is still
 * pending or processing. SKIP LOCKED keeps concurrent workers from fighting.
 */
export async function claimJobs(client: pg.PoolClient, limit: number): Promise<Job[]> {
  const { rows } = await client.query(
    `UPDATE job_queue SET status = 'processing', updated_at = now()
      WHERE id IN (
        SELECT j.id FROM job_queue j
         WHERE j.status = 'pending' AND j.run_after <= now()
           AND NOT EXISTS (
             SELECT 1 FROM job_queue e
              WHERE e.partition_key = j.partition_key
                AND e.id < j.id
                AND e.status IN ('pending','processing')
           )
         ORDER BY j.id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id::text, topic, partition_key, payload, attempts, max_attempts`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    topic: r.topic,
    partitionKey: r.partition_key,
    payload: r.payload,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
  }));
}

export async function completeJob(db: Db, jobId: string): Promise<void> {
  await db.query(`UPDATE job_queue SET status = 'done', updated_at = now() WHERE id = $1`, [jobId]);
}

/** Exponential backoff; dead-letter after max_attempts (§26.2 DLQ). */
export async function failJob(db: Db, job: Job, error: string): Promise<void> {
  const attempts = job.attempts + 1;
  if (attempts >= job.maxAttempts) {
    await db.query(
      `UPDATE job_queue SET status = 'dead', attempts = $2, last_error = $3, updated_at = now()
        WHERE id = $1`,
      [job.id, attempts, error.slice(0, 2000)],
    );
    return;
  }
  const backoffSeconds = 2 ** attempts;
  await db.query(
    `UPDATE job_queue
        SET status = 'pending', attempts = $2, last_error = $3,
            run_after = now() + ($4 || ' seconds')::interval, updated_at = now()
      WHERE id = $1`,
    [job.id, attempts, error.slice(0, 2000), String(backoffSeconds)],
  );
}

export interface QueueStats {
  pending: number;
  processing: number;
  dead: number;
}

export { routeEvents } from './routing.js';

export async function queueStats(db: Db): Promise<QueueStats> {
  const { rows } = await db.query(
    `SELECT status, count(*)::int AS n FROM job_queue GROUP BY status`,
  );
  const by = new Map(rows.map((r) => [r.status, r.n]));
  return {
    pending: by.get('pending') ?? 0,
    processing: by.get('processing') ?? 0,
    dead: by.get('dead') ?? 0,
  };
}
