-- 005_investor_profile — §B4 group 5 (first half): investor_profiles (versioned).
-- Phase 2 ("The mirror", Design §B1): Investor Profile with stated/revealed
-- preferences stored SEPARATELY (FR-2.2/FR-2.3), strategy with source and
-- confidence (FR-2.4), scenario responses as the evidence for the revealed
-- band (US-ONB-04).
--
-- §27.3.1: versioned, never mutated. A new version closes the previous row's
-- valid_to; nothing else about a version ever changes and nothing is deleted.
-- Enforced by trigger, not convention.

CREATE TABLE profile_versions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id),
  version             integer NOT NULL,
  experience_level    text CHECK (experience_level IN
                        ('beginner','intermediate','advanced','professional')),
  horizon_years       integer CHECK (horizon_years > 0),
  capital_band        text,                    -- e.g. '<25k','25k-100k','100k-500k','>500k'
  monthly_contribution numeric,
  contribution_currency text,                  -- §27.3.3: no implicit currency
  decumulation        boolean NOT NULL DEFAULT false,
  -- Strategy (FR-2.4): 'unknown' is a first-class value; inference is a
  -- proposal the user confirms, recorded with its source and confidence.
  stated_strategy     text,
  inferred_strategy   text,
  strategy_source     text NOT NULL DEFAULT 'unknown' CHECK (strategy_source IN
                        ('stated','inferred','hybrid','unknown')),
  strategy_confidence numeric CHECK (strategy_confidence >= 0 AND strategy_confidence <= 1),
  -- Risk (FR-2.3): stated and revealed are SEPARATE columns; collapsing them
  -- destroys the most interesting fact about the user (§29.1).
  risk_stated         integer CHECK (risk_stated BETWEEN 1 AND 5),
  risk_revealed       integer CHECK (risk_revealed BETWEEN 1 AND 5),
  risk_divergence_flag boolean NOT NULL DEFAULT false,  -- |stated − revealed| > 2 bands
  scenario_responses  jsonb NOT NULL DEFAULT '[]'::jsonb, -- scenarios shown (calibrated values) + answers
  -- Version bookkeeping (FR-2.1: actor, timestamp, reason on every change)
  change_reason       text NOT NULL,
  changed_by          text NOT NULL CHECK (changed_by IN ('user','atlas_inference','review')),
  valid_from          timestamptz NOT NULL DEFAULT now(),
  valid_to            timestamptz,
  UNIQUE (user_id, version)
);
CREATE UNIQUE INDEX profile_versions_current_uni
  ON profile_versions (user_id) WHERE valid_to IS NULL;

-- Immutability trigger: DELETE is forbidden; the only legal UPDATE is closing
-- an open version (setting valid_to on a row where it was NULL) while every
-- other column stays byte-identical.
CREATE OR REPLACE FUNCTION profile_versions_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
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

CREATE TRIGGER profile_versions_immutable_trg
  BEFORE UPDATE OR DELETE ON profile_versions
  FOR EACH ROW EXECUTE FUNCTION profile_versions_immutable();
