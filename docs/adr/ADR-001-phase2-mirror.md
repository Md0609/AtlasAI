# ADR-001 — Phase 2 ("The mirror") scope, decisions and deviations

Status: accepted · 2026-07-18

## Context

Design §B1 Phase 2 — "The mirror" (weeks 9–15, depends on Phase 1 Signal
Engine): adaptive onboarding, Investor Profile (versioned, stated/revealed),
scenario risk assessment, strategy inference, rules engine, **Reality Check**
(Surprise Detector + template-narrated v0), portfolio views (exposure,
performance, rules). Everything in this phase is deterministic — the
intelligence plane (LLM narration, PSA, Guard) starts at Phase 4a/4b.

## In scope (built)

- **Investor Profile** (migration 005): `profile_versions`, append-only via
  DB trigger (§27.3.1 — the only legal UPDATE closes an open version).
  Stated and revealed risk in separate columns (FR-2.3); strategy with
  source `stated|inferred|hybrid|unknown` + confidence (FR-2.4);
  `change_reason` + `changed_by` on every version (FR-2.1); scenario
  responses stored as the evidence for the revealed band.
- **Scenario risk assessment** (F-03, US-ONB-04): three scenarios calibrated
  to the user's actual portfolio value in their currency (capital-band
  midpoint fallback); the answer→band map is server-owned; divergence
  >2 bands sets `risk_divergence_flag`.
- **Strategy inference** (F-04, US-ONB-03) — `strategy.v1`: deterministic
  heuristics (fund share, weighted P/E over look-through names with
  coverage-scaled confidence, sector tilt) producing a hypothesis +
  evidence + gaps. Persists nothing; the user confirms or corrects
  (FR-2.5), and acceptance records `strategy_source = 'inferred'`.
- **Rules engine** (F-05, migration 006) — `rules.v1`: 7 machine-evaluable
  types (max_single_name on look-through, max_sector, min_cash, max_cash,
  no_buy_list, max_positions, min_holding_period). `stated_reason` NOT NULL
  (§29.1); removal requires a reason (CHECK constraint); evaluations
  partitioned by month; **every portfolio write re-evaluates all the user's
  rules in the same DB transaction** (§27.4). Rules are user-level,
  evaluated against the consolidated view (§14.2). Suggestions derived from
  the actual portfolio (D-002).
- **Reality Check** (F-09, §14.3) — `correlation.v1` + `surprise.v1`:
  pairwise Pearson in decimal arithmetic (min 60 overlapping observations,
  <1y window always warned per US-PF-03), threshold-0.7 clusters; detectors
  D1/D2/D4/D5/D6/D8 ranked by normalized magnitude × unawareness prior,
  top 3 only. Template narration v0 — every numeral in every rendered string
  is computed and returned machine-readable; these templates remain the
  degradation path when LLM narration lands (Phase 4b, §B10).
- **Onboarding UI** (D-002): capital band → portfolio (CSV import / skip) →
  Reality Check → strategy cards + first-class "I don't know yet" →
  scenarios → rule suggestions → summary. Hard rule honored: no question
  before the Reality Check except jurisdiction (registration) and capital
  band.
- **Portfolio views**: Reality Check tab (default) and Rules & Adherence tab
  (current value, limit, status, breach duration, stated reason quoted back)
  added to the Phase-1 positions/exposure/performance tabs.

## Key decisions

1. **Rules are user-level and evaluated against the consolidated portfolio**
   (§14.2 "the consolidated view is the default"). A per-portfolio rule
   would silently under-report the exact concentrations rules exist to catch.
2. **Funded imports** (`defaults.assume_funded`): importing buys without
   deposit history fabricates deeply negative cash, which corrupts every
   weight (the Reality Check rendered "243% of portfolio" in verification).
   With the flag, each imported buy gets a matching same-day funding deposit
   — the semantics of "the cash lived at the broker". Default off at the
   API (Phase-1 behavior unchanged); default on in the import UI.
3. **Correlation over direct equities only** — funds correlate with their own
   constituents by construction; including them would manufacture clusters.
4. **Beta / factor-loading rules deferred with F-11** (Design §A4.4/§A5):
   "max portfolio beta" (§14.6) is not implementable until factor analytics
   land in v1.1, and US-ONB-05 forbids shipping a rule type the engine
   cannot evaluate. Six other types satisfy the ≥6 requirement.
5. **Surprise magnitudes are normalized per detector** (excess over trigger /
   per-detector scale) so magnitude × prior is comparable across detectors;
   otherwise detectors with naturally large raw numbers always win.
6. **D7 (sector vs benchmark) deferred**: needs a licensed benchmark
   composition; D3 (factor concentration) approximated by D8 correlation
   clusters per §A4.4.

## Deliberately deferred (not Phase 2)

Thesis Ledger, radars, event bus/workers, briefs, notifications (Phase 3);
Contextualization schema, Guard, egress typing (Phase 4a); all LLM surfaces
including narrated Reality Check and adaptive question *generation* — the
onboarding adapts through portfolio-derived calibration and suggestions,
which is what a deterministic Phase 2 can honestly do (Phase 4b); RLS
(D-020) remains app-layer ownership checks + architecture tests pending the
hardening phase; screenshot import (v1.1 per §A5).

## Verification

95 automated tests (signal-engine golden/property/adversarial + rules +
correlation/surprise units, API integration suites for profile, rules,
reality check against a real Postgres and the mock-vendor snapshot), plus a
full manual browser pass of the onboarding flow and both new portfolio tabs.
