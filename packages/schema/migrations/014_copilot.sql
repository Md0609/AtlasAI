-- 014_copilot — Phase 4b (§11.2). The Copilot is an AMBIENT capability, not a
-- chatbot screen: every thread is bound to the application context the user was
-- looking at when they opened it, so the conversation starts with that context
-- already loaded and the user never re-establishes what they are looking at.
--
-- A thread therefore carries a context binding (type + ref). Messages are an
-- append-only conversation record; each assistant turn stores the model, the
-- trace id, whether it degraded, and whether the Guard approved it (every
-- user-facing turn passes the egress Guard, §21.6).

CREATE TABLE copilot_threads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id),
  title           text NOT NULL DEFAULT 'New conversation',
  -- The bound application context (§11.2). 'global' is the Copilot page with no
  -- specific subject; every other kind pins a concrete row the user was viewing.
  context_type    text NOT NULL CHECK (context_type IN ('security','portfolio','notification','global')),
  context_ref     uuid,                       -- security_id | portfolio_id | brief_id; NULL for 'global'
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX copilot_threads_user_idx ON copilot_threads (user_id, last_message_at DESC);

CREATE TABLE copilot_messages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id      uuid NOT NULL REFERENCES copilot_threads(id),
  user_id        uuid NOT NULL REFERENCES users(id),
  role           text NOT NULL CHECK (role IN ('user','assistant')),
  content        text NOT NULL,
  -- Assistant-turn provenance (NULL on user turns).
  model          text,
  trace_id       text,
  degraded       boolean NOT NULL DEFAULT false,
  guard_approved boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX copilot_messages_thread_idx ON copilot_messages (thread_id, created_at);

-- Conversation records are append-only (§29.1 discipline): a turn, once shown,
-- is part of the audit trail. Thread metadata (title, last_message_at) stays
-- mutable; the messages themselves cannot be rewritten or deleted.
CREATE OR REPLACE FUNCTION forbid_copilot_message_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'copilot_messages is append-only (§29.1): a shown turn cannot be altered';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER copilot_messages_immutable BEFORE UPDATE OR DELETE ON copilot_messages
  FOR EACH ROW EXECUTE FUNCTION forbid_copilot_message_mutation();
