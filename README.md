# Atlas — Phase 1 (Ground truth)

Implementation of **Design blueprint §B1 Phase 1** for Atlas AI, plus the
minimal Phase-0 scaffolding it structurally requires. Scope, decisions and
deliberate deferrals: [`docs/adr/ADR-000-phase1-interpretation.md`](docs/adr/ADR-000-phase1-interpretation.md).

## Layout

```
packages/contracts       shared types: canonical records, events, signal values
packages/domain          decimal money (34-digit, banker's rounding), dates, canonical hashing
packages/schema          SQL migrations + migration runner (identity, security master, market data, portfolio)
services/ingest          vendor adapter boundary, mock vendor with injected defects, pipeline, quality checks
services/signal-engine   deterministic Signal Engine v1 + golden/adversarial/property tests
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
