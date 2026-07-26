# Atlas — final readiness review after W0–W4

**Date:** 2026-07-26
**Branch:** `dev` (master untouched throughout, still at Phase 1)
**Scope:** the state of the repository after remediating the pre-beta engineering
review, waves W0 through W4.
**Method:** every finding was reproduced before being changed, and every fix was
verified to fail against the previous behaviour. Where the source review turned
out to be wrong, the discrepancy is recorded rather than implemented.

---

## Summary

Nine P0s were reported. **Seven are closed, one is blocked on counsel, one is
split across the deployment decision.** Every closed finding carries a test that
fails against the code as it was.

The single most consequential fix was not any individual bug. It was W0: the
test gate executed compiled `dist/`, so a mutation to source left the suite
green. Every other assurance in the review — including its own "verified as
sound" section — rested on a gate that did not read the code. That is fixed, and
the closing mutation sweep in this document is only meaningful because it is.

**Atlas can go to a hand-held private beta.** It cannot go to a public
deployment, and the reasons are enumerated below.

---

## 1 · Which P0s are still open?

| # | Status | Evidence |
|---|---|---|
| P0-1 provider default | **Closed** | `ATLAS_LLM_PROVIDER=anthropicc` + `NODE_ENV=production` now throws `LlmProviderNotConfiguredError`. 3 of 7 tests fail against the old ternary |
| P0-2 test gate | **Closed** | A/B on one mutation: alias off → `49 passed`; alias on → `9 failed \| 40 passed` |
| P0-3 FX gaps | **Closed** | 2 of 5 tests fail against the bare `continue`; UI caveats moved outside all branches |
| P0-4 cost basis | **Closed** | Tied ordering reports `expected 300 to be 150` — the exact divergence predicted |
| P0-5 workers | **Closed** | `npm run workers` is `watch`; the due-work sweep runs. Reverting the loop leaves the process killed by signal instead of exiting 0 |
| P0-6 lifecycle | **Closed** | SIGTERM during a 3s request went from `curl exit=52 http=000` to `{"ok":true} http=200` |
| P0-7 operations | **Split** | Backup/restore rehearsed with real data. Process definition and CI are §5 |
| P0-8 capture | **Closed** | 5 of 8 tests fail without the INSERT |
| P0-9 disclosure | **BLOCKED** | FR-12.1 needs counsel; §56 Q-01 is still marked Blocking in the PRD. FR-12.2's marker is scheduled (W8) and needs no legal input |

**Open P0s: one (P0-9), blocked on a legal decision, plus P0-7's
platform-dependent half.**

---

## 2 · Which P1s are still open?

**Closed:** P1-1 (timing), P1-2 (mutants), P1-9 (staleness), P1-10 (`degraded`
rendered), P1-11 (contract drift), P1-13 (config), P1-15 (advisory lock).

**Open, implementable now** — none blocks a private beta:

| # | Finding | Wave |
|---|---|---|
| P1-1 (coverage) | No route tested as the wrong tenant | W5 |
| P1-3 | Guard's quoted-span carve-out untested | W5 |
| P1-4 | CSV import is quadratic | W6 |
| P1-5 | Performance loads unbounded market data | W6 |
| P1-6 | Job lease has no fencing on completion | W6 |
| P1-7 | No idempotency key on `/import` | W6 |
| P1-8 | Ticker-change rewrite non-transactional | W6 |
| P1-12 | Two list surfaces render failure as emptiness | W7 |
| P1-14 | Workers emit no metrics | later |
| P1-17 | Portfolio derivation in HTTP handlers | later |
| P1-18 | 307 untyped queries | later |
| **P1-19** | **Quiet hours (FR-8.6) — unmet `[MVP]` MUST** | **W8, beta blocker by your ruling** |
| P1-20 | Red Team not run on thesis creation | later |
| P1-21 | Copilot omits the §31.4 envelope | later |

**Open P1s: 14. One (P1-19) you have ruled a beta blocker. Two (P1-16, P1-22)
are in §5 and §6.**

---

## 3 · What risks remain for a private beta?

**One, and you have already classified it.**

- **P1-19, quiet hours.** An `[MVP]` MUST with no implementation anywhere: a
  repo-wide grep for `quiet_hours|quietHours|timezone` returns one hit, in a
  test comment. There is no timezone field with which to prevent a 03:00
  notification, and §18.8 lists "anything during quiet hours except C0" as an
  explicitly banned anti-pattern. Restraint is the product's central claim.

Everything else that was a beta risk is closed. Specifically no longer true:

- Atlas cannot now serve template prose as reasoned analysis (P0-1 + the
  `generative` flag, propagated to all three prose surfaces and rendered).
