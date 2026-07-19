# ADR-004 — Phase 4b ("Intelligence plane") scope, decisions and deviations

Status: accepted · 2026-07-19

## Context

Design §B1 Phase 4b — the intelligence plane, hard-gated on Phase 4a's
guardrails. The agents produce content; 4a's egress + Guard already ensure
nothing reaches a user unprovenanced or as a directive. Per explicit approval,
4b is built **mock-first** (§B8, "mock first, replace later"): a deterministic
fixture provider behind the production interface, so every prompt, context
builder, cache, ceiling, trace and guard is exercised now and the real model is
a **drop-in** when an EU-inference / zero-retention key is procured (§45.4).

## In scope (built)

- **Generic LLM provider boundary** (`@atlas/runtime`): `LlmProvider` interface
  routing by logical **tier** (`small`/`mid`/`large`/`judge`, §39), never a
  vendor model id. `FixtureProvider` returns the request's deterministic
  template (`fallback`) verbatim; `AnthropicProvider` is a fully-written
  drop-in with the SDK imported lazily via a non-literal specifier, so the tree
  builds and the suite runs with **no vendor dependency installed**. The
  factory selects on `ATLAS_LLM_PROVIDER` (default `fixture`) — the one place
  the vendor is named. Enablement checklist: `docs/enabling-anthropic.md`.
- **`runAgent` execution loop** (`runtime/src/run.ts`): the single path every
  LLM call takes — shared-analysis cache probe (Layer-1 only) → per-user cost
  ceiling (§37.3, degrade-not-spend) → `provider.complete` → append-only
  `agent_message` span (§23.4) → cost ledger → cache write. Result carries
  `cacheHit` / `degraded` for honest banners (§26.4).
- **Shared-analysis cache** (migration 012, §40): keyed by
  `(agent, prompt_version, input_hash)` with **no user_id column** — Layer-1
  work is user-agnostic by construction, so the second holder of a security
  amortises the first's cost. Personal (Layer-2) work is never cached (§40.4).
- **Specialists + Red Team + PSA** (`@atlas/agents`): three Layer-1 specialists
  (financial, valuation, news) and the Red Team (§22.9, `large`/Opus) produce
  `Finding`s; the PSA (§22.11) is the Layer-2 chokepoint that assembles a
  `ContextualizationDoc` — facts by signal reference, T1/T2 tensions anchored to
  and quoting the user's own rows (§28.2), the Red Team countercase, the honest
  unknown — and renders it through the egress Guard. Static named orchestrator
  plans (`contextualize`, `deep_analysis`; D-009, no model-generated control
  flow). Exposed as `POST /v1/contextualize` with the §31.4 envelope.
- **LLM-narrated Reality Check & Briefs** (§B1): a model rephrases prose Atlas
  already computed. `guardText` (lexical + classifier only — structural is for
  the doc, whose numbers are references) screens narrated prose; `renderNarration`
  in egress records the decision and keeps egress the Guard's sole caller.
  `narrate()` in `@atlas/agents` wraps `runAgent` with a narrator prompt.
  Wired into the reality-check endpoint and the brief worker; provenance records
  the model and whether it degraded.

## Key decisions

1. **The `fallback` (template) is the mock, the degradation path, and the
   provenance anchor — one mechanism, three jobs.** The deterministic template
   the orchestration already assembles is passed into every request. The mock
   returns it verbatim; the real model degrades to it on error/refusal/ceiling;
   and for narration it is the numeral-provenanced source. No fixture files,
   and the mock/real seam is invisible to callers.
2. **Narration gets its own doctrine and its own guard mode.** The shared agent
   DOCTRINE forbids producing numbers (numbers are signal references in the
   doc); narration legitimately carries **provenanced inline numerals**. So the
   narrator prompt keeps the directive ban but permits numerals, and `guardText`
   runs layers 2–3 without the structural "numbers must be references" check.
   Three non-model gates keep it honest: fallback-is-template, numeral-preservation
   (any invented/altered figure ⇒ degrade), and the Guard.
3. **Personal vs shared is a property of `userId`, enforced in one place.**
   `runAgent` caches iff `userId === null`. Specialists pass `null` (shared);
   PSA and narration pass the real user (never cached). Nothing downstream can
   accidentally cache a personalised output.
4. **Prompt registration is idempotent.** The agents package can be instantiated
   more than once in a process (source + built copies) while sharing the single
   runtime registry singleton; `agentPrompt` tries `getPrompt` before
   `registerPrompt` so a second instance does not throw.
