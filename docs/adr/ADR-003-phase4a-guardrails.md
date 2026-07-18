# ADR-003 — Phase 4a ("Guardrails") scope, decisions and deviations

Status: accepted · 2026-07-18

## Context

Design §B1 Phase 4a — "Guardrails" (weeks 17–20, depends on Phase 3,
complexity M): **before any agent** — Contextualization schema + typed
egress module (§A4.1), Compliance Guard (3 layers), adversarial eval suite
as CI gate, prompt registry, tracing + per-tenant cost accounting. Phase 4b
(the intelligence plane) is hard-gated on this phase.

## In scope (built)

- **Contextualization schema (§A4.1)** in `@atlas/contracts`: typed sections
  (fact, tension, nuance, countercase, unknown) built from spans — prose
  (no numerals allowed), signal references (formatted from a provenance-
  carrying bundle at render time), and verbatim user quotes. Tensions carry
  the §17.3 closed taxonomy; T1/T2 must anchor to the user's own rows
  (§28.2). Confidence requires non-empty `whatWouldChangeIt` (§17.4).
  Consequence: an unprovenanced number is *unrepresentable* — US-AI-02's
  100% provenance is structural, not statistical.
- **Compliance Guard** (`@atlas/guard`): stateless, pure, no IO (§A3.2) —
  invoked in-process by the egress module. Layer 1 structural (numerals,
  references, anchors, falsifiers, currency presence), layer 2 lexical
  directive screen (rule set `lex.v1`, versioned like code per FR-12.3 with
  `docs/guard-ruleset-changelog.md`), layer 3 recommendation classifier
  (`heuristic.v0`, threshold 0.15 per §21.6) behind the interface a trained
  classifier or cross-family judge implements later. User-quote spans are
  masked: the user's words may contain directives; Atlas's may not.
- **Typed egress** (`@atlas/egress`): `UserFacingContent` is a class with a
  private constructor, an ECMAScript #private brand (nominal typing) and a
  module-private symbol factory — the only path to an instance runs the
  Guard (§A3.3 "the type system can"). Quotes verified verbatim against
  allow-listed (table, column) rows (§6.2). Guard decisions recorded
  approved and rejected into append-only `guard_decisions` (migration 010,
  §29.1). Rejection returns the verdict for the deterministic-template
  fallback; no bypass exists.
- **Adversarial eval suite as CI gate** (`evals/adversarial`, §48.5): 40
  directive attacks with escape rate asserted exactly 0 (US-AI-07), 12
  legitimate outputs with false positives asserted 0 on the curated set;
  structural attacks. Cases are never deleted.
- **Architecture tests** (`evals/architecture`, §47.2): guard imported only
  by egress; UserFacingContent constructed only in egress; Signal Engine
  pure (no pg, no user concept); no floating-point money columns; append-
  only triggers present for every ledger; prompts re-linted for compute
  instructions; apps touching ContextualizationDoc must import egress.
- **Prompt registry + tracing + cost** (`@atlas/runtime`, migration 011):
  prompts-as-code with §38.2 volatility ordering and §38.4 lint at
  registration (seed: `psa.brief_narrator@1.0.0`); `agent_messages`
  append-only span log built before the first agent exists (§21.5);
  `cost_ledger` with the §37.3 ceilings verbatim, checked before spending.

## Key decisions

1. **The classifier layer is a deterministic heuristic at 4a.** The §A4.1
   guarantee never rested on it — escapes require a failure in the
   deterministic layers — and the interface is where a fine-tuned
   classifier or cross-family LLM judge (§21.6 L4) lands in 4b+ without
   touching callers.
2. **Nominal branding via #private class fields** rather than a lint rule:
   TypeScript treats classes with private fields nominally, so a
   structurally identical object does not type-check as UserFacingContent.
   The architecture tests are the second lock.
3. **Quote verification is substring-verbatim** against the stored row: an
   excerpt is legitimate; a paraphrase is not. Allow-listed (table, column)
   pairs double as the SQL-injection guard.
4. **Guard verdicts record even in CI/eval runs** (user_id nullable): the
   rejection-rate history includes the suite, which is what makes "guard
   escape rate 0 is measured on the suite" (§A1.7) an honest sentence.
5. **Conversational attacks deferred to 4b** (§48.5's roleplay/multi-turn
   rows): they attack a Copilot that does not exist yet; the text-level
   corpus is the 4a scope and the suite grows with the surfaces.

## Deliberately deferred (Phase 4b, hard-gated on this phase)

Agent runtime execution loop, model providers (fixture-first per §B8), PSA
+ 3 specialists, shared-analysis cache, LLM-narrated Reality Check and
Briefs (the Phase-3 templates remain the output until then and stay forever
as the degradation path), Copilot, heuristic Relevance Ranker, regeneration
loop (guard rejection → regenerate ≤2 → degrade, §21.6 — `regenerated`
column already present).

**Open dependency for 4b:** a real LLM provider decision (Anthropic API key
with EU inference + zero-retention per §45.4) — or explicit approval to
build 4b against deterministic fixtures per §B8's "mock first, replace
later" and swap the provider when contracts are signed.

## Verification

224 automated tests: 20 guard unit tests (every layer, both directions,
quote masking, determinism), 6 egress integration tests over real Postgres,
56 adversarial eval cases (0 escapes, 0 curated false positives), 7
architecture tests, 9 runtime tests (registry lint, tracing append-only,
ceilings), plus the full Phase 1–3 suites unchanged.
