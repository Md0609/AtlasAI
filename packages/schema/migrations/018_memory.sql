-- 018_memory — Phase 5 (§B1): Memory, hybrid retrieval + injection (F-30, §30,
-- FR-10). The ER model (§28): MEMORY_ITEMS ||--|| MEMORY_EMBEDDINGS,
-- MEMORY_ITEMS ||--o{ MEMORY_LINKS.
--
-- §30.2 is emphatic that "the semantic layer is the moat and it is mostly NOT
-- embeddings" — theses, rules, profile versions are structured rows queried
-- live. So this table holds only the EPISODIC/semantic free-text that isn't
-- otherwise structured-queryable (material Copilot exchanges, notes). Retrieval
-- (§30.3) pins the structured facts and treats these as evictable (D-013).
--
-- Vector store behind an interface (D-013 / line 4188: "retrieval behind an
-- interface; structured memory unaffected"). The embedding is a plain float
-- array, so this runs on any Postgres; cosine similarity is computed over a
-- single user's own (bounded) item set. pgvector + an HNSW index is the
-- documented production swap (§30.3 / §41.6) — a storage change behind the same
-- VectorIndex interface, no caller impact.

CREATE TABLE memory_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),   -- FR-10.6: strict tenant isolation
  kind        text NOT NULL,                          -- 'copilot_exchange' | 'note' (§30.2 episodic)
  security_id uuid REFERENCES securities(id),         -- optional subject
  content     text NOT NULL CHECK (length(trim(content)) > 0),  -- the human-readable memory (§30.6)
  source      text NOT NULL DEFAULT 'copilot' CHECK (source IN ('copilot','user','system')),
  source_ref  uuid,                                   -- soft link (e.g. copilot thread); no FK, survives thread edits
  importance  real NOT NULL DEFAULT 0.5,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_items_user_idx ON memory_items (user_id, occurred_at DESC);
CREATE INDEX memory_items_user_security_idx ON memory_items (user_id, security_id);

-- 1:1 with the item. `embedding` is a float array; `dim` guards model changes.
CREATE TABLE memory_embeddings (
  memory_item_id uuid PRIMARY KEY REFERENCES memory_items(id) ON DELETE CASCADE,
  model          text NOT NULL,
  dim            int NOT NULL,
  embedding      real[] NOT NULL
);

-- §30 relationships modelled in tables (D-012 — no graph DB).
CREATE TABLE memory_links (
  from_id   uuid NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  to_id     uuid NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  link_type text NOT NULL,
  PRIMARY KEY (from_id, to_id, link_type)
);
