-- 012_shared_analysis_cache — Phase 4b (§40.1/§21.2). The shared-analysis
-- cache: Layer-1 agent output computed ONCE per security and read by every
-- holder. This is the single largest cost lever in the product (§37.2 L1).
--
-- The table has NO user_id column — by construction it can only hold
-- user-agnostic Layer-1 work. Personal contextualizations are NEVER cached
-- (§40.4): there is no code path that writes them here, and the runtime only
-- caches requests with a null user. An unprovenanced cross-user leak is thus
-- structurally impossible — the table has nowhere to put a user.

CREATE TABLE shared_analysis_cache (
  cache_key       text PRIMARY KEY,           -- sha256(agent, prompt_version, input_hash)
  agent           text NOT NULL,
  prompt_version  text NOT NULL,
  input_hash      text NOT NULL,              -- reproducibility + the §40 data_version
  model           text NOT NULL,
  output          jsonb NOT NULL,             -- { text, toolCalls }
  input_tokens    integer NOT NULL DEFAULT 0,
  output_tokens   integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  ttl_expires_at  timestamptz NOT NULL        -- volatility-adjusted TTL (§40.2), set by the caller
);

CREATE INDEX shared_analysis_cache_expiry_idx ON shared_analysis_cache (ttl_expires_at);
