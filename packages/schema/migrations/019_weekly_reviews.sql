-- 019_weekly_reviews — Phase 5 (§B1): the Weekly Review (F-25, §6.5). "The
-- retention engine. Design constraint: it must be worth reading on a week when
-- nothing happened."
--
-- One row per user per week. The row IS the in-app surface; the email outbox
-- carries the same text. `snapshot` holds the signals at generation time so the
-- NEXT week's review can compute §6.5 section 2 ("what changed — deterministic
-- diff vs. last week") without a separate snapshot table.
--
-- The UNIQUE (user_id, week_start) makes generation idempotent: the scheduled
-- job can run twice (retry, redeploy, overlapping schedulers) and the user still
-- gets exactly one review for the week.

CREATE TABLE weekly_reviews (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  week_start   date NOT NULL,                    -- Monday (UTC) of the week under review
  one_thing    text NOT NULL,                    -- §6.5 §1: the single sentence
  sections     jsonb NOT NULL DEFAULT '[]'::jsonb,  -- typed sections, every numeral pre-computed
  snapshot     jsonb NOT NULL DEFAULT '{}'::jsonb,  -- signals at generation; next week diffs against it
  narrated     boolean NOT NULL DEFAULT false,   -- true when the model rephrased (§B10 template otherwise)
  model        text,
  generated_at timestamptz NOT NULL DEFAULT now(),
  read_at      timestamptz,
  UNIQUE (user_id, week_start)
);
CREATE INDEX weekly_reviews_user_idx ON weekly_reviews (user_id, week_start DESC);

-- email_outbox was introduced for briefs and required a brief_id. It is a
-- CHANNEL outbox, and the Weekly Review is a legitimate non-brief email
-- (§6.5 / FR-8.5 channels: in-app, email), so the link becomes optional.
ALTER TABLE email_outbox ALTER COLUMN brief_id DROP NOT NULL;
