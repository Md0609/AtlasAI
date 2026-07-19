-- 013_relevance_weights — Phase 4b (§18.3). User-specific LEARNED weight
-- overrides for the Relevance Ranker.
--
-- The scoring model's default weights are persona-specific and live in code
-- (@atlas/relevance). This table holds the per-user overrides that a learning
-- loop writes over time; the ranker merges them on top of the persona default
-- at resolve time. Absent a row, the user is scored on the persona default.
--
-- Weights are a partial JSON object over {w1..w9}; only the entries the loop
-- has learned are present. Storing them as JSONB keeps the shape identical to
-- RelevanceWeights and lets a partial override coexist with the default.

CREATE TABLE relevance_weight_overrides (
  user_id    uuid PRIMARY KEY REFERENCES users(id),
  weights    jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
