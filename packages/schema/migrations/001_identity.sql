-- 001_identity — §B4 group 1: users, auth, jurisdictions, audit_log.
-- "identity + the regulatory gate + append-only audit from day 1
--  (retrofit is impossible)" — Design §B4.
-- Phase-0 scaffolding carried into Phase 1 because portfolio CRUD needs it.

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid
CREATE EXTENSION IF NOT EXISTS citext;

-- Jurisdiction gate (FR-1.3 / FR-1.4): versioned policy table.
CREATE TABLE jurisdictions (
  code           text PRIMARY KEY,          -- ISO-3166 alpha-2
  name           text NOT NULL,
  allowed        boolean NOT NULL DEFAULT false,
  policy         jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_version integer NOT NULL DEFAULT 1,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- MVP is EU-only (Design: single-EU-region deployment; §51.5 launch EU only).
INSERT INTO jurisdictions (code, name, allowed) VALUES
  ('ES', 'Spain',        true),
  ('DE', 'Germany',      true),
  ('FR', 'France',       true),
  ('IE', 'Ireland',      true),
  ('NL', 'Netherlands',  true),
  ('IT', 'Italy',        true),
  ('PT', 'Portugal',     true),
  ('AT', 'Austria',      true),
  ('BE', 'Belgium',      true),
  ('US', 'United States', false),
  ('GB', 'United Kingdom', false);

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             citext NOT NULL UNIQUE,
  password_hash     text NOT NULL,           -- Argon2id (FR-1.1)
  jurisdiction_code text NOT NULL REFERENCES jurisdictions(code),
  base_currency     text NOT NULL,           -- ISO-4217; explicit, never implicit (§27.3.3)
  created_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz              -- soft delete; GDPR hard delete is a separate mechanism (§27.3.5)
);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  token_hash  text NOT NULL UNIQUE,          -- sha256 of the bearer token; raw token never stored
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- Append-only audit log (§36). UPDATE/DELETE are blocked by trigger:
-- the guarantee is structural, not a code-review convention.
CREATE TABLE audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  action        text NOT NULL,               -- e.g. 'portfolio.create'
  entity_type   text NOT NULL,
  entity_id     text,
  trace_id      text,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_user_id, occurred_at);

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
