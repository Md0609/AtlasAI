-- 020_job_lease — orphaned jobs must not block a partition forever (P0-3).
--
-- claimJobs enforces per-partition ordering (§24.4) by refusing to claim a job
-- while an earlier one with the same partition_key is still 'pending' or
-- 'processing'. Nothing ever moved a job OUT of 'processing' except the worker
-- holding it, so a worker that died mid-job — deploy, OOM, crash — left the
-- row in 'processing' permanently and silently blocked every later job for
-- that user: no briefs, no radar fires, no weekly review. Forever.
--
-- The failure mode is indistinguishable from the product working correctly,
-- because the product's whole promise is that silence is deliberate.
--
-- A claim now takes a LEASE. A lease that expires makes the job claimable
-- again and stops it blocking its partition. At-least-once with idempotent
-- consumers is already the contract (D-010), and user-visible effects are
-- deduped at the effect boundary, so a job running twice after a crash is
-- safe by design.

ALTER TABLE job_queue ADD COLUMN locked_until timestamptz;

-- Rows already stuck in 'processing' when this migration runs have no lease.
-- NULL is treated as expired by the claim query, which is what recovers them.

-- Supports the "expired lease" half of the claim predicate.
CREATE INDEX job_queue_lease_idx ON job_queue (locked_until)
  WHERE status = 'processing';

COMMENT ON COLUMN job_queue.locked_until IS
  'Lease expiry for a claimed job. NULL or past means the claim is dead and the job is reclaimable (P0-3).';
