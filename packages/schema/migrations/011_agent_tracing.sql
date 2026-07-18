-- 011_agent_tracing — Phase 4a: agent message log (§23.4/§36) and per-tenant
-- cost accounting (§37.3). Built BEFORE any agent exists: retrofitting the
-- trace under a live intelligence plane is how reconstruction fails.

CREATE TABLE agent_messages (
  id              bigint GENERATED ALWAYS AS IDENTITY,
  trace_id        text NOT NULL,
  span_id         text NOT NULL,
  parent_span_id  text,
  user_id         uuid,                 -- null for shared Layer-1 work (§21.2)
  agent           text NOT NULL,
  prompt_version  text NOT NULL,
  prompt_hash     text NOT NULL,
  model           text NOT NULL,
  model_version   text NOT NULL DEFAULT '',
  input_hash      text NOT NULL,        -- cache key + reproducibility (§23.4)
  output          jsonb NOT NULL DEFAULT '{}'::jsonb,
  gaps            jsonb NOT NULL DEFAULT '[]'::jsonb,
  input_tokens    integer NOT NULL DEFAULT 0,
  output_tokens   integer NOT NULL DEFAULT 0,
  cost_eur        numeric NOT NULL DEFAULT 0,
  latency_ms      integer NOT NULL DEFAULT 0,
  cache_hit       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX agent_messages_trace_idx ON agent_messages (trace_id, created_at);
CREATE INDEX agent_messages_user_idx ON agent_messages (user_id, created_at);

CREATE OR REPLACE FUNCTION ensure_agent_messages_partition(d timestamptz) RETURNS void AS $$
DECLARE
  month_start date := date_trunc('month', d)::date;
  month_end   date := (date_trunc('month', d) + interval '1 month')::date;
  part_name   text := 'agent_messages_' || to_char(month_start, 'YYYY_MM');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF agent_messages FOR VALUES FROM (%L) TO (%L)',
      part_name, month_start, month_end
    );
  END IF;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER agent_messages_no_mutation BEFORE UPDATE OR DELETE ON agent_messages
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- §37.3: cost ceilings are enforced, not aspirational. One row per
-- (user, day, surface); the runtime checks ceilings BEFORE spending.
CREATE TABLE cost_ledger (
  user_id    uuid NOT NULL REFERENCES users(id),
  day_bucket date NOT NULL,
  surface    text NOT NULL,             -- e.g. 'brief_narration', 'copilot', 'deep_analysis'
  eur        numeric NOT NULL DEFAULT 0 CHECK (eur >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day_bucket, surface)
);
CREATE INDEX cost_ledger_day_idx ON cost_ledger (day_bucket);
