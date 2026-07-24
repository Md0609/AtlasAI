# ADR-006 — Phase 5 ("Rhythm & trust") scope and decisions

Status: in progress · 2026-07-20

## Context

Design blueprint §B1, Phase 5 — "Rhythm & trust" (weeks 24–29, depends on 4b,
complexity M). Scope, verbatim:

> Weekly Review, suppression transparency, Journal surfaces, memory hybrid
> retrieval + injection, quiet-day dashboard states, export/delete flows.

Per §A5 / §51.4, two adjacent features are explicitly v1.1 and ship only their
**data capture** at MVP: the **Atlas Scorecard** grader/report (F-34 — claims
must age; the falsifiers, event log, agent messages and provenance that feed it
are already captured) and **Learning Mode** beyond a hover glossary. So the
Weekly Review's "one thing to learn" and "scorecard" sections are minimal or
omitted, exactly as specified.

Each sub-feature ships on its own branch, merged to `dev` after a full
build + test gate. This ADR records the decisions as they land.

## Export + delete flows (F-31 / US-ACC-01/02 / FR-1.5/1.6 / FR-10.5)

**Export** — `GET /v1/account/export?format=json|html`. JSON is the complete,
machine-readable bundle (account, profile versions, portfolios, positions,
transactions, cash, private assets, rules, theses + conditions, decisions,
radars, briefs, suppressions, copilot threads + messages). HTML is a readable
document of the user's own investment reasoning (§6.6: "full, structured,
useful, not a hostile JSON dump"). Read-only; available during and after
cancellation.

**Erasure** — `DELETE /v1/account`. Issues a **certificate** immediately,
records it in the retained `account_deletions` table (migration 015), and
schedules the cascading hard-delete via a `run_after` job (≤30-day SLA,
`ATLAS_ERASURE_GRACE_DAYS`, default 30). The `account-worker` runs the whole
erasure in one transaction.

### Key decision — reconciling GDPR erasure with append-only immutability

The spec is explicit (§35 / line 3818, §27.3.6 / line 3212): *"Soft-delete user
content, hard-delete on GDPR erasure"* and *"erasure (30 days, cascading, with a
documented exception for the immutable audit log under Art. 17(3)(b),
pseudonymized at day 30)."* Eight tables carry append-only immutability triggers
that block `DELETE`. So:

- **User content is hard-deleted, cascading child→parent** — including the
  immutable content tables (theses, decisions, profile versions, copilot turns).
- **The immutable audit log is retained but pseudonymized** — `audit_log`,
  `events`, `guard_decisions`, `agent_messages`: rows stay, PII linkage is
  severed (`user_id`/actor/payload nulled).

The mechanism (migration 015): a session GUC `atlas.gdpr_erasure`. Each
immutability trigger function gains a controlled exception — it permits the
`DELETE` (content tables) or `UPDATE`-to-pseudonymize (audit tables) **only**
when the GUC is set. The erasure worker sets it with `SET LOCAL` inside its
transaction, so the exception is scoped to that one transaction and nothing
else in the system can reach it. Normal writes still hit the same immutable
walls — verified by a test that a plain `DELETE FROM decisions` is still refused.

`users.deleted_at` (the soft-delete column) is deliberately **not** set on an
erasure request: soft-delete and GDPR hard-delete are the two distinct
mechanisms the spec calls out, and leaving the account active keeps export
available through the grace window (§6.6).

### Verification

+4 integration tests: export (JSON completeness + readable HTML with the user's
own words); erasure (content hard-deleted, audit pseudonymized, user deleted,
the disclosed `account_deletions` record completed with per-table counts, a
second user completely untouched); idempotent re-request returns the same
certificate; and normal immutability still holding outside the erasure
transaction. Full suite 303 green. Web: a minimal Settings surface (§30.6) for
export + typed-confirmation deletion.

## Suppression transparency + retrain (F-23 / US-NOT-02 / FR-8.3)

The suppressed-items surface already existed (`/v1/suppressions`, §28.3 — logged
from day one). This adds the other half of the AC: the one-click *"actually,
tell me about these next time"* that **retrains the threshold**.

`POST /v1/suppressions/:id/feedback {signal: tell_me_next_time | stop_telling_me}`
logs the signal append-only (`notification_feedback`, migration 016) and nudges
the user's **weekly notification budget** — the §18.3 budget IS the threshold for
how much gets through. Each "tell me" raises a per-user `weekly_budget_delta`
(bounded ±5); the dispatcher now reads `effectiveWeeklyBudget = persona default +
delta`, so more of what the Ranker suppressed reaches the user next week.

Decision — retrain the budget, not the weights: the current dispatch gate is the
weekly **count** (§18.3), so a per-user budget delta is the knob that actually
changes behavior deterministically. Down-weighting the relevance features is a
finer, per-category retrain that belongs with a score-gated dispatch (v1.1). The
`notification_feedback` log captures the signal now so that later retrain has its
training data (the §51.4 "ship the data capture" discipline).

