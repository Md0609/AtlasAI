# ADR-005 — Architectural review remediation (P1)

Status: accepted · 2026-07-20

## Context

A full architectural review was run against the repository before Phase 5,
covering PRD adherence, package boundaries, dependency direction, abstractions,
duplication, security, performance, test coverage and technical debt. The
codebase came out healthy — structural enforcement of the PRD's intents,
essentially zero debt markers, strong backend coverage. Two findings were rated
**P1** (fix before Phase 5 builds on top). This ADR records their remediation.

The P2/P3 findings (vestigial `@atlas/agents → @atlas/guard` package
dependency, API re-export shims vs direct `@atlas/dataplane` imports, no web
tests, USD→EUR cost-ledger reconciliation, minor duplication) are deliberately
NOT addressed here and remain open.

## P1-1 — Dependency direction: a library depended on an application

**Problem.** `@atlas/workers` depended on `@atlas/api`, importing
`evaluateAndPersistUserRules` from `@atlas/api/internal`. A background worker
therefore pulled in the entire HTTP application (Fastify + every route) to call
one write-path function, coupling worker deploys to the API and inverting the
intended direction (apps should be leaves).

**Decision.** Extract the shared write path into a new package,
**`@atlas/portfolio-core`**: rule evaluation against the consolidated portfolio,
persistence of the evaluations, and the brief enqueue those evaluations trigger.
Both `apps/api` and `services/workers` now depend on it; nothing depends on the
API app.

Why a new package rather than folding it into `@atlas/dataplane`: the dataplane
is deliberately **read-only**, which is what lets the intelligence plane depend
on it without dragging in the job queue. Putting a write path that calls
`enqueue` there would have forced `@atlas/agents` to transitively depend on
`@atlas/bus`. The two packages are now a clean pair — dataplane for reads,
portfolio-core for writes.

`@atlas/api` remains a devDependency of `@atlas/workers`: its integration test
legitimately builds the server. Production dependencies carry no app edge.

**Enforcement.** A new architecture test (§47.2) asserts that no package under
`packages/` or `services/` declares a **production** dependency on any package
under `apps/`. Verified to fail when the edge is reintroduced — this is now a
build failure, not a convention.

## P1-2 — Auth hardening

**Problem.** The session cookie set `httpOnly`, `sameSite=lax`, `maxAge` and
`path`, but **not `Secure`** — so it could ride a plaintext connection. And the
credential endpoints (`/v1/auth/login`, `/v1/auth/register`) had no rate
limiting, leaving the only pre-session surface open to brute force and
credential stuffing. (The cryptography was already sound: Argon2id, opaque
session tokens stored as sha256.)

**Decision.**

- `Secure` is now set on the session cookie, defaulting to on when
  `NODE_ENV === 'production'` and overridable explicitly via
  `ATLAS_COOKIE_SECURE`. Local development and the test suite run over HTTP and
  keep working; a TLS deployment gets the flag without a code change. Read per
  call rather than at module load, so a deployment or test can set it without a
  rebuild.
- `@fastify/rate-limit` is registered **non-globally** (`global: false`): only
  routes that opt in via `config.rateLimit` are limited. Today that is exactly
  the two credential endpoints — everything else already requires a session.
  Defaults: 20 logins / 15 min and 10 registrations / hour per IP, overridable
  via `ATLAS_RATE_LIMIT_LOGIN` / `ATLAS_RATE_LIMIT_REGISTER`, read at route
  registration so they are configurable and testable.

**Known limitation.** The limiter's store is in-process. A multi-instance
deployment must move it to Redis (the plugin supports it) for the limit to be
global rather than per-process. Recorded here so it is not mistaken for done.

## Verification

- Full build clean (`tsc -b` + web bundle).
- **299 tests green** (was 294): +4 auth-hardening integration tests (cookie
  flags incl. the `Secure` toggle; 429 on both credential endpoints past their
  limit), +1 architecture test (dependency direction).
- The new architecture test was verified to genuinely fail when
  `@atlas/api` is re-added to a library's dependencies.
- Fixed a latent, timezone-dependent bug in the §18.3 weekly-budget test found
  by this run: it seeded the notification ledger from Postgres `now()::date`
  (server timezone) while the dispatcher computes its day in **UTC**. Between
  local midnight and UTC midnight the two disagree by a day, putting the seed
  rows on the dispatcher's today and tripping the daily cap before the weekly
  gate. The seed now uses the same UTC arithmetic as the dispatcher.
