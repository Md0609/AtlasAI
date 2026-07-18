-- 007_events_queue — Phase 3 ("Commitment loop", Design §B1): the event log
-- and the Postgres-backed job queue.
--
--  - §24.5: events are immutable, append-only, and ARE the audit log for
--    world/derived events. Partitioned by month (§27.3.6), 7y retention.
--  - §24.4: ordering is per-entity, not global — every event and job carries
--    a partition_key (security_id or user_id) and consumers serialize on it.
--  - D-011/§41.6: queues are Postgres tables until ~10k users; the interface
--    in @atlas/bus is the migration seam to Kafka.

CREATE TABLE events (
  id            bigint GENERATED ALWAYS AS IDENTITY,
  event_id      text NOT NULL,        -- deterministic where possible (§24.3 dedup)
  type          text NOT NULL,
  occurred_at   timestamptz NOT NULL,
  partition_key text NOT NULL,        -- §24.4: security_id | user_id | 'global'
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, recorded_at)
) PARTITION BY RANGE (recorded_at);

CREATE INDEX events_type_idx ON events (type, recorded_at);
CREATE INDEX events_partition_idx ON events (partition_key, recorded_at);
-- Partitioned tables cannot carry a global unique on event_id alone; consumers
-- are idempotent (§24.3 at-least-once) so duplicate recording is tolerated.
CREATE INDEX events_event_id_idx ON events (event_id);

CREATE OR REPLACE FUNCTION ensure_events_partition(d timestamptz) RETURNS void AS $$
DECLARE
  month_start date := date_trunc('month', d)::date;
  month_end   date := (date_trunc('month', d) + interval '1 month')::date;
  part_name   text := 'events_' || to_char(month_start, 'YYYY_MM');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF events FOR VALUES FROM (%L) TO (%L)',
      part_name, month_start, month_end
    );
  END IF;
END $$ LANGUAGE plpgsql;

-- Append-only, structurally (§24.5): same trigger discipline as audit_log.
CREATE TRIGGER events_no_mutation BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- Job queue (§26): claimed with FOR UPDATE SKIP LOCKED; per-partition-key
-- ordering enforced at claim time; retry with exponential backoff; dead-letter
-- state after max_attempts (§26.2).
-- ---------------------------------------------------------------------------

CREATE TABLE job_queue (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic         text NOT NULL,
  partition_key text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','done','failed','dead')),
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 5,
  run_after     timestamptz NOT NULL DEFAULT now(),
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_queue_claim_idx ON job_queue (status, run_after) WHERE status = 'pending';
CREATE INDEX job_queue_partition_idx ON job_queue (partition_key, id);
