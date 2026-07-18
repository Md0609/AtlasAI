# ADR-002 — Phase 3 ("Commitment loop") scope, decisions and deviations

Status: accepted · 2026-07-18

## Context

Design §B1 Phase 3 — "Commitment loop" (weeks 13–19, depends on Phases 1–2):
Thesis Ledger (immutable versions), falsification conditions → auto-radar,
event bus + queue workers, deterministic radar evaluation + auto-suppression,
deterministic Briefs (in-app + email), decision recording, rule-based tone
gate. Exit criterion M3: a thesis falsification condition fires end-to-end
(ingest → event → radar → templated brief → email) with provenance — and
zero LLM calls anywhere in the path.

## In scope (built)

- **Event log + queue** (migration 007, `@atlas/bus`): append-only events
  table (trigger-enforced, §24.5), partitioned monthly, partition_key per
  §24.4; Postgres job queue claimed with FOR UPDATE SKIP LOCKED, per-
  partition-key ordering at claim, exponential backoff, dead-letter
  (§26.2). The package boundary is the §41.6 Kafka seam.
- **Workers** (`@atlas/workers`): security.changed fans out to exposed users
  (recursive look-through CTE + active radar owners, §15.1); user.recompute
  recomputes the consolidated view, re-evaluates rules, records
  signal.recomputed; radar.evaluate makes the deterministic firing decision;
  brief.generate + notify.dispatch complete the chain. drain() gives a
  synchronous run-once mode (`npm run workers`) used by cron, dev and tests.
- **Thesis Ledger** (migration 008): immutable by trigger — content frozen,
  only active→falsified|retired|superseded transitions; one active thesis
  per (user, security); supersession versions; PATCH → 405 (§31.2);
  condition_nl keeps the user's words next to the machine AST (§29.1).
  Falsification conditions auto-create radars in the same transaction
  (F-14, §27.4) and the response says so (§16.4).
- **Radar** (`radar.v1`): machine-evaluable AST — price, trailing P/E,
  fundamental, portfolio weight/sector/cash, rule breach — vs literal or
  self-history median/min/max targets. Edge-triggered fires (false→true)
  with the baseline set at creation; §16.2 confirmation shows the current
  value. Thesis radars archive after firing (job done); the thesis STATUS
  stays a user decision (P1). Manual radars auto-suppress >3 fires/30d
  with one-click resume (§16.5/FR-7.6).
- **Briefs** (migration 009): deterministic templates over stored values —
  C0 quotes the thesis statement and condition verbatim (§6.2), C1 quotes
  the rule's stated_reason (§14.6) and fires on ok→breach transitions only,
  C2 is matter-of-fact (§18.5). Channels: in-app + email outbox (§A1.10;
  push is v1.1).
- **Notification restraint as schema**: budget ledger with a BEFORE INSERT
  trigger enforcing the 2/day hard cap (only C0 exempt, §18.6/§29.1);
  dedup ledger with insert-before-send and a semantic key
  class+subject+day (§24.3); suppressions logged (FR-8.3) and served at
  /v1/suppressions (§31.2).
- **Decisions**: append-only by trigger, mandatory reason, thesis/brief
  links; inaction ("no change") is recordable (§6.3); tensions fields
  captured empty until Phase 4 produces tensions.
- **UI**: Today (the one thing + brief list + designed quiet state §13.3 +
  "what Atlas didn't send"), Thesis Ledger with condition builder, Radar
  panel with fired history, Journal. §11.1 nav: today / portfolios / radar /
  journal — Copilot arrives with Phase 4b.

## Key decisions

1. **Edge-triggered radars.** A level-triggered radar on "price < X" fires
   every evaluation while true; edge-triggering (fire on false→true) plus a
   creation-time baseline is what makes §16.5's hygiene meaningful. It also
   makes crosses_above/below operators redundant — a comparison fired on
   transition IS a crossing.
2. **Compound conditions and time qualifiers deferred to v1.1** per FR-7.4
   (the §6.2 "for 2 quarters" example needs them; the grammar's simple
   comparisons cover MVP condition types per FR-7.3). Fundamental *delta*
   conditions need fundamental history the mock vendor doesn't carry —
   absolute fundamental thresholds are supported; delta is a declared gap.
3. **Trailing P/E series uses the latest TTM EPS against the price series**
   (single EPS snapshot in the vendor data). Stated in the module docs; a
   dated EPS series upgrades it without changing contracts.
4. **Brief rows always exist; the budget gates interruptions.** The inbox
   (in-app briefs) is not an interruption; notifications and email are.
   Suppression rows record every gated delivery.
5. **Dedup key = class + subject + day** (§24.3 semantic hash simplified to
   the Phase-3 case where briefs are templated per subject). Two radars on
   the same story deliver once.
6. **Quiet hours deferred** (FR-8.6): requires a user timezone field that
   doesn't exist yet; C0's exemption makes the covenant unaffected. Ships
   with notification preferences.
7. **Radar limits**: manual cap 50 while billing is mocked (§B8); thesis
   radars unlimited and never counted (§16.6).

## Deliberately deferred (not Phase 3)

Guard/egress/Contextualization (Phase 4a); all LLM surfaces including
NL→rule prefill (§A4.3) and LLM-narrated briefs (Phase 4b — the Phase-3
templates remain the permanent degradation path, §B10); Relevance Ranker
scoring beyond deterministic classes (C0/C1/C2 are the only classes that
exist before the intelligence plane); Weekly Review + suppression
transparency surface (Phase 5); push channel (v1.1); backtest preview
(FR-7.5, v1.1).

## Verification

126 automated tests including: queue ordering/backoff/dead-letter; the full
M3 chain (price event → recompute → radar fire → C0 brief quoting the user
verbatim → email outbox) against real Postgres; dedup and daily-cap
suppression with the DB trigger asserted directly; C1 transition-only
briefs; thesis immutability at API (405) and DB (trigger) levels; decision
append-only. Manual browser pass: thesis creation → simulated price drop →
worker drain → Today hero brief → "no change" decision → Journal entry.
