-- 016_notification_feedback — Phase 5 (§B1): suppression transparency (F-23,
-- US-NOT-02). The suppressed-items surface already exists (§28.3 suppressions,
-- /v1/suppressions). This adds the OTHER half of the story: the one-click
-- "actually, tell me about these next time" that RETRAINS the threshold.
--
-- The retrain is deterministic and uses the §18.3 budget as the threshold:
-- each "tell me next time" raises the user's weekly notification budget by one
-- (bounded), so more of what the Relevance Ranker would otherwise suppress gets
-- through next week. The feedback itself is logged append-only — the signal is
-- product data (§28.3), and later it also trains the weights.

-- Append-only record of the user's feedback on a suppression.
CREATE TABLE notification_feedback (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id),
  suppression_id uuid REFERENCES suppressions(id),
  signal         text NOT NULL CHECK (signal IN ('tell_me_next_time','stop_telling_me')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_feedback_user_idx ON notification_feedback (user_id, created_at DESC);

-- Append-only, but hard-deletable under the GDPR erasure exception (it carries
-- a NOT NULL user_id, so it must go, not be pseudonymized — migration 015).
CREATE OR REPLACE FUNCTION forbid_feedback_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND atlas_gdpr_erasure_active() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'notification_feedback is append-only';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER notification_feedback_no_mutation BEFORE UPDATE OR DELETE ON notification_feedback
  FOR EACH ROW EXECUTE FUNCTION forbid_feedback_mutation();

-- Per-user notification preferences learned from that feedback. The weekly
-- budget delta shifts the §18.3 persona budget up (more) or down (quieter).
CREATE TABLE user_notification_prefs (
  user_id            uuid PRIMARY KEY REFERENCES users(id),
  weekly_budget_delta integer NOT NULL DEFAULT 0,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
