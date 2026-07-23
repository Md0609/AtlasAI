-- 017_decision_source — Phase 5 (§B1): Decision Journal (F-27). The decisions
-- table already captures reasoning immutably (§28: "DECISION captures
-- REASONING", append-only). This adds ATTRIBUTION so a decision the user chose
-- to keep from a Copilot conversation (FR-11.6 — "offer to persist material
-- conclusions as thesis/decision records") is clearly marked as such and links
-- back to the thread it came from.
--
-- Adding columns does not touch the decisions_immutable trigger (it forbids
-- UPDATE/DELETE per row; DDL is unaffected). Existing rows take the 'user'
-- default. Both new columns are covered by the GDPR erasure cascade already —
-- decisions is hard-deleted, and the worker deletes it before copilot_threads.

ALTER TABLE decisions
  ADD COLUMN source text NOT NULL DEFAULT 'user' CHECK (source IN ('user','copilot','system')),
  ADD COLUMN source_thread_id uuid REFERENCES copilot_threads(id);

COMMENT ON COLUMN decisions.source IS
  'Who authored this decision: the user directly, a Copilot conversation the user chose to keep, or the system.';
COMMENT ON COLUMN decisions.source_thread_id IS
  'When source = copilot, the thread the conclusion came from — attribution back to the exchange (§30.2 episodic).';
