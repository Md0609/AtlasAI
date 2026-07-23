-- 015_account_erasure — Phase 5 (§B1 "Rhythm & trust"): GDPR erasure (F-31,
-- FR-1.5, US-ACC-02). "Soft-delete user content, hard-delete on GDPR erasure —
-- two different mechanisms" (§27.3.6 / line 3212). Erasure is 30 days,
-- cascading, "with a documented exception for the immutable audit log under
-- Art. 17(3)(b), pseudonymized at day 30" (§35 / line 3818).
--
-- Two things this migration establishes:
--   1. The retained deletion record — the audit trail of the erasure itself,
--      kept and disclosed (it outlives the user, so it carries no FK to them).
--   2. A CONTROLLED exception to the append-only immutability triggers, active
--      only inside a transaction that has opted in via a session GUC. This is
--      how the erasure worker — and only the erasure worker — is permitted to
--      hard-delete immutable USER CONTENT (theses, decisions, profile versions,
--      copilot turns) and to pseudonymize the immutable AUDIT LOG (retained,
--      PII severed). Nothing else in the system sets the GUC, so normal writes
--      still hit the same immutable walls.

-- The retained record of a deletion (disclosed to the user). No FK to users:
-- it must survive the user row it describes.
CREATE TABLE account_deletions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  certificate   text NOT NULL UNIQUE,       -- issued to the user on request
  requested_at  timestamptz NOT NULL DEFAULT now(),
  scheduled_for timestamptz NOT NULL,       -- erasure runs at/after this (≤30d SLA)
  completed_at  timestamptz,
  status        text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','completed')),
  tables_erased jsonb                        -- counts per table, for the audit
);
CREATE INDEX account_deletions_due_idx ON account_deletions (scheduled_for)
  WHERE status = 'requested';

-- True only inside an erasure transaction that set `atlas.gdpr_erasure = 'on'`
-- (SET LOCAL, so it never leaks past the transaction). `true` = missing_ok.
CREATE OR REPLACE FUNCTION atlas_gdpr_erasure_active() RETURNS boolean AS $$
  SELECT coalesce(current_setting('atlas.gdpr_erasure', true), 'off') = 'on';
$$ LANGUAGE sql STABLE;

-- Audit-log family (audit_log, events, guard_decisions, agent_messages): the
-- Art. 17(3)(b) exception. Rows are RETAINED but may be pseudonymized — an
-- UPDATE that severs PII is permitted under erasure; DELETE stays forbidden.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND atlas_gdpr_erasure_active() THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'append-only: mutation forbidden (%.% is immutable)', TG_TABLE_SCHEMA, TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;

-- Immutable USER CONTENT: hard-deletable under erasure only.
CREATE OR REPLACE FUNCTION theses_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF atlas_gdpr_erasure_active() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'theses are never deleted; retire or supersede them';
  END IF;
  IF OLD.status <> 'active' THEN
    RAISE EXCEPTION 'thesis % is closed (%) and immutable', OLD.id, OLD.status;
  END IF;
  IF NEW.status = 'active' THEN
    RAISE EXCEPTION 'the only legal update to a thesis is closing it (falsified/retired/superseded)';
  END IF;
  IF ROW(NEW.id, NEW.user_id, NEW.security_id, NEW.version, NEW.supersedes_id,
         NEW.statement, NEW.time_horizon_months, NEW.confidence_at_creation, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.user_id, OLD.security_id, OLD.version, OLD.supersedes_id,
         OLD.statement, OLD.time_horizon_months, OLD.confidence_at_creation, OLD.created_at) THEN
    RAISE EXCEPTION 'thesis content is immutable; supersede it to change what you believe';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION decisions_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND atlas_gdpr_erasure_active() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'decisions are append-only: what you decided is a historical fact';
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION profile_versions_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF atlas_gdpr_erasure_active() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'profile_versions is append-only';
  END IF;
  IF OLD.valid_to IS NOT NULL THEN
    RAISE EXCEPTION 'profile version % is closed and immutable', OLD.id;
  END IF;
  IF NEW.valid_to IS NULL THEN
    RAISE EXCEPTION 'the only legal update to a profile version is closing it';
  END IF;
  IF ROW(NEW.id, NEW.user_id, NEW.version, NEW.experience_level, NEW.horizon_years,
         NEW.capital_band, NEW.monthly_contribution, NEW.contribution_currency,
         NEW.decumulation, NEW.stated_strategy, NEW.inferred_strategy,
         NEW.strategy_source, NEW.strategy_confidence, NEW.risk_stated,
         NEW.risk_revealed, NEW.risk_divergence_flag, NEW.scenario_responses,
         NEW.change_reason, NEW.changed_by, NEW.valid_from)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.user_id, OLD.version, OLD.experience_level, OLD.horizon_years,
         OLD.capital_band, OLD.monthly_contribution, OLD.contribution_currency,
         OLD.decumulation, OLD.stated_strategy, OLD.inferred_strategy,
         OLD.strategy_source, OLD.strategy_confidence, OLD.risk_stated,
         OLD.risk_revealed, OLD.risk_divergence_flag, OLD.scenario_responses,
         OLD.change_reason, OLD.changed_by, OLD.valid_from) THEN
    RAISE EXCEPTION 'profile versions are immutable; create a new version instead';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forbid_copilot_message_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND atlas_gdpr_erasure_active() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'copilot_messages is append-only (§29.1): a shown turn cannot be altered';
END $$ LANGUAGE plpgsql;