Erasure note: both new tables carry `user_id`, so they join the GDPR cascade
(migration 015 mechanism) — `notification_feedback` gets its own erasure-aware
append-only trigger.

Verification: +2 integration tests (over-budget suppression → visible with a
reason → "tell me next time" raises the delta and logs the signal → the next
brief is delivered; 404 on a suppression the user doesn't own). Full suite 305
green.

## Quiet-day dashboard states (§13.3)

"This screen is the product." `GET /v1/today` turns silence into a positive
assertion of work done, with every count sourced from real events (US-AI-02):

- **needs_attention / attention_count** — unread briefs.
- **reviewed** — `security.changed` events processed across the user's holdings
  in the last 7 days (`updates`, `holdings`), and how many were material
  (briefs raised, `material`).
- **receipt** — the per-security breakdown behind that count ("show me what you
  looked at"), the thing that makes the silence credible.
- **quiet_days** — quiet days out of the last 30 (§13.4 normalizing inaction).
- **open_questions** — met falsification conditions + rules in breach.
- **weekly_review.next** — the upcoming Sunday.

Decision — no fabricated categories. The §13.3 mock shows "12 filings, 63 news,
2 earnings"; the ingest produces `security.changed`, not typed filing/news/
earnings streams, so surfacing those categories would violate US-AI-02 (every
number sourced). The endpoint reports the real "updates reviewed" count and its
per-security receipt instead; the typed categories arrive when news/filings
ingest does. The web `TodayView` renders the three trust elements; verified live
in the browser.

Verification: +2 integration tests (quiet day — sourced receipt, quiet-day
streak, Sunday cadence, no fabrication; flip to needs-attention + a rule-breach
open question when a rule breaches). Full suite 307 green.

## Decision Journal surfaces (F-27 / US-MEM-01 / FR-11.6)

"Your reasoning history is a first-class object, not a settings page." `GET
/v1/journal` is a unified, reverse-chronological, **immutable** timeline over the
things the user reasoned about and Atlas recorded: decisions (incl. "no change"),
thesis lifecycle (written / falsified / retired / superseded), and rule lifecycle
(set / removed) — each with the reason given. Filterable by security.

**Attribution (FR-11.6).** `decisions` gains `source` (`user`|`copilot`|`system`)
and `source_thread_id` (migration 017). The decision endpoint accepts a
Copilot-sourced entry — validated to reference the user's OWN thread, and
required to carry one — so a conclusion kept from a conversation is clearly
marked and links back to the exchange. The web Copilot offers a one-click "Save
to journal" on each answer; the Journal renders a "from Copilot" badge.

**Design decisions:**
- *No new entity; attribute the existing one.* FR-11.6 says persist conclusions
  as *thesis/decision records* — so Copilot-kept conclusions are decisions
  (`action: other`) with attribution, not a parallel "notes" table. Keeps the
  immutable-history guarantee (the `decisions_immutable` trigger is untouched —
  adding columns is DDL) and one audit surface.
- *Memory- and Weekly-Review-ready shape.* Each `JournalEntry` is a stable id +
  typed `kind` + timestamp + `source` + optional security + a `source_ref` back
  to the immutable record — exactly the episodic-memory item shape (§30.2) the
  later Memory consolidator and the Weekly Review's "what changed / decisions
  this week" both read. No rework needed when those land.
- *Erasure ordering.* The new `decisions.source_thread_id → copilot_threads` FK
  means the erasure cascade now deletes `decisions` first (nothing references
  it), before `copilot_threads`.

Verification: +5 integration tests (unified timeline + security filter; Copilot
attribution linking back to the thread; rejects a copilot decision with no /
foreign thread; decisions still immutable). Full suite 312 green.

## Memory — hybrid retrieval + injection (F-30 / §30 / FR-10)

`memory_items` + `memory_embeddings` + `memory_links` (migration 018), the §28 ER
model. §30.2 is emphatic that "the semantic layer is the moat and it is mostly
NOT embeddings", so the table holds only the **episodic free text** that isn't
otherwise structured-queryable (material Copilot exchanges); theses, rules and
decisions stay live rows.

**Retrieval (§30.3), structured-first and structured-PINNED (D-013):**
`retrieveMemory` always runs the deterministic `SELECT ... WHERE user_id = $1`
for the user's rules (+ latest status), active theses and recent decisions, and
those are never evicted. The **semantic** layer — cosine over the user's own
embedded items, reranked `0.7·similarity + 0.3·recency` — is what the token
budget evicts first. Rationale is the spec's: forgetting a vague conversation
costs a colder answer; forgetting a hard rule "proves Atlas doesn't know them".

**Injection (FR-10.3):** the rendered bundle rides in the Copilot system prompt,
and its numerals join the numeral-preservation allow-list (they are the user's
own provenanced figures). Proven by a test that captures the exact system prompt
the provider receives.

**Persistence (FR-10.1):** guard-approved Copilot turns are stored as memory
items with their thread as `source_ref`.

**Visibility (§30.6):** `GET /v1/memory` lists what Atlas knows with source and
date; `DELETE /v1/memory/:id` forgets an item (embedding cascades). Rendered in
Settings → "What Atlas knows about you".

**Tenant isolation (FR-10.6):** every read and write is scoped to the session
user; tested in both directions.

### Deviation — vector store behind an interface, not pgvector (yet)

The PRD names pgvector + HNSW (§30.3, index list). pgvector is **not available
for the PostgreSQL 16 this environment runs** (Homebrew bottles ship for 17/18
only). D-013 / line 4188 anticipates exactly this: *"Retrieval behind an
interface; structured memory unaffected."* So the embedding is a plain `real[]`
column with cosine computed over the user's own bounded item set — correct and
tenant-isolated at MVP scale — behind the runtime's `Embedder` abstraction.
Swapping in pgvector + HNSW is a storage change behind the same interface with
no caller impact, and is the documented production step (§41.6). The embedder
itself is the §B8 deterministic mock (`HashEmbedder`), a drop-in for a real
embedding model.

### Deferred (per §51.4)

The nightly **consolidator** (§30.5 — promoting 3+ episodic instances into
semantic patterns, surfacing contradictions) is not built: it needs aged data,
and §51.4 defers pattern detection to v1.1 while shipping the data capture now —
which is exactly what `memory_items` does.

Verification: +11 tests (7 retrieval — structured always present, semantic
ranking, tenant isolation both ways, budget eviction preserving pinned facts,
security scoping, deterministic embedder, and the injection proof; 4 API —
persistence, §30.6 list/delete with cascade + foreign-delete 404, export
inclusion, erasure). Full suite 323 green.

## Weekly Review (F-25 / §6.5)

"The retention engine", with the design constraint that it must be worth reading
on a week when nothing happened. `weekly_reviews` (migration 019) holds one row
per user per week — `UNIQUE (user_id, week_start)` makes generation idempotent
under retries and overlapping schedulers — plus the `snapshot` that next week's
diff compares against, so no separate snapshot table is needed.

Sections built (all deterministic, every numeral from recorded data):
1. **The one thing** — one sentence, priority-ordered: a met falsification
   condition outranks a rule breach, which outranks a quiet week.
2. **What changed** — diff vs. last week's stored snapshot (value, cash weight,
   holdings count); says so plainly when there is no baseline yet.
3. **What didn't change, and the noise you can ignore** — what Atlas reviewed and
   what it chose not to send, with the reason (§18.7 / FR-8.3). The
   highest-trust section.
4. **Your rules** — adherence, and each breach with the user's own reason quoted
   back (§14.6).
5. **Open questions** — theses whose falsification conditions are met.

The assembled template is narrated behind the Guard with the template as the
permanent degradation path (§B10), exactly like briefs. Delivered in-app (the
row) and by email; `GET /v1/weekly-reviews[/latest]` + a read receipt, and a
`review` surface in the web nav.

**Sections 6 and 7 are deliberately not built**: §A5 cuts Learning Mode to a
hover glossary at MVP, and §51.4 defers the Atlas Scorecard to v1.1 because
claims must age ("shipping '0 claims graded' is worse than not shipping it")
while its data capture already ships.

### Key decision — scheduling is a due-based cron sweep, not a self-perpetuating chain

§25.1 lists `weekly_review_generator` as a **cron** ("Sun 06:00 local,
staggered"), and that turns out to be load-bearing rather than incidental. The
queue's per-entity ordering (§24.4) blocks a job whenever an *earlier* job on the
same `partition_key` is pending — **and that check ignores `run_after`**. Parking
next Sunday's review under `partition_key = user_id` would therefore head-of-line
block that user's recomputes and briefs for a week. So `scheduleWeeklyReviews()`
sweeps for reviews that are due *now* and enqueues only immediately-runnable
jobs; the handler never self-schedules. Delivery is staggered across a 6-hour
window by a stable hash of the user id (§41.6 thundering herd).

### Other decisions

- **The Weekly Review does not spend the §18.6 notification budget.** That budget
  governs *unprompted* interruptions; the review is a scheduled digest the user
  is explicitly told to expect (§13.3). Asserted by test.
- **`email_outbox.brief_id` became nullable.** The outbox is a *channel* outbox
  and the review is a legitimate non-brief email (§6.5 / FR-8.5); it previously
  required a brief.

Verification: +9 integration tests (five sections on a quiet week incl. the
restraint section and email delivery; budget not spent; idempotency; breached
rules quoted back; the week-over-week diff once a snapshot exists; read receipt;
stagger; no future job parked on the user's partition; due-based enqueue that is
idempotent). Full suite 332 green.

## Phase 5 complete

All six §B1 sub-features have landed: export/delete, suppression transparency,
quiet-day dashboard states, Journal surfaces, memory hybrid retrieval +
injection, and the Weekly Review.
