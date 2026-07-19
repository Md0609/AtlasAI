# Atlas — Phases 1–4b (Ground truth · The mirror · Commitment loop · Guardrails · Intelligence plane)

Implementation of **Design blueprint §B1 Phases 1–4a** and the **mock-first
core of Phase 4b** for Atlas AI, plus the minimal Phase-0 scaffolding they
structurally require.

- Phase 1 scope: [`docs/adr/ADR-000-phase1-interpretation.md`](docs/adr/ADR-000-phase1-interpretation.md)
- Phase 2 scope ("The mirror" — versioned Investor Profile, scenario risk
  assessment, strategy inference, rules engine, Reality Check, onboarding):
  [`docs/adr/ADR-001-phase2-mirror.md`](docs/adr/ADR-001-phase2-mirror.md)
- Phase 3 scope ("Commitment loop" — immutable Thesis Ledger,
  falsification→auto-radar, event bus + workers, deterministic briefs with
  the notification budget as a schema constraint, decision recording):
  [`docs/adr/ADR-002-phase3-commitment-loop.md`](docs/adr/ADR-002-phase3-commitment-loop.md)
- Phase 4a scope ("Guardrails" — Contextualization schema, 3-layer
  Compliance Guard, typed egress as the sole constructor of
  UserFacingContent, adversarial evals as CI gate, prompt registry,
  tracing + cost ceilings):
  [`docs/adr/ADR-003-phase4a-guardrails.md`](docs/adr/ADR-003-phase4a-guardrails.md)
- Phase 4b scope ("Intelligence plane", mock-first per §B8 — generic
  `LlmProvider` boundary + deterministic fixture + drop-in Anthropic,
  `runAgent` loop with shared-analysis cache and cost ceilings, Layer-1
  specialists + Red Team + Layer-2 PSA chokepoint, LLM-narrated Reality Check
  & Briefs behind the Guard):
  [`docs/adr/ADR-004-phase4b-intelligence-plane.md`](docs/adr/ADR-004-phase4b-intelligence-plane.md).
  Enabling the real model is one env var + a key —
  [`docs/enabling-anthropic.md`](docs/enabling-anthropic.md). Includes the
  deterministic **Relevance Ranker** (§18.3, `@atlas/relevance`): persona-default
  + user-override weights, the exact 9-term formula, weekly persona budgets
  enforced at dispatch. Deferred within 4b: Copilot (§11.2).

## Layout

```
packages/contracts       shared types: canonical records, events, signal values
packages/domain          decimal money (34-digit, banker's rounding), dates, canonical hashing
packages/schema          SQL migrations + migration runner (identity, security master, market data, portfolio)
packages/dataplane       DB→engine loaders (breaks the api→agents cycle; depends on the engine only)
packages/relevance       deterministic Relevance Ranker (§18.3): scoring formula, persona weights, weekly budgets — LLM-independent
services/ingest          vendor adapter boundary, mock vendor with injected defects, pipeline, quality checks
services/signal-engine   deterministic Signal Engine v1 + golden/adversarial/property tests
services/workers         event-bus workers: brief generation (now narrated), notification dispatch
services/intelligence/runtime   LlmProvider boundary, fixture + Anthropic providers, runAgent loop, cache, ceilings, tracing, prompt registry
services/intelligence/guard     stateless 3-layer Compliance Guard (structural, lexical, classifier) + guardText for narration
services/intelligence/egress    sole constructor of UserFacingContent + renderNarration; the Guard's only caller
services/intelligence/agents    Layer-1 specialists + Red Team, Layer-2 PSA, static-plan orchestrator, narration
apps/api                 Fastify API: auth (Argon2id, jurisdiction gate), portfolios, transactions,
                         CSV import with mapping, exposure & performance endpoints (problem+json, trace_id)
apps/web                 React UI: auth, portfolios, positions, exposure (unknown slice + provenance),
                         performance (TWR/MWR, local vs FX), CSV import mapping UI
ops                      quality dashboard v0 (CLI report)
```

## Prerequisites

- Node 22+, npm 10+
- PostgreSQL 16 with a role/database. Default connection string:
  `postgres://atlas:atlas@127.0.0.1:5432/atlas` (override with `ATLAS_DATABASE_URL`).
  Tests use `ATLAS_TEST_DATABASE_URL` (default `.../atlas_test`) and **reset that database**.

In this container Postgres is already provisioned; start it with:

```sh
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/postgresql/16/main \
  -o '-c config_file=/etc/postgresql/16/main/postgresql.conf' -l /tmp/pg.log -w start"
```

## Run

```sh
npm install
npm run build          # tsc project references + web bundle
npm run migrate        # apply SQL migrations
npm run ingest         # mock-vendor EOD snapshot 2026-01-02 → 2026-06-30 + quality report
npm run quality-report # render ops/reports/quality-latest.json
npm run api            # API on :3000
npm run workers        # drain the job queue once (radar eval → briefs → email outbox)
npm run dev -w @atlas/web   # web on :5173 (proxies /v1 to :3000)
```

## Tests

```sh
npm test
```

- `services/signal-engine/golden` — golden datasets (hand-computed expected
  values), adversarial fixtures (§48.2), seeded property tests, byte-identical
  reproducibility (FR-5.6). Release gate for the engine.
- `services/ingest/test` — pipeline against a real Postgres: split-adjustment
  continuity, ticker-change identity, every injected defect caught by quality
  checks, append-only audit trigger, §27.2 architecture rule (no user FKs on
  the security master).
- `apps/api/test` — jurisdiction gate, portfolio cap, transactions→derived
  positions in one DB transaction, CSV import resolving a historical ticker,
  exposure/performance endpoints with provenance + explicit unknown slice.

## Honesty surface (what to look at)

`GET /v1/portfolios/:id/exposure` returns `data` + `provenance`
(engine version, input hash, methodology) + `gaps` + `staleness`. The UNKNOWN
slice from partial fund holdings is rendered in the UI with its own row — it
is never redistributed.