- Portfolio value can no longer be silently wrong (P0-3, P0-4, P1-9).
- The workers run, so the GDPR erasure certificates the API issues will be
  honoured (P0-5).
- A deploy no longer severs in-flight requests, and an unhandled rejection no
  longer exits without a trace (P0-6, N-6).
- Every claim shown to a user is recorded and gradeable (P0-8).

**Residual operational risks, accepted:**

- Shutdown may take the full grace period (default 10s) when keep-alive sockets
  are open. Bounded and correct; matters when setting a supervisor's
  termination timeout.
- The rate limiter is in-memory and per process. Harmless on one instance,
  which is the private-beta shape.

---

## 4 · What prevents a public deployment?

Three things, independent of everything above.

1. **`trustProxy` is unset and the limiter is in-memory** (P1-16 / B-2). Behind
   any load balancer the per-IP limit collapses into one global bucket: 20 bad
   logins lock out every user for 15 minutes, with no account required. Setting
   `trustProxy: true` is *worse* — it lets any client forge `X-Forwarded-For`
   and evade the limit entirely.
2. **No CI** (B-5). `npm test` is now a real gate, but nothing runs it on push.
   84+ commits have reached `dev` ungated.
3. **P0-9 / FR-12.1.** No jurisdiction disclosure at first analytical use, on a
   product whose Path A rests on being an impersonal publisher *that says so*.

Also relevant at public scale but not blocking: P1-4 and P1-5 (quadratic import,
unbounded market-data queries), P1-7 (no idempotency at the money boundary).

---

## 5 · What depends only on the deployment platform?

Each needs a fact, not a preference.

| # | Item | Missing input |
|---|---|---|
| B-1 | Process definition | What supervises the processes — a Dockerfile and a systemd unit share no syntax |
| B-2 | `trustProxy` CIDR | The proxy's address range |
| B-3 | Serving `apps/web/dist` | This API, a CDN, or the platform's static hosting |
| B-4 | Scheduled ingest | Where a daily EOD job runs (would also make `@atlas/workers` depend on `@atlas/ingest`) |
| B-5 | CI | The provider. The job itself is one line |
| B-6 | Backups | Destination, retention, schedule — the script exists and is rehearsed |

**Neutralised meanwhile:** the migrate-then-start ordering B-1 would have
encoded is now enforced *in code* — the API migrates before listening under an
advisory lock, and both processes refuse to start against a stale schema. A
missing process definition can no longer reproduce the N-4 failure silently.

---

## 6 · What depends on legal or product decisions?

| # | Decision | State |
|---|---|---|
| P0-9 / FR-12.1 | Jurisdiction disclosure text | Counsel. §56 Q-01 is **Blocking** in the PRD. No text invented, not marked resolved |
| FR-12.2 | "AI-generated" marker | Product, not legal. Scheduled for W8 |
| P1-19 | Quiet hours disposition | §18.4 says which classes are exempt but not what happens to a suppressed non-C0 brief — deferred to the window's end, or folded into the Weekly Review. Will flag rather than decide |
| P1-22 | Which spec document wins | Yours. Verified: `grep -c "A4.1"` on the PRD returns **0** while 33 code sites cite it; §21.6 line 2570 specifies a Layer-4 LLM judge that is not built; FR-3.1 says ≥5 portfolios against `MAX_PORTFOLIOS = 3` |

---

## 7 · Which guarantees are now protected by tests?

Each of these fails if the guarantee is removed. Verified by reverting the fix,
not asserted.

| Guarantee | Test |
|---|---|
| The suite grades source, not a stale build | `evals/architecture/resolution.test.ts` |
| A mock LLM cannot be selected silently in production | `provider-selection.test.ts` |
| Deterministic output is never presented as model analysis | `degradation-visibility.integration.test.ts` |
| Invalid configuration never becomes a working default | `config.test.ts`, `config-boot.integration.test.ts` |
| Missing FX is declared, not deducted | `fx-gap-declaration.integration.test.ts` |
| Cost basis does not depend on row order | `cost-basis-determinism.integration.test.ts` |
| Freshness is never overstated | `golden/staleness.test.ts` + the API half |
| A degenerate portfolio yields `null`, never a fabricated figure | `golden/declared-gaps.test.ts` |
| The Guard does not approve what it cannot read | `guard.test.ts` (layer 0) |
| Guard approval is not evidence of analysis | `guard.test.ts` |
| Login does not leak account existence | `login-timing.integration.test.ts` |
| Erasure requires re-authentication | `account.integration.test.ts` |
| A dead worker does not silence a user forever | `queue.integration.test.ts` |
| A deploy does not sever in-flight requests | `graceful-shutdown.integration.test.ts` |
| The worker stops cleanly and refuses a stale schema | `watch-lifecycle.integration.test.ts` |
| Every claim is recorded and immutable | `contextualization-capture.integration.test.ts` |
| Logs never contain credentials, tokens or query strings | `observability.integration.test.ts` |
| Atlas cannot be framed; CSP has no `unsafe-inline` | `security-headers.integration.test.ts` |
| A client disconnect cannot take the API down | `sse-resilience.integration.test.ts` |

