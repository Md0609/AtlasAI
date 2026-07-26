-- 022_message_generative — record whether a model wrote the turn (P1-10/P1-11).
--
-- `degraded` already answers "did the real provider fall back?". It does NOT
-- answer "did a language model write this?", and the two come apart in the case
-- that matters most: the fixture provider is not degraded — returning the
-- deterministic draft IS its answer — and is still not analysis. A deploy
-- running the fixture therefore served template prose with degraded: false and
-- guard_approved: true, and nothing in the record disagreed.
--
--   generative AND NOT degraded      a model wrote it, normally
--   NOT generative AND degraded      the provider failed; this is the template
--   NOT generative AND NOT degraded  fixture/demo, or the template kept by choice
--   generative AND degraded          impossible: a degradation returns the template
--
-- DEFAULT false is deliberate for existing rows. We do not know what wrote
-- them, and the safe direction is to claim less rather than more.

ALTER TABLE copilot_messages
  ADD COLUMN generative boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN copilot_messages.generative IS
  'True only when a language model wrote this text. Independent of `degraded`, which reports a provider falling back (P1-10).';
