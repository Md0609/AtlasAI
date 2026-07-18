-- 009_briefs_notifications — Phase 3: deterministic Briefs (in-app + email),
-- the notification budget AS A SCHEMA CONSTRAINT (§18.6/§29.1), the dedup
-- ledger (§24.3), suppressions as product data (§28.3), and decision
-- recording (§29.1).

CREATE TABLE briefs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  class         text NOT NULL CHECK (class IN ('C0','C1','C2')),  -- §18.4; C3+ arrive with the intelligence plane
  radar_fire_id bigint REFERENCES radar_fires(id),
  rule_id       uuid REFERENCES rules(id),
  security_id   uuid REFERENCES securities(id),
  headline      text NOT NULL,
  body          text NOT NULL,
  tone          text NOT NULL DEFAULT 'neutral' CHECK (tone IN ('neutral','light','calm')), -- §18.5
  values_json   jsonb NOT NULL DEFAULT '{}'::jsonb,   -- every narrated numeral, machine-readable
  provenance    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  read_at       timestamptz
);
CREATE INDEX briefs_user_idx ON briefs (user_id, created_at DESC);

CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  brief_id   uuid NOT NULL REFERENCES briefs(id),
  channel    text NOT NULL CHECK (channel IN ('in_app','email')),
  class      text NOT NULL CHECK (class IN ('C0','C1','C2')),
  sent_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, sent_at DESC);

-- §29.1: "the budget is a table with constraints rather than application
-- logic... We are pre-committing our own future selves." One ledger row per
-- dispatched brief; the trigger enforces the §18.6 hard cap (2/day, no
-- exemption except C0) below the application layer.
CREATE TABLE notification_budget_ledger (
  user_id     uuid NOT NULL REFERENCES users(id),
  brief_id    uuid NOT NULL REFERENCES briefs(id),
  class       text NOT NULL CHECK (class IN ('C0','C1','C2')),
  day_bucket  date NOT NULL,
  week_bucket date NOT NULL,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, brief_id)
);
CREATE INDEX notification_budget_day_idx ON notification_budget_ledger (user_id, day_bucket);

CREATE OR REPLACE FUNCTION enforce_notification_budget() RETURNS trigger AS $$
DECLARE
  today_count integer;
BEGIN
  IF NEW.class <> 'C0' THEN
    SELECT count(*) INTO today_count FROM notification_budget_ledger
     WHERE user_id = NEW.user_id AND day_bucket = NEW.day_bucket AND class <> 'C0';
    IF today_count >= 2 THEN
      RAISE EXCEPTION 'notification budget: hard cap of 2/day reached (§18.6); only C0 is exempt';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER notification_budget_trg BEFORE INSERT ON notification_budget_ledger
  FOR EACH ROW EXECUTE FUNCTION enforce_notification_budget();

-- §24.3: exactly-once USER-VISIBLE effects via insert-before-send.
CREATE TABLE notification_dedup_ledger (
  user_id   uuid NOT NULL REFERENCES users(id),
  dedup_key text NOT NULL,
  sent_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, dedup_key)
);

-- What Atlas chose NOT to send is product data (§28.3), rendered to the user
-- in the Weekly Review (Phase 5); logged from day one (FR-8.3).
CREATE TABLE suppressions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  brief_id   uuid REFERENCES briefs(id),
  class      text NOT NULL,
  reason     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX suppressions_user_idx ON suppressions (user_id, created_at DESC);

-- Email channel: outbox pattern. At Phase 3 the mock sender marks rows sent;
-- a real SMTP adapter consumes the same table later.
CREATE TABLE email_outbox (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  brief_id   uuid NOT NULL REFERENCES briefs(id),
  to_email   text NOT NULL,
  subject    text NOT NULL,
  body_text  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz
);
CREATE INDEX email_outbox_pending_idx ON email_outbox (created_at) WHERE sent_at IS NULL;

-- Decision recording (§29.1). Append-only: a decision is a historical fact.
-- tensions_shown / tensions_overridden are captured empty until the
-- intelligence plane produces tensions (Phase 4).
CREATE TABLE decisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id),
  security_id       uuid REFERENCES securities(id),
  thesis_id         uuid REFERENCES theses(id),
  brief_id          uuid REFERENCES briefs(id),
  action            text NOT NULL CHECK (action IN
                      ('buy','sell','hold','update_thesis','mark_thesis_broken','no_change','snooze','other')),
  quantity          numeric,
  price             numeric,
  currency          text,
  reason_free_text  text NOT NULL CHECK (length(trim(reason_free_text)) > 0),
  tensions_shown    jsonb NOT NULL DEFAULT '[]'::jsonb,
  tensions_overridden jsonb NOT NULL DEFAULT '[]'::jsonb,
  decided_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (price IS NULL OR currency IS NOT NULL)   -- §27.3.3
);
CREATE INDEX decisions_user_idx ON decisions (user_id, decided_at DESC);

CREATE OR REPLACE FUNCTION decisions_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'decisions are append-only: what you decided is a historical fact';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER decisions_no_mutation BEFORE UPDATE OR DELETE ON decisions
  FOR EACH ROW EXECUTE FUNCTION decisions_immutable();
