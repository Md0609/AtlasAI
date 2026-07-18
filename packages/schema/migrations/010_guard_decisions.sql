-- 010_guard_decisions — Phase 4a (§29.1): every compliance verdict, append-
-- only, partitioned by month, 7-year retention. "If a regulator ever asks
-- 'how do you ensure you're not giving advice?', the answer is a table with
-- tens of millions of rows and a rejection rate, not a policy PDF."

CREATE TABLE guard_decisions (
  id                 bigint GENERATED ALWAYS AS IDENTITY,
  user_id            uuid,                -- nullable: pre-user eval runs (CI) also record
  output_hash        text NOT NULL,       -- sha256 of the rendered candidate
  verdict            text NOT NULL CHECK (verdict IN ('approved','rejected')),
  violations         jsonb NOT NULL DEFAULT '[]'::jsonb,
  ruleset_version    text NOT NULL,
  classifier_version text NOT NULL,
  classifier_score   numeric NOT NULL,
  generator          jsonb NOT NULL DEFAULT '{}'::jsonb,  -- agent, prompt version, model
  regenerated        integer NOT NULL DEFAULT 0,          -- 4b regeneration loop counter
  latency_ms         integer NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX guard_decisions_user_idx ON guard_decisions (user_id, created_at);
CREATE INDEX guard_decisions_verdict_idx ON guard_decisions (verdict, created_at);

CREATE OR REPLACE FUNCTION ensure_guard_decisions_partition(d timestamptz) RETURNS void AS $$
DECLARE
  month_start date := date_trunc('month', d)::date;
  month_end   date := (date_trunc('month', d) + interval '1 month')::date;
  part_name   text := 'guard_decisions_' || to_char(month_start, 'YYYY_MM');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF guard_decisions FOR VALUES FROM (%L) TO (%L)',
      part_name, month_start, month_end
    );
  END IF;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER guard_decisions_no_mutation BEFORE UPDATE OR DELETE ON guard_decisions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