5. **Import cycle broken by extraction, not by layering hacks.** DB→engine
   loaders moved to `@atlas/dataplane` (depends on the engine only), so
   `@atlas/agents` → dataplane/runtime/guard/egress and `apps/api` → agents with
   no cycle.

## Deviations from the PRD

- **No live model.** Per §B8 and explicit approval, 4b ships on the fixture
  provider; the Anthropic provider is written and tested offline (tiers,
  pricing, unconfigured-error) but not exercised against the API. Swapping it in
  is `docs/enabling-anthropic.md` — SDK install + key + one env var.
- **Currency reconciliation outstanding.** `priceEur` returns the USD sticker
  per-MTok rates into the `cost_ledger.eur` column; USD→EUR conversion (or a
  currency-neutral ledger unit) must be settled before go-live because the
  §37.3 ceilings are denominated in that unit. Correctness of routing and
  degradation is unaffected. Tracked in the enablement doc.
- **Cross-vendor judge not yet wired.** `tier: 'judge'` maps to Opus (different
  model, same vendor). The §21.6 L4 cross-*family* judge needs a second provider
  behind the same interface — a provider addition, not a business-layer change.

## Relevance Ranker (§18.3, added post-initial-4b)

Implemented exactly as specified: a pure, deterministic, LLM-independent scoring
engine (`@atlas/relevance`) computing
`w1·materiality + w2·position_weight + w3·thesis_linkage + w4·rule_linkage +
w5·strategy_linkage + w6·novelty + w7·actionability − w8·noise_prior −
w9·recent_volume`. Weights are configurable with **persona-specific defaults**
(persona = the §6.1 strategy) and **user-specific learned overrides** (migration
013 `relevance_weight_overrides`, merged on top of the default at resolve time).
The persona defaults and weekly budgets are **data, not logic** — JSON config
(`packages/relevance/config/persona-weights.json`,
`notification-budgets.json`), loaded and validated once at init, so they can be
retuned without a code change.
Each persona has a **weekly notification budget**, enforced at dispatch
alongside the §18.6 2/day cap: once the week's non-C0 allowance is spent, further
interruptions are suppressed (still in the inbox / Weekly Review, §28.3). Ranking
is deterministic (score DESC, id ASC tie-break). Unit tests cover the formula and
budget enforcement; an integration test covers the weekly-budget suppression path.

## Copilot (§11.2, added post-initial-4b)

Implemented as an AMBIENT capability, not a chatbot screen. A thread is opened
FROM a place in the app (a security, a portfolio, a notification); the server
loads that context (`buildCopilotContext`) so the very first turn already speaks
to what the user is viewing — the user never restates their context. The
dedicated Copilot page is only conversation history.

- Persistence: `copilot_threads` (context binding) + append-only
  `copilot_messages` (migration 014).
- Generation reuses `runAgent` (provider-agnostic, personal → never cached,
  traced + cost-metered) with a `copilot` prompt that has its own doctrine
  (context-grounded, provenanced inline numerals allowed, directive ban kept).
  Three non-model gates, same discipline as narration: grounded fallback,
  numeral-preservation against the loaded context, and the egress Guard.
- Tool-use through the provider: a bounded read-only tool loop (context
  lookups); a no-op under the fixture, exercised by a custom-provider test.
- SSE streaming: the answer is generated AND guarded first, then streamed — the
  server never streams content that has not passed the Guard.
- Refusal evals (§48.5's conversational attacks, deferred from 4a because they
  attacked a Copilot that did not exist): adversarial providers proving a
  directive/rating/prediction is guard-rejected to a safe refusal and an
  invented figure degrades to the grounded fallback.
- Web: a global ⌘K element on every authed surface, context-aware via a React
  subject registry (each view registers what it is showing); the Copilot page
  lists threads. Verified live in the browser (⌘K → context-bound overlay →
  SSE-streamed answer).

## Deliberately deferred (remainder of Phase 4b)

The regeneration loop (guard rejection → regenerate ≤2 → degrade, §21.6) is
partially present: the PSA degrades to a guaranteed-clean safe doc on rejection;
the bounded-retry step is a fixture no-op today (the mock is deterministic) and
lands with the live model.

## Verification

250 automated tests (Phase 1–4a suites unchanged): +11 provider/runtime
(fixture determinism, cache miss→hit amortisation, ceiling degrade-without-spend,
provider-failure degrade, offline Anthropic stub), +5 orchestrator end-to-end
(fan-out → Red Team → PSA → egress with verbatim user quotes, shared-cache
amortised across two users, PSA never cached, §31.4 envelope), +4 narration
(happy rephrase, provider-degrade, numeral-drift, guard-rejection with recorded
audit), plus reality-check and brief narration provenance assertions. Full suite
green.
