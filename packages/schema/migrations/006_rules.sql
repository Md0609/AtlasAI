-- 006_rules — §B4 group 5 (second half): rules, rule_evaluations.
-- Phase 2 ("The mirror", Design §B1): the rules engine.
--
--  - stated_reason is NOT NULL (§29.1): a rule without a reason cannot be
--    quoted back at the user at breach time, and the quote IS the mechanism.
--    The database constraint is the behavioral intervention.
--  - Removal requires a reason (§14.6): a rule you can silently delete is
--    not a rule. Enforced by CHECK, not by convention.
--  - Every rule type here is machine-evaluable by the Signal Engine
--    (US-ONB-05: "no rule type ships that the Signal Engine cannot evaluate
--    deterministically").

CREATE TABLE rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id),
  rule_type      text NOT NULL CHECK (rule_type IN
                   ('max_single_name','max_sector','min_cash','max_cash',
                    'no_buy_list','max_positions','min_holding_period')),
  params         jsonb NOT NULL,
  stated_reason  text NOT NULL CHECK (length(trim(stated_reason)) > 0),
  severity       text NOT NULL DEFAULT 'standard' CHECK (severity IN ('info','standard','hard')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  removed_at     timestamptz,
  removal_reason text,
  CHECK (removed_at IS NULL OR (removal_reason IS NOT NULL AND length(trim(removal_reason)) > 0))
);
CREATE INDEX rules_user_live_idx ON rules (user_id) WHERE removed_at IS NULL;

-- Evaluations grow with every portfolio write (§27.4: rule evaluation ↔
-- portfolio change is strong consistency, same transaction). §27.3.6:
-- event-growing tables are partitioned by month from day one.
CREATE TABLE rule_evaluations (
  id            bigint GENERATED ALWAYS AS IDENTITY,
  rule_id       uuid NOT NULL REFERENCES rules(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  evaluated_at  timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL CHECK (status IN ('ok','breach','not_evaluable')),
  observed      jsonb NOT NULL DEFAULT '{}'::jsonb,  -- observed value, limit, detail
  engine_version text NOT NULL,
  input_hash    text NOT NULL,
  PRIMARY KEY (rule_id, evaluated_at, id)
) PARTITION BY RANGE (evaluated_at);

CREATE INDEX rule_evaluations_user_idx ON rule_evaluations (user_id, evaluated_at DESC);

CREATE OR REPLACE FUNCTION ensure_rule_evaluations_partition(d timestamptz) RETURNS void AS $$
DECLARE
  month_start date := date_trunc('month', d)::date;
  month_end   date := (date_trunc('month', d) + interval '1 month')::date;
  part_name   text := 'rule_evaluations_' || to_char(month_start, 'YYYY_MM');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF rule_evaluations FOR VALUES FROM (%L) TO (%L)',
      part_name, month_start, month_end
    );
  END IF;
END $$ LANGUAGE plpgsql;