---

## 8 · What coverage was added?

| | Before remediation | Now |
|---|---:|---:|
| Test files | 42 | **55** |
| Tests | 385 | **496** |
| New test files | — | **18** |
| Workspaces | 17 | 19 (`@atlas/config`, `@atlas/lifecycle`) |
| Migrations | 20 | 23 |

**+111 tests.** Beyond the count, two structural changes matter more:

- Tests now execute **source**, uniformly, with one module instance per
  specifier. Before, resolution was mixed — sometimes within one file — and
  `guardText !== guardText` across two import paths.
- Test files are **type-checked** (N-1). No `tsconfig` included `test/`, and
  esbuild strips types without checking them, so ~4,000 lines had no type
  checking at all. It caught a missing import within ten minutes of landing.

---

## 9 · Final state: build, typecheck, tests, mutation, audit

```
Build       clean — tsc -b across 19 workspaces + apps/web
Typecheck   clean — production AND tests (tsconfig.tests.json)
Tests       496 passed / 55 files
Audit       0 vulnerabilities (npm audit --omit=dev)
Master      untouched, still at Phase 1
```

**Mutation sweep over the critical guarantees, run to close W4:**

| Mutation | Result |
|---|---|
| TWR zero-day guard → `false` | killed (2 failures) |
| XIRR one-signed guard → `false` | killed (1) |
| effective-N divide guard `gt`→`gte` | killed (1) |
| staleness `<`→`>` (engine) | killed (2) |
| Guard language screen → `false` | killed (5) |
| staleness `<`→`>` (API series) | **survived → now killed** |

The sixth was mine: W2 fixed staleness in both the engine and the performance
series but only tested the engine. Flipping the comparison left all 495 tests
green. That is what a mutation sweep is for, and it is the honest note to end
on — the gate is real enough now to catch its own author.

---

## 10 · Discrepancies with the source review

Recorded because implementing a wrong finding is its own defect.

1. **P1-2 — `performance.ts:62` is not redundant.** The review called it
   unkillable, duplicated by the line-74 sign-change guard. With **all-zero
   cashflows** the NPV at the low bracket bound is exactly zero, so
   `if (fLo.isZero()) return lo` fires and returns the bound: `null` with the
   guard, **`-0.9999`** without. A portfolio whose flows net to zero would have
   been shown a 99.99% loss.
2. **P1-13 — `ATLAS_ERASURE_GRACE_DAYS=abc` does not write an Invalid Date.**
   `toISOString()` throws `RangeError` before the INSERT: 500, and **no row**.
   Account deletion was broken rather than silently wrong. The genuinely silent
   corruptions are `""` and negatives, which persist valid-but-wrong dates.
3. **P0-1 — the fixture was not invisible to everyone.** The persisted trace
   carries `fixture-mid`. Invisible to the user and the API, not to an operator
   querying `agent_messages`.
4. **P0-1's recommended fix was wrong** (from the earlier audit): translating the
   Guard's rule set is F-40, a v1.1 feature the PRD defers in three places.
   Implementing it would have been building a feature, not hardening. Layer 0
   fails closed instead.

## 11 · New findings raised during remediation

| # | Finding | Blocks beta? |
|---|---|---|
| N-1 | Test files were never type-checked | Closed in W1 |
| N-4 | Migrations not applied on deploy or start | Closed in W3-A |
| N-5 | `packages/contracts` knows neither `degraded` nor `generative` | No — the drift is closed and the fields are non-optional |
| N-6 | Fastify `close()` drains on no default setting | Closed in W3-A |
| N-7 | `generative` never reached the PSA path | Closed in W4 |

---

## Verdict

**Approve for a private, hand-held beta on a single instance behind TLS, with
one condition: P1-19.** Quiet hours is an unmet `[MVP]` MUST governing the
product's most visible promise, and you have already ruled it a blocker.

**Do not approve a public deployment.** `trustProxy`, CI, and FR-12.1 are all
open, and the first two cannot be closed without the platform decision.

What has changed since the review is not mainly the bug count. It is that the
failure modes are no longer quiet: the Guard refuses what it cannot read,
degradation is visible in the UI, gaps are declared at every `continue`,
staleness reports the oldest contributing date, a dead worker recovers, a
crashed process says why, and every claim is on the record. That was the
review's central diagnosis, and it is the part that is now structural rather
than aspirational.
