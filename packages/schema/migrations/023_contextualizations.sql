-- 023_contextualizations — capture the claims, so they can be graded later
-- (P0-8; FR-10.1, FR-12.4, §51.4).
--
-- POST /v1/contextualize built a full ContextualizationDoc — sections, signals,
-- confidence, and `whatWouldChangeIt`, which is the falsifier set a grader
-- needs — serialised it to the client, and returned. A grep of the handler for
-- INSERT/recordEvent returned zero. Nothing was kept.
--
-- §51.4 names this as the one MVP cut that cannot be undone: "the data model
-- and the event capture ship at MVP, because retrofitting them would mean the
-- first 12 months of claims are ungradeable forever." The Scorecard (F-34,
-- v1.1) is a nightly job over this table; without the table there is nothing
-- for it to read, and no way to recover it after the fact.
--
-- This is CAPTURE ONLY. The grader is v1.1 and is not built here.
--
-- Columns are chosen from what grading actually requires:
--   * `doc` — the whole document, so any output can be reconstructed (FR-12.4)
--   * `rendered_text` — what the user actually READ, which is not always the
--     doc: the egress guard may substitute a safe fallback
--   * `confidence_level` + `what_would_change_it` — lifted out of the doc so a
--     grader can select on them without parsing every row
--   * `guard_*` and `generator_*` — which ruleset and which model produced it,
--     so a recalibration knows what it is recalibrating

CREATE TABLE contextualizations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable on purpose: Art. 17(3)(b) pseudonymization severs the link and
  -- retains the row, exactly as for agent_messages and guard_decisions. A
  -- NOT NULL here would make the erasure sweep fail.
  user_id         uuid REFERENCES users(id),
  security_id     uuid NOT NULL REFERENCES securities(id),

  -- The full ContextualizationDoc as generated (§31.4 envelope).
  doc             jsonb NOT NULL,
  -- The prose the user saw. May differ from the doc when egress degraded.
  rendered_text   text NOT NULL,

  -- Lifted from doc.confidence for the grader's benefit.
  confidence_level      text NOT NULL CHECK (confidence_level IN ('high', 'medium', 'low', 'insufficient')),
  what_would_change_it  jsonb NOT NULL,

  -- Declared gaps at generation time: a claim made with a known gap is graded
  -- differently from one made without.
  gaps            jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Which guard passed it, and which model wrote it.
  guard_verdict           text NOT NULL,
  guard_ruleset_version   text NOT NULL,
  guard_classifier_version text NOT NULL,
  generator_agent         text NOT NULL,
  generator_prompt_version text NOT NULL,
  generator_model         text NOT NULL,
  -- False when no language model wrote it (fixture, or a degradation).
  generative      boolean NOT NULL DEFAULT false,
  degraded        boolean NOT NULL DEFAULT false,

  -- The egress module's hash of what it emitted: proves a stored row matches
  -- what was shown, without re-rendering it.
  output_hash     text NOT NULL,
  trace_id        text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- The grader reads per user and per security, in time order.
CREATE INDEX contextualizations_user_idx ON contextualizations (user_id, created_at DESC);
CREATE INDEX contextualizations_security_idx ON contextualizations (security_id, created_at DESC);
-- Calibration groups by declared confidence.
CREATE INDEX contextualizations_confidence_idx ON contextualizations (confidence_level, created_at);

-- Append-only. A claim record that can be edited cannot grade anything: the
-- whole point is that Atlas cannot revise what it said after finding out
-- whether it was right. Uses the same Art. 17(3)(b) exception as the rest of
-- the immutable family — retained, pseudonymizable under erasure, never
-- silently rewritten.
CREATE TRIGGER contextualizations_immutable
  BEFORE UPDATE OR DELETE ON contextualizations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMENT ON TABLE contextualizations IS
  'Every claim Atlas made, with its declared confidence and falsifiers. Capture for the v1.1 Scorecard (F-34); ungradeable forever if not recorded now (§51.4).';
