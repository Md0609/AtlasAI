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

## Deferred within Phase 5

Weekly Review, suppression transparency, Journal surfaces, memory hybrid
retrieval + injection, quiet-day dashboard states — the remaining five
sub-features, to be added to this ADR as they land.
