-- 008_thesis_radar — Phase 3: the Thesis Ledger (§61.2, FR-4) and Radar
-- (§16, FR-7).
--
--  - Theses are immutable: the statement a user wrote can never be edited,
--    only superseded (new row, version+1) or status-transitioned
--    (active → falsified | retired | superseded). Enforced by trigger —
--    "the single most valuable and most unpopular design decision" (§61.2).
--  - thesis_conditions carry both the machine AST and the user's own words
--    (condition_nl): always show the user their words, never our compilation
--    of them (§29.1).
--  - §27.4: thesis version ↔ radar is strong consistency, same transaction —
--    a thesis whose radar failed to create is a broken promise.

CREATE TABLE theses (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL REFERENCES users(id),
  security_id            uuid NOT NULL REFERENCES securities(id),
  version                integer NOT NULL DEFAULT 1,
  supersedes_id          uuid REFERENCES theses(id),
  statement              text NOT NULL CHECK (length(trim(statement)) > 0),
  time_horizon_months    integer CHECK (time_horizon_months > 0),
  confidence_at_creation integer CHECK (confidence_at_creation BETWEEN 1 AND 5),
  status                 text NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','falsified','retired','superseded')),
  status_changed_at      timestamptz,
  status_reason          text,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX theses_one_active_uni ON theses (user_id, security_id) WHERE status = 'active';
CREATE INDEX theses_user_idx ON theses (user_id, created_at);

-- Immutability: DELETE never; UPDATE may only change status fields, and only
-- away from 'active' (a closed thesis is frozen forever).
CREATE OR REPLACE FUNCTION theses_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
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

CREATE TRIGGER theses_immutable_trg BEFORE UPDATE OR DELETE ON theses
  FOR EACH ROW EXECUTE FUNCTION theses_immutable();

CREATE TABLE thesis_conditions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thesis_id     uuid NOT NULL REFERENCES theses(id),
  condition_ast jsonb NOT NULL,
  condition_nl  text NOT NULL CHECK (length(trim(condition_nl)) > 0),
  radar_id      uuid,           -- FK added below, filled in the same txn (§27.4)
  status        text NOT NULL DEFAULT 'watching' CHECK (status IN ('watching','met')),
  met_at        timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX thesis_conditions_thesis_idx ON thesis_conditions (thesis_id);

-- Radar (§16): a standing condition, deterministically evaluated. An LLM
-- never decides whether a radar fires (§16.1) — at Phase 3 there is no LLM
-- anywhere near this table.
CREATE TABLE radars (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id),
  security_id         uuid REFERENCES securities(id),  -- null = portfolio-level (§28.3)
  name                text NOT NULL,
  condition_ast       jsonb NOT NULL,
  condition_nl        text NOT NULL,
  source              text NOT NULL CHECK (source IN ('manual','thesis')),
  thesis_condition_id uuid REFERENCES thesis_conditions(id),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  paused_reason       text,
  snoozed_until       date,
  -- Edge-trigger state: a radar fires on the false→true transition, not on
  -- every evaluation while true (level-triggering would fire daily forever).
  last_met            boolean,
  last_observed       jsonb,
  last_evaluated_at   timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  archived_at         timestamptz
);
CREATE INDEX radars_user_active_idx ON radars (user_id) WHERE status = 'active';
CREATE INDEX radars_security_idx ON radars (security_id) WHERE status = 'active';

ALTER TABLE thesis_conditions
  ADD CONSTRAINT thesis_conditions_radar_fk FOREIGN KEY (radar_id) REFERENCES radars(id);

CREATE TABLE radar_fires (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  radar_id  uuid NOT NULL REFERENCES radars(id),
  user_id   uuid NOT NULL REFERENCES users(id),
  fired_at  timestamptz NOT NULL DEFAULT now(),
  observed  jsonb NOT NULL,     -- value, target, engine version, input hash (provenance)
  event_id  text,
  brief_id  uuid                -- linked by the brief generator (Phase 3c)
);
CREATE INDEX radar_fires_radar_idx ON radar_fires (radar_id, fired_at DESC);
CREATE INDEX radar_fires_user_idx ON radar_fires (user_id, fired_at DESC);
