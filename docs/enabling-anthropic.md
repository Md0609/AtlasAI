# Enabling the real Anthropic provider

Phase 4b was built **mock-first** (Design §B8, "mock first, replace later").
Every prompt, context builder, cache, cost ceiling, trace, and guard is wired
and tested against a **deterministic fixture provider**. The only missing pieces
to run on the real model are **an SDK dependency, a credential, and one env
var**. Nothing in the business layer changes.

This document is the exact checklist.

---

## TL;DR

```bash
# 1. Add the SDK (it is intentionally NOT a dependency today)
npm i @anthropic-ai/sdk -w @atlas/runtime

# 2. Provide an EU-inference, zero-retention API key (§45.4)
export ANTHROPIC_API_KEY=sk-ant-...

# 3. Select the provider (default is 'fixture')
export ATLAS_LLM_PROVIDER=anthropic
```

That is the entire switch. `git grep` for `ATLAS_LLM_PROVIDER` and
`ANTHROPIC_API_KEY` — they appear only in the runtime provider layer and this
doc. No agent, endpoint, worker, or test references a vendor.

---

## Why nothing else changes

The intelligence plane talks to **one interface**, `LlmProvider`
([`services/intelligence/runtime/src/provider.ts`](../services/intelligence/runtime/src/provider.ts)):

```ts
interface LlmProvider {
  name: string;
  modelFor(tier: ModelTier): string;              // small | mid | large | judge
  priceEur(model: string, usage: LlmUsage): string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}
```

- Agents and endpoints route by **logical tier** (`small`/`mid`/`large`/`judge`,
  §39), never by a vendor model id. The provider maps tier → concrete model.
- `runAgent` ([`runtime/src/run.ts`](../services/intelligence/runtime/src/run.ts))
  is the single execution loop: cache probe → cost ceiling → `provider.complete`
  → trace → ledger → cache write. It is provider-agnostic.
- The provider is chosen in exactly one place, the factory
  ([`runtime/src/providers/factory.ts`](../services/intelligence/runtime/src/providers/factory.ts)),
  from `ATLAS_LLM_PROVIDER`. Default `fixture`.

`FixtureProvider` and `AnthropicProvider` implement the same interface, so
`AnthropicProvider` is a **drop-in** (§39.4, D-021).

---

## What is already written (no work required)

- **`AnthropicProvider.complete()`** is fully implemented against the current
  Messages API: system/message mapping, JSON-output steering, tool-use blocks,
  usage accounting, stop-reason mapping, and **degradation to the deterministic
  template** on any error or refusal (§21.4 / §26.4).
- **Tier → model map** (`TIER_MODEL`) and **per-MTok pricing** (`PRICE_PER_MTOK`)
  are in [`providers/anthropic.ts`](../services/intelligence/runtime/src/providers/anthropic.ts).
- The SDK is imported **lazily via a non-literal specifier**, so the package
  builds and the whole suite runs with **no Anthropic dependency installed**.
  Until configured, `complete()` throws `AnthropicProviderNotConfiguredError`
  with an actionable message; `modelFor()` / `priceEur()` work offline.

---

## Steps in detail

### 1. Install the SDK

```bash
npm i @anthropic-ai/sdk -w @atlas/runtime
```

The lazy dynamic import (`const SDK_MODULE = '@anthropic-ai/sdk'; await import(SDK_MODULE)`)
resolves at call time. No import statements or types elsewhere need editing.

### 2. Credentials — EU inference + zero retention (§45.4)

The **open compliance dependency** for Phase 4b is procurement, not code:
provision `ANTHROPIC_API_KEY` from an organisation configured for **EU inference
and zero data retention**. Do not enable the provider on a key that does not
meet §45.4 — the fixture path is the compliant default until it does.

`AnthropicProvider` reads `process.env.ANTHROPIC_API_KEY` on first `complete()`
(via `ensureClient()`), so the key can be injected by your secret manager at
runtime; it is never read at build or import time.

### 3. Select the provider

```bash
export ATLAS_LLM_PROVIDER=anthropic
```

`getProvider()` caches the choice per process; `resetProviderCache()` exists for
tests. Leaving the var unset (or `=fixture`) keeps the deterministic mock.

---

## Verify the switch

```bash
# offline sanity (no key needed): tiers + pricing resolve
ATLAS_LLM_PROVIDER=anthropic node -e "import('@atlas/runtime').then(m=>{const p=m.getProvider();console.log(p.name,p.modelFor('large'));})"
# => anthropic claude-opus-4-8
```

With a key set, exercise a personal surface end-to-end (e.g. `GET
/v1/portfolios/:id/reality-check`) and confirm in the trace tables:

- `agent_messages.model` shows the real model id (not `fixture-*`), with real
  `input_tokens` / `output_tokens`;
- `cost_ledger` accrues non-zero spend on the surface;
- `guard_decisions` records a verdict for each narrated/contextualised output;
- on a forced error the row shows `degraded:<model>` and the **template** text —
  the user never sees a raw failure.

The Phase-3 templates remain the permanent degradation path (§B10): if the
provider is misconfigured, over the cost ceiling, refuses, drifts on a number,
or trips the Guard, output falls back to the deterministic template.

---

## Things to confirm before go-live

### Model catalogue drift
`TIER_MODEL` and `PRICE_PER_MTOK` were cached from the model catalogue on
2026-06. **Re-verify the model ids and prices** against the current catalogue
before go-live and update the two maps in `providers/anthropic.ts` — they are
the only vendor-specific constants.

### Currency (`priceEur` vs USD sticker prices)
`PRICE_PER_MTOK` holds the **USD** published per-MTok rates, and `priceEur`
returns them as-is into the `cost_ledger.eur` column. Before go-live either
(a) convert USD→EUR with the same FX source the rest of the system uses, or
(b) rename the ledger to a currency-neutral unit. The cost **ceilings** (§37.3)
are denominated in the ledger unit, so this must be settled so the caps mean
what they say. This is the one known numeric to reconcile; it does not affect
routing or correctness of degradation.

### Cross-vendor judge (§21.6 L4, D-021)
`judge` currently maps to Opus — a different model from the `mid` generators,
but the **same vendor**. A truly cross-*family* judge (the L4 backstop) needs a
**second provider** behind the same interface. That is a provider addition, not
a business-layer change: implement another `LlmProvider`, extend the factory's
`ProviderName`, and route `tier: 'judge'` to it. Out of scope for the drop-in
switch; noted here so the seam is visible.

### Prompt-cache / batching economics (§40)
The shared-analysis cache (Layer-1, user-agnostic) already amortises repeat work
regardless of provider. Anthropic prompt caching and batch pricing can lower the
per-call cost further; they are provider-internal optimisations that live in
`AnthropicProvider` and change no contract.

---

## Rollback

Set `ATLAS_LLM_PROVIDER=fixture` (or unset it). Instantly back on the
deterministic mock — same interface, no redeploy of the business layer needed.
Removing the SDK dependency is optional; the lazy import simply goes unused.
