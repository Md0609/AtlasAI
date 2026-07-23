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

## Deferred within Phase 5

Weekly Review, Journal surfaces, memory hybrid retrieval + injection — the
remaining three sub-features, added to this ADR as they land.
