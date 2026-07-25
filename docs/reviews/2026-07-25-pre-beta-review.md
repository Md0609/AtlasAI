# Atlas AI — Final Engineering Review Before Private Beta

**Scope:** full codebase, branch `dev` @ `c432122ec5e73f46b8406817a9640b54241874c8`
**Date:** 2026-07-25
**Coordinated by:** atlas-director
**Participants:** atlas-architect, atlas-backend, atlas-frontend-ux, atlas-security, atlas-qa, atlas-product-owner, atlas-devops

All seven specialists inspected the codebase independently and from first principles. No prior review, ADR, comment, or test name was accepted as evidence that a control exists. Every finding below carries a file:line locator that the Director re-verified against the implementation.

---

## Summary

Atlas is two projects at very different levels of maturity sharing one repository.

**The application is well built.** The security posture is the strongest part: across ~64 routes there is no IDOR, no SQL injection, no XSS, and the two hardest invariants in the product — the Compliance Guard cannot be bypassed, and Layer-2 personal data cannot enter the shared cache — are enforced structurally by the type system and the schema rather than by convention. `decimal.js` discipline is complete: no JS float appears in any monetary path, and XIRR returns a declared gap rather than a fabricated root in every degenerate case. `evals/architecture/architecture.test.ts` genuinely functions as the document's immune system. Product conformance is unusually honest — there is **no scope drift at all**, and every deferral is documented in code with the spec's own reasoning.

**The operations are absent.** There is no CI, no deployment definition, no process supervision, no scheduler, no backup or restore, no graceful shutdown, no alerting, and no boot-time configuration validation. The consequence is specific and severe for *this* product: because Atlas's promise is restraint, a worker that dies is indistinguishable from a working product. The 30-day GDPR erasure jobs for which the API has already issued signed certificates to users will never run, because nothing runs the workers.

Between those two poles sits a coherent class of defect that is the real theme of this review: **nothing in Atlas can tell you when it is degraded.** The LLM provider silently falls back to a fixture mock and marks itself `degraded: false`. Portfolio value silently drops positions whose FX is missing and returns `gaps: []`. Staleness is reported as the *newest* price date across a portfolio. The UI declares `degraded` in its types and renders it nowhere. Each of these was built by someone who cared about honesty — the gap-declaration machinery exists and works elsewhere in the same files — which is why they read as omissions rather than as a culture problem.

The single most important thing to fix is not any one bug. It is that the test suite executes compiled `dist/`, not `src/` — a mutation of source code is undetectable by `npm test`, and there is no CI to compensate. Every other assurance in this report rests on tests, and that gate is currently illusory.

---

## P0 — must fix before private beta

### P0-1 · The LLM provider silently defaults to a fixture mock and reports itself healthy

- **Severity:** P0
- **Type:** Architectural weakness
- **Why it matters:** A deploy that omits or misspells `ATLAS_LLM_PROVIDER` serves deterministic template prose as if it were reasoned model analysis. Nothing downstream distinguishes the two: the fixture sets `degraded: false` deliberately, the Guard approves the text, `guard_approved: true` reaches the SPA, the cost ledger is debited with synthetic prices, and the response still carries `confidence`, `provenance` and `what_would_change_it`. Users make investment decisions on output Atlas presents as reasoned. This is the exact failure mode §0 and §61.3 exist to prevent — confidence asserted rather than earned.
- **Evidence:** `services/intelligence/runtime/src/providers/factory.ts:25` — `const name = (process.env.ATLAS_LLM_PROVIDER ?? 'fixture') as ProviderName;` followed by `cached = name === 'anthropic' ? new AnthropicProvider() : new FixtureProvider();`. The ternary routes *any* non-`'anthropic'` value, including a typo, to the fixture with no error. `services/intelligence/runtime/src/providers/fixture.ts:72-74` makes it undetectable: `degraded: false,` with the comment "the deterministic draft — that IS its answer, not a degradation." `AnthropicProvider.ensureClient` (`providers/anthropic.ts:92`) *does* fail loudly on a missing key — that guard is unreachable when the factory never selects the provider. `apps/api/src/index.ts` is 8 lines and validates nothing before `app.listen`. Independently reported by security, devops and product-owner; Director re-verified verbatim.
- **Files:** `services/intelligence/runtime/src/providers/factory.ts`, `services/intelligence/runtime/src/providers/fixture.ts`, `apps/api/src/index.ts`
- **Recommended fix:** Make the ternary exhaustive over `ProviderName` and throw when the variable is unset or unrecognised under `NODE_ENV === 'production'`. ~5 lines.
- **Confidence:** High

### P0-2 · The test gate executes compiled `dist/`, not `src/` — source mutations are undetectable

- **Severity:** P0
- **Type:** Bug
- **Why it matters:** The golden Signal Engine suite is described in-repo as the one module where a release would be delayed for a single failing test. That gate reads `dist/`. A developer who edits `src/`, runs `npm test` and sees green has tested the previous build. There is no CI to compensate, so `npm test` on a laptop is the entire gate — and it silently invalidates the evidentiary value of every other test-based assurance in this report.
- **Evidence:** `package.json:27` — `"test": "vitest run"` with no build step; `"build"` is separate at `package.json:26`. `services/signal-engine/package.json:7` exports `"./dist/index.js"`, so `import { xirr } from '@atlas/signal-engine'` loads compiled output. QA proved it: 12 mutations applied to `src/` were detected **0/12** (every run: `Test Files 6 passed | Tests 49 passed`); the same 12 mutations applied to `dist/` killed 7. `ls .github/workflows` → no such directory. Mitigating nuance: `npx tsc -b tsconfig.build.json --dry` reports outputs content-current at `c432122`, so today's `dist` matches today's `src`. The bytes are right; the mechanism that guarantees it is absent.
- **Files:** `package.json`, `services/signal-engine/package.json`, `vitest.config.ts`
- **Recommended fix:** One line — `"test": "tsc -b tsconfig.build.json && vitest run"`.
- **Confidence:** High

### P0-3 · Missing FX silently deletes value from the portfolio, and the UI hides the gap in exactly the branch where it matters

- **Severity:** P0
- **Type:** Bug
- **Why it matters:** Two independent defects compose into the product's core trust failure. Backend: on any day where an FX rate is unavailable, that position (and cash in that currency) is dropped from portfolio value with **no gap recorded** — TWR, MWR, max drawdown and current drawdown are then computed on the understated series and returned with `gaps: []`. When the rate appears, value jumps and the user sees a fabricated return spike. Frontend: the depressed value routes the user into Reality Check's no-surprise branch, which renders *no* gaps and *no* staleness footer while asserting "Atlas checked your look-through exposure, your concentration, your currency mix and any correlation clusters — and found nothing that should surprise you." The user is told Atlas checked everything, over a portfolio Atlas only partially computed.
- **Evidence:** `apps/api/src/signals.ts:266-275` — two bare `if (rate === null) continue;` with no `gaps.push`, immediately after a missing-*price* branch at `:259-264` that **does** push a gap. So the omission is specific to FX, not a convention. The same condition is handled correctly in the engine: `services/signal-engine/src/valuation.ts:39-47` pushes `no FX path ${price.currency}→${inputs.baseCurrency}`. UI: `apps/web/src/reality-ui.tsx:55-68` (no-surprise branch) renders only `resp.warnings`; `reality-ui.tsx:35-51` (empty branch) renders neither warnings nor gaps; only the surprises branch at `:92-116` renders `warnings` + `gaps` + provenance. Director re-verified both.
- **Files:** `apps/api/src/signals.ts`, `services/signal-engine/src/valuation.ts`, `apps/web/src/reality-ui.tsx`
- **Recommended fix:** Backend — push a deduped gap in both `continue` branches (`gapNoted` already exists for this). Frontend — lift `warnings` + `gaps` + the provenance footer out of the three branches into one block rendered before the early returns, so no branch can omit them.
- **Confidence:** High

### P0-4 · Cost basis is non-deterministic: same-day transactions have no tiebreak and `created_at` is constant within a transaction

- **Severity:** P0
- **Type:** Bug
- **Why it matters:** `avg_cost` is order-dependent and the sort key does not determine an order. Postgres `now()` is `transaction_timestamp()`, constant for a whole transaction, so a CSV import writes every row with an identical `created_at`. Same-day rows for one security then tie on `(trade_date, created_at)` and Postgres returns them in unspecified order. Buy 10@100, buy 10@200, sell 10 on the same date yields `avg_cost = 150` in insertion order and `avg_cost = 0` if the sell folds first (`p.qty` is zero, so cost is never relieved). `recomputeDerivedState` DELETEs and re-INSERTs positions, so the persisted number can change between two runs on identical data, with no gap declared. It feeds every unrealized gain/loss the user sees.
- **Evidence:** `apps/api/src/portfolios.ts:108-113` — `ORDER BY trade_date, created_at`. `packages/schema/migrations/004_portfolio.sql:32` — `created_at timestamptz NOT NULL DEFAULT now()`; `:20` — `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`, so no column recovers insertion order. The import path inserts all rows inside one `BEGIN`/`COMMIT` (`portfolios.ts:494-575`), guaranteeing the tie. Zero-quantity branch: `portfolios.ts:138` — `const avg = p.qty.isZero() ? dec(0) : p.cost.div(p.qty);`. Same unstable sort at `apps/api/src/signals.ts:153`. Director re-verified the SQL, the schema default and the transaction boundaries. Not reproduced against a live database — no PostgreSQL was reachable from the review environment; the finding rests on the SQL plus documented Postgres semantics.
- **Files:** `apps/api/src/portfolios.ts`, `apps/api/src/signals.ts`, `packages/schema/migrations/004_portfolio.sql`
- **Recommended fix:** Add `seq bigint GENERATED ALWAYS AS IDENTITY` to `transactions` and order by `(trade_date, seq)` in both folds. Interim: `ORDER BY trade_date, created_at, id` stops the flapping but fixes an arbitrary order rather than the correct one.
- **Confidence:** High (Medium that the practical trigger — multiple same-day transactions in one security — is common in real imported brokerage history; it is common enough with partial fills)

### P0-5 · Nothing runs the workers, so the entire asynchronous product — including issued GDPR erasure certificates — never executes

- **Severity:** P0
- **Type:** Architectural weakness
- **Why it matters:** The root `workers` script is `drain`: process until quiet, then exit. There is no scheduler anywhere in the repo. `DELETE /v1/account` enqueues `account.erase` with `runAfter` = now + 30 days and returns the user a signed certificate reading "Your data will be erased by \<date\>. This certificate is your proof of request." That job becomes runnable in 30 days and then sits in `job_queue` until a human types a command. The same applies to briefs, radar fires, weekly reviews and EOD ingest. The codebase names this failure itself: "The failure mode is indistinguishable from the product working correctly, because the product's whole promise is that silence is deliberate."
- **Evidence:** `package.json:32` — `"workers": "node services/workers/dist/cli.js drain"`. `grep -rn "cron\|setInterval\|schedule" --include=*.ts apps packages services ops | grep -v test` returns only `scheduled_for` column references and a prose comment — no timer, no cron entry, no scheduler process. A `watch` mode exists and is implemented (`services/workers/src/cli.ts:24`) but nothing invokes it. Erasure: `apps/api/src/account.ts:212,224,239`. Director re-verified.
- **Files:** `package.json`, `services/workers/src/cli.ts`, `apps/api/src/account.ts`, `services/ingest/src/cli.ts`
- **Recommended fix:** Change the deployed worker invocation to `watch` (already written) and add one scheduled invocation of `ingest` plus the weekly-review fan-out. One line each in whatever process definition P0-7 produces.
- **Confidence:** High

### P0-6 · No graceful shutdown and no crash handlers anywhere

- **Severity:** P0
- **Type:** Bug
- **Why it matters:** Node 22 exits on an unhandled rejection by default, and with no supervisor the API stays down until a human notices. On deploy or any `kill`, `apps/api/src/index.ts` never calls `app.close()` or `pool.end()`, so in-flight requests are severed mid-response — including SSE copilot streams and multi-statement writes.
- **Evidence:** `grep -rn "SIGTERM\|SIGINT\|unhandledRejection\|uncaughtException" --include=*.ts apps packages services ops | grep -v test` returns exactly one match, and it is a comment (`apps/api/src/copilot.ts:266`). Zero handlers registered in the entire codebase. Director re-verified.
- **Files:** `apps/api/src/index.ts`, `services/workers/src/cli.ts`
- **Recommended fix:** `process.on('SIGTERM'|'SIGINT', …)` calling `app.close()` then `pool.end()`; an `unhandledRejection` handler that logs with the trace id before exiting; in the worker `watch` loop, set a flag on SIGTERM and break after the current tick.
- **Confidence:** High

### P0-7 · No deployment definition, no CI, and no backup or restore

- **Severity:** P0
- **Type:** Architectural weakness
- **Why it matters:** Three absences that compound. (a) Nothing states how the API or workers start, whether `migrate` runs before or after new code is live, how the SPA is served, what supervises the processes, or how a bad release is reverted — and no CI gates the 84 commits on `dev` that have never reached `master`. (b) Atlas's core asset is hand-entered transaction history and an immutable thesis ledger, data the user cannot re-derive from anywhere; there is no `pg_dump`, no snapshot configuration, no PITR setting, no restore script, and therefore no restore that has ever been exercised. Backup is not the test — restore is, and there is nothing to test.
- **Evidence:** `ls -la .github Dockerfile docker-compose.yml Procfile` → all "No such file or directory" (Director re-verified). A repo-wide `find` for `*.yml`, `*.yaml`, `*.tf`, `Procfile`, `*.service`, `deploy*`, `.env*`, `*.sh` returns **no output** — not one such file exists. `@fastify/static` is not registered, so `apps/web/dist` is served by nothing. `git rev-list --count master..dev` = 84; `git branch -a | wc -l` = 41. Backup search: every hit for `backup|restore|pg_dump|pitr` in `.ts`/`.sql` is the SQL keyword `ROLLBACK` in transaction handling.
- **Files:** repository root, `packages/schema/`, `README.md`
- **Recommended fix:** One committed process definition declaring migrate-then-start ordering, the API command, the worker `watch` command, a restart policy and a static route for `apps/web/dist`; one CI job running `npm ci && npm run build && npm test` (which also closes P0-2); one script that dumps *and restores into a scratch database*, executed once before beta to prove the restore works.
- **Confidence:** High

### P0-8 · Contextualizations are generated and discarded — the Scorecard data capture the spec calls irreversible does not exist

- **Severity:** P0
- **Type:** Bug (missing mandatory requirement)
- **Why it matters:** §51.4 names this as the one mistake that cannot be undone: the data model and event capture ship at MVP "because retrofitting them would mean the first 12 months of claims are ungradeable forever." `POST /v1/contextualize` builds a full `ContextualizationDoc` including `confidence.whatWouldChangeIt` — the falsifier set a grader needs — serialises it to the client and returns. Nothing is written. Every claim Atlas makes during beta is permanently ungradeable. This also breaks FR-10.1 (`[MVP]` MUST: "System MUST persist … contextualizations") and FR-12.4. It is time-sensitive in a way no other finding here is.
- **Evidence:** `apps/api/src/contextualize.ts:32-89` — the handler calls `contextualize(pool, {…})` then `reply.send({…})`. Director grep of the file for `INSERT INTO|recordEvent|reply.send` returns **only** `68: return reply.send({`. By contrast the Copilot path does persist (`apps/api/src/copilot.ts:210,216` → `rememberTurn`), so the omission is specific. `packages/schema/migrations/018_memory.sql:21` restricts `memory_items.kind` to `copilot_exchange|note`.
- **Files:** `apps/api/src/contextualize.ts`, `packages/schema/migrations/018_memory.sql`
- **Recommended fix:** Persist the `ContextualizationDoc` (doc JSON, signals, confidence, generator, trace_id) append-only on every successful contextualize. Do **not** build the grader — §51.4 defers that to v1.1; only the capture is due now.
- **Confidence:** High

### P0-9 · FR-12.1 and FR-12.2 absent: no jurisdiction disclosure gate, no AI-generated labelling

- **Severity:** P0
- **Type:** Bug (missing mandatory requirement)
- **Why it matters:** Path A (§0, D-000) rests on Atlas being an impersonal publisher *that says so*. Both requirements are `[MVP]` MUSTs and are the two cheapest, most visible artefacts a regulator or counsel looks for first. Atlas ships model-generated prose across Reality Check narration, briefs, Copilot and contextualization with no label identifying it as AI-generated, and no jurisdiction-appropriate disclosure acknowledged at first analytical use. The Guard protects the *content*; nothing establishes the *posture*. §56 Q-01 ("Is the Contextualization Doctrine legally durable in DE/FR/NL/ES?") is marked **Blocking** and is still open, which makes this load-bearing on a live code path rather than on a plan.
- **Evidence:** §8 FR-12.1, FR-12.2. Grep for `disclosure|disclaimer|AI-generated|language model` across `apps/web/src` and `apps/api/src` returns zero product surfaces — only comments. The nearest copy is positioning, not disclosure: `apps/web/src/App.tsx:112` "It never tells you what to buy or sell." Jurisdiction is captured and gates registration (`apps/web/src/App.tsx:80,138`) but never drives a disclosure.
- **Files:** `apps/web/src/App.tsx`, `apps/web/src/copilot-ui.tsx`, `apps/web/src/reality-ui.tsx`, `apps/api/src/`
- **Recommended fix:** A per-jurisdiction disclosure row acknowledged once before the first analytical call (blocking, versioned so re-acknowledgement is possible), plus a persistent "generated by Atlas's models" marker on every surface rendering `UserFacingContent`.
- **Confidence:** High

---

## P1 — fix before public launch; accept knowingly for a private beta

### P1-1 · No route is tested as the wrong tenant; only 3 of ~64 routes are tested unauthenticated

- **Severity:** P1
- **Type:** Technical debt
- **Why it matters:** *Director's note — this resolves an apparent disagreement between two specialists.* Security enumerated all ~64 routes and found **no IDOR**: every `:id` handler either calls an ownership helper or carries the owner predicate inline in the same statement that mutates, returning 404 rather than 403. The control is correct today. QA found that **nothing asserts it**. So this is not a live vulnerability — it is the most important control in the product standing entirely on manual review. Dropping `AND user_id = $2`, or forgetting the helper on a new route, produces a fully green suite and a total cross-tenant breach.
- **Evidence:** `grep -rhoE "app\.(get|post|patch|delete|put)\(" apps/api/src/*.ts | wc -l` → 64. Director's grep for cross-tenant scenarios across `apps/api/test/` returns 1 match. Only 4 test files create a second user at all, and the one bystander (`apps/api/test/account.integration.test.ts:167-169`) is row-counted after a deletion and never issues an authenticated request against the first user's resources. `auth: false` appears in one file only (`api.integration.test.ts`, 3 occurrences).
- **Files:** `apps/api/src/portfolios.ts:90-101`, `apps/api/test/`
- **Recommended fix:** One parameterised `cross-tenant.integration.test.ts`: register A and B, create a portfolio as A, loop every `:portfolioId` route asserting B receives 404; same loop with no cookie asserting 401.
- **Confidence:** High

### P1-2 · Five mutants survive on the Signal Engine's declared-gap guards — the trust boundary is the least-defended code

- **Severity:** P1
- **Type:** Bug
- **Why it matters:** These are precisely the branches that decide whether Atlas shows a number or honestly declares a gap. Each surviving mutant is a way to emit a fabricated figure — a `NaN`, an `Infinity`, or a bogus IRR — where the design promises `null`.
- **Evidence:** Mutations applied to `dist/`, one at a time, reverted after each. `performance.ts:38` `if (denom.isZero()) continue;` → `if (false)` → **survived** (49 tests passed). `performance.ts:74` sign-change guard → `if (false)` → **survived**: XIRR non-convergence returns a meaningless bisection midpoint. `concentration.ts:30` `knownTotal.gt(0)` → `.gte(0)` → **survived**. `performance.ts:62` one-signed guard → **survived** (the existing test passes because the line-74 guard redundantly catches the same case). Overall 7 killed / 5 survived on the code the team calls the release gate — the kills confirm the harness works, which is what makes the survivors meaningful.
- **Files:** `services/signal-engine/src/performance.ts`, `services/signal-engine/src/concentration.ts`, `services/signal-engine/golden/golden.test.ts`
- **Recommended fix:** Three cases in `golden.test.ts`: TWR over a series containing a zero-value day returns a finite Dec; `xirr([{-100,d0},{+1,d365}])` returns `null`; concentration with all-zero named weights returns no effective-N.
- **Confidence:** High

### P1-3 · The Guard's quoted-span carve-out — its only bypass surface — has zero tests

- **Severity:** P1
- **Type:** Bug
- **Why it matters:** `classifyRecommendation` deliberately excludes quoted segments from scanning. That exclusion is exactly what an attacker would target: get directive text classified as a quoted span and the recommendation classifier never sees it. The 56-case escape corpus contains no quoted-span case, so the carve-out's boundary is unverified in both directions.
- **Evidence:** `services/intelligence/guard/src/classifier.ts:45-48` — `.filter((s) => !s.quoted)`. Mutated in `dist/` to `.filter(() => true)` → 86 tests still passed. The threshold mutant (`0.15` → `1000`) killed 10 tests, so the corpus does exercise the classifier — just never with `quoted: true`.
- **Files:** `services/intelligence/guard/src/classifier.ts`, `evals/adversarial/guard-escape.test.ts`
- **Recommended fix:** Two cases: a directive inside `quoted: true` is approved; the same directive in an adjacent `quoted: false` segment is rejected.
- **Confidence:** High

### P1-4 · CSV import is quadratic — the full derived-state fold runs once per row inside one transaction

- **Severity:** P1
- **Type:** Bug
- **Why it matters:** `insertTransaction` calls `recomputeDerivedState` unconditionally, and the import loop calls it once per row (twice with `assume_funded`). A 5,000-row import performs up to 10,000 full folds, each re-reading every transaction and re-issuing `DELETE`+`INSERT` for every position and cash row — roughly 5×10⁷ row reads and ~10⁵ write statements inside a single open transaction holding row locks. The import times out or holds locks for minutes, and the user sees a failed import of a file the product told them was within limits.
- **Evidence:** `apps/api/src/portfolios.ts:243` — `await recomputeDerivedState(client, portfolioId);` at the end of `insertTransaction`; called at `:550` and `:558` inside the row loop; `:23` — `const MAX_IMPORT_ROWS = 5000`. Director re-verified the call sites and the single `BEGIN` at `:494` / `COMMIT` at `:575`.
- **Files:** `apps/api/src/portfolios.ts`
- **Recommended fix:** Split `insertTransaction` into an insert-only form; call `recomputeDerivedState` exactly once after the loop, beside the existing single `evaluateAndPersistUserRules` call at `:570` whose comment already states the "one evaluation for the whole import" intent.
- **Confidence:** High

### P1-5 · Performance endpoint loads unbounded market data and scans it linearly inside the day×security loop

- **Severity:** P1
- **Type:** Bug
- **Why it matters:** The whole `fx_rates` table is selected with no filter, and `price_bars` for every security ever transacted with no date bound; `lastAtOrBefore` then linear-scans those arrays per (day, security) and twice more per FX lookup. A 10-year, 50-security portfolio is ~3×10⁸ decimal comparisons per request. `fx_rates` growth degrades every user's request, not just large ones.
- **Evidence:** `apps/api/src/signals.ts:166-169` — `SELECT … FROM fx_rates ORDER BY rate_date` with no `WHERE` and no `LIMIT`; `:159-164` — `FROM price_bars WHERE security_id = ANY($1)` with no date bound; `:191-199` — `lastAtOrBefore` is a linear scan, invoked at `:258`, `:266`, `:272` inside `for (const day of days)`.
- **Files:** `apps/api/src/signals.ts`
- **Recommended fix:** Bound both queries by `[firstTx, lastBar]` plus one bar before the window, and replace `lastAtOrBefore` with a per-series cursor advanced monotonically — the day loop is already ascending, so the scan becomes O(D + B) with identical results.
- **Confidence:** High

### P1-6 · Job lease covers a whole batch but jobs run serially, and completion has no fencing

- **Severity:** P1
- **Type:** Bug
- **Why it matters:** *Director's note — this refines rather than contradicts the devops finding that mid-job crash recovery works.* Recovery does work. Fencing does not. `claimJobs` stamps `locked_until = now() + 300s` on up to 16 jobs, then `tick()` runs them one at a time. If the batch exceeds 300s in total, the tail is reclaimed by another worker while the first is still executing it, and each reclaim increments `attempts` — so a slow-but-healthy job can be marched to `'dead'` by queueing alone, and the user silently stops getting briefs. `completeJob`/`failJob` key on `id` with no lease predicate, so a stale worker finishing late can overwrite a job another worker now owns.
- **Evidence:** `packages/bus/src/index.ts:87` — `const LEASE_SECONDS = 300;`; `:119-123` — `attempts = attempts + CASE WHEN status = 'processing' THEN 1 ELSE 0 END`; `services/workers/src/runner.ts:32` — `tick(batchSize = 16)` with a serial `for (const job of jobs)` at `:44`; `bus/index.ts:155-181` — `UPDATE job_queue SET status = 'done' … WHERE id = $1`, no lease predicate. The claim query itself *is* correctly atomic (`UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`).
- **Files:** `packages/bus/src/index.ts`, `services/workers/src/runner.ts`
- **Recommended fix:** Renew the lease immediately before each handler (`UPDATE … WHERE id = $1 AND status = 'processing' RETURNING id`; skip if no row — that is also the fencing check), and add `AND locked_until > now()` to `completeJob`/`failJob`.
- **Confidence:** High

### P1-7 · No idempotency key on transactions: a retried or double-clicked import doubles the portfolio

- **Severity:** P1
- **Type:** Architectural weakness
- **Why it matters:** `transactions` has a random-uuid PK and no natural or client-supplied uniqueness. `POST /…/import` is not idempotent — a double submit, or a client retry on the timeout that P1-4 makes likely, doubles every position and cash balance with no way to identify the duplicates. The at-least-once discipline applied rigorously to the job queue is absent at the boundary where money enters. Compounded by P1-11: six of seven write forms have no double-submit guard.
- **Evidence:** `packages/schema/migrations/004_portfolio.sql:19-38` — `PRIMARY KEY (id)` on `gen_random_uuid()`, one `CHECK` on `tx_type`, no `UNIQUE` of any kind. `apps/api/src/portfolios.ts:227-242` inserts unconditionally with no `ON CONFLICT`.
- **Files:** `packages/schema/migrations/004_portfolio.sql`, `apps/api/src/portfolios.ts`
- **Recommended fix:** Require an `Idempotency-Key` header on `/import`, recorded in a table with a `UNIQUE` constraint checked at the start of the transaction. Or `import_batch_id uuid` + `UNIQUE (portfolio_id, import_batch_id, source_line)`.
- **Confidence:** High

### P1-8 · Ticker-change listing rewrite is non-transactional and unrecoverable if it fails midway

- **Severity:** P1
- **Type:** Bug
- **Why it matters:** Closing the old listing window and opening the new one are two autocommitted statements on the pool. If the process dies between them, the security is left with **no live listing**, and re-running ingest does not repair it — the recovery branch's own `WHERE valid_to IS NULL` query now returns nothing. Every future ticker→security resolution fails permanently, and CSV imports of that ticker are reported to the user as "could not resolve security" rather than as a data-integrity fault. Separately, the `NOT EXISTS` guard is not race-safe and no unique index covers closed windows, so two concurrent ingest runs create duplicate historical windows, after which the resolver skips the user's rows as ambiguous.
- **Evidence:** `services/ingest/src/pipeline.ts:202-237` — all statements use `this.pool.query`, not a transaction client; compare `:91-93` and `:258-260` where other stages correctly do `pool.connect()` + `BEGIN`. `packages/schema/migrations/002_security_master.sql:63` — `listings_live_uni` is partial (`WHERE valid_to IS NULL`).
- **Files:** `services/ingest/src/pipeline.ts`, `packages/schema/migrations/002_security_master.sql`
- **Recommended fix:** Wrap the `ticker_change` block in `BEGIN`/`COMMIT` like the other stages, and add `CREATE UNIQUE INDEX listings_window_uni ON listings (security_id, exchange, ticker, valid_from)` so the guard becomes `ON CONFLICT DO NOTHING`.
- **Confidence:** High

### P1-9 · `staleness.prices_as_of` is a maximum, rendered as a portfolio-wide claim

- **Severity:** P1
- **Type:** Bug
- **Why it matters:** The engine takes the *newest* price date across all positions and the UI prints it as an unqualified statement about the whole portfolio. A portfolio holding one six-month-stale position reads "prices as of 25 Jul 2026". The stale position is still valued at its six-month-old price and folded into total value, weights, concentration and the Reality Check denominator. There is no per-position price or as-of anywhere in the UI to contradict it. Ingest already computes exactly this staleness signal — it lands in the ops dashboard, not in front of the user.
- **Evidence:** `services/signal-engine/src/valuation.ts:48` — `if (!pricesAsOf || price.asOf > pricesAsOf) pricesAsOf = price.asOf;` (max). Consumed at `apps/api/src/signals.ts:68,120`. Rendered at `apps/web/src/App.tsx:586` and `apps/web/src/reality-ui.tsx:113-114`. Positions table (`App.tsx:456-471`) shows Security / Qty / Avg cost only. Unbounded lookback in the loader: `packages/dataplane/src/inputs.ts:112-115`, no date predicate. The signal exists at `services/ingest/src/quality.ts:67-74`.
- **Files:** `services/signal-engine/src/valuation.ts`, `packages/dataplane/src/inputs.ts`, `apps/api/src/signals.ts`, `apps/web/src/App.tsx`, `apps/web/src/reality-ui.tsx`
- **Recommended fix:** Report the *oldest* contributing price date (change `>` to `<`) and push a gap for any position trailing `max(asOf)` by more than `STALENESS_WARN_DAYS`. Alternatively relabel the UI string to "newest price", which is the smaller change and makes the current value honest.
- **Confidence:** High

### P1-10 · `degraded` is declared, transmitted, and rendered nowhere

- **Severity:** P1
- **Type:** Bug
- **Why it matters:** When narration falls back to the deterministic template because the model drifted on a number, or a Copilot answer comes back degraded, the UI presents it byte-identically to a healthy answer. `guard_approved` has a visible treatment; `degraded` has none. This is the UI half of the silent-degradation theme, and it is what would have made P0-1 visible.
- **Evidence:** `apps/web/src/api.ts:61` declares `degraded?: boolean`; `api.ts:115,131` carry it in the SSE `done` payload; `apps/api/src/reality.ts:144-150` sends `provenance.narration.degraded`. Grep across `apps/web/src` for `degraded` returns only those plumbing sites — zero render sites. The web `RealityCheckResponse` type (`api.ts:262-281`) has no `narration` field, so `narrationDegraded` is not even representable.
- **Files:** `apps/web/src/api.ts`, `apps/web/src/copilot-ui.tsx`, `apps/web/src/reality-ui.tsx`
- **Recommended fix:** Add `provenance.narration.degraded` to `RealityCheckResponse` and render one muted line beside the existing "(withheld…)" treatment at `copilot-ui.tsx:222` and in the Reality Check provenance footer.
- **Confidence:** High

### P1-11 · Contract drift fails open: a guard-withheld Copilot opener renders as a normal answer

- **Severity:** P1
- **Type:** Bug
- **Why it matters:** `POST /v1/copilot/threads` omits `guard_approved`; the hand-written web type marks it optional so TypeScript is satisfied; the strict-equality check `m.guard_approved === false` is false for `undefined`. A guard-refused opening turn is shown to the user as if Atlas answered it. This is the concrete cost of `apps/web` having zero `@atlas/*` dependencies — it would have been a compile error had the web imported from `packages/contracts`.
- **Evidence:** `apps/api/src/copilot.ts:178-183` returns `{ id, role, content, created_at }` — no `degraded`, no `guard_approved`. `apps/api/src/copilot.ts:127-131` (`GET /threads/:id`) *does* select both. Web: `apps/web/src/api.ts:62` `guard_approved?: boolean;`; `apps/web/src/copilot-ui.tsx:222`. A second instance: `PerformanceResponse` (`api.ts:394-405`) omits `provenance`, `fx_as_of` and `holdings_as_of`, all of which the API sends (`signals.ts:111-121`) — so Performance figures render with no as-of date and no provenance, unlike every other number surface.
- **Files:** `apps/api/src/copilot.ts`, `apps/web/src/api.ts`, `apps/web/src/copilot-ui.tsx`, `apps/web/src/App.tsx`
- **Recommended fix:** Add both fields to the 201 payload; widen `PerformanceResponse` and copy the Exposure provenance footer into Performance. Structurally: have `apps/web` depend on `packages/contracts`.
- **Confidence:** High

### P1-12 · Two list surfaces render "the request failed" as "you own nothing", and six write forms have no double-submit guard

- **Severity:** P1
- **Type:** Bug
- **Why it matters:** `use-resource.ts` exists specifically to prevent the first, and the two highest-traffic list surfaces never adopted it: on a 5xx the Positions table tells a user with 40 positions "Nothing here yet. Add your holdings one at a time below, or import a file." The plausible next action is re-importing holdings that already exist — which, given P1-7, doubles the portfolio. Separately, a double-clicked "Import" writes every transaction twice, a double-clicked "Record cash" books the deposit twice, and a double-clicked "Record decision" puts two entries in a journal whose entire value is being an accurate record.
- **Evidence:** `apps/web/src/App.tsx:425-436` — `refresh` with no `.catch`, then `:451-454` renders the empty state; same shape at `:185-186`/`:264` and `copilot-ui.tsx:315`/`:346`. `add-holding.tsx:191` is the correct pattern (`disabled={!ready || saving}`); unguarded: `import-csv.tsx:127`, `App.tsx:281`, `App.tsx:498`, `today-ui.tsx:313`, `radar-ui.tsx:221`, `thesis-ui.tsx:225-226`. Silent unhandled rejections on write: `App.tsx:438-446`, `today-ui.tsx:266`, `App.tsx:60`, `import-csv.tsx:42`.
- **Files:** `apps/web/src/App.tsx`, `apps/web/src/copilot-ui.tsx`, `apps/web/src/import-csv.tsx`, `apps/web/src/today-ui.tsx`, `apps/web/src/radar-ui.tsx`, `apps/web/src/thesis-ui.tsx`
- **Recommended fix:** Convert `Positions`, `Home.refresh` and `CopilotHistory` to `useResource` + `ErrorState`; copy the `saving` state from `add-holding.tsx:36` into each write form, starting with the two that write transactions.
- **Confidence:** High

### P1-13 · No boot-time configuration validation; every production-critical setting has a silently-working default

- **Severity:** P1
- **Type:** Architectural weakness
- **Why it matters:** A misconfigured deploy starts successfully and behaves wrongly rather than refusing to boot. The database falls back to a localhost dev instance with published credentials; the LLM falls back to the fixture (P0-1); `/metrics` returns 404 rather than erroring if its token is unset, making a scraper misconfiguration indistinguishable from the endpoint not existing; and `ATLAS_COOKIE_SECURE` defers to `NODE_ENV`, so a deploy that forgets `NODE_ENV=production` ships non-`Secure` session cookies and no HSTS. `Number(process.env.X ?? d)` is used in five places with no `isFinite` guard, so `ATLAS_ERASURE_GRACE_DAYS=abc` writes an Invalid Date into `account_deletions.scheduled_for`. Of 14 variables read, 5 appear in any documentation; there is no `.env.example`.
- **Evidence:** `packages/schema/src/index.ts:13-18` — `?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas'`; `apps/api/src/observability.ts:129-130`; `apps/api/src/auth.ts:37-39`; `apps/api/src/account.ts:26`; `apps/api/src/auth.ts:124-125`. `ls -la .env*` → no such file; no `dotenv` dependency anywhere.
- **Files:** `apps/api/src/index.ts`, `packages/schema/src/index.ts`, `apps/api/src/auth.ts`, `apps/api/src/account.ts`
- **Recommended fix:** One `config.ts` read and validated once at boot, throwing on a missing `ATLAS_DATABASE_URL` in production and rejecting non-finite numerics; called on line 1 of `index.ts`. Commit a `.env.example` enumerating all 14.
- **Confidence:** High

### P1-14 · Nothing is exported off-box, and worker processes emit no metrics at all

- **Severity:** P1
- **Type:** Architectural weakness
- **Why it matters:** `/metrics` is the only export surface and lives exclusively in the API process — `count()` is called in exactly two places, both in `apps/api`. No worker, runtime or ingest path increments a counter, so there is no signal for handler failures, lease expiries, provider errors, degradation rate, or model spend. Spend is fully recorded in `cost_ledger` yet never surfaced, so a cost blowout is discoverable only by hand-written SQL. Trace ids *do* propagate end to end (API → worker → model call) but terminate in a database table rather than a log aggregator.
- **Evidence:** `apps/api/src/observability.ts:117`, `apps/api/src/server.ts:101` are the only `count()` call sites. `apps/api/src/observability.ts:129-130` gates `/metrics` behind an undocumented token. No Prometheus/OTel/StatsD/Sentry dependency in any `package.json`; no scrape configuration anywhere. `services/intelligence/runtime/src/cost.ts:21-36`.
- **Files:** `apps/api/src/observability.ts`, `services/workers/src/runner.ts`, `services/intelligence/runtime/src/cost.ts`
- **Recommended fix:** Move `count()` into a shared package so `runner.ts` can increment `atlas_jobs_failed_total`/`atlas_jobs_dead_total` on its `catch` at `:53`; add `atlas_cost_eur_total` beside the existing queue-depth gauge; add a worker heartbeat row exposed as a gauge — the minimum signal that the worker is alive.
- **Confidence:** High

### P1-15 · Migration runner has no advisory lock and no down path

- **Severity:** P1
- **Type:** Architectural weakness
- **Why it matters:** Two processes running `migrate` concurrently both read the same pending set and attempt the same DDL. Per-file `BEGIN`/`COMMIT` means the loser fails cleanly, so a half-applied *file* is impossible — but a half-applied *set* is not: files 001-014 commit, 015 fails, and the database is in a state no migration file describes, with no down migration to get back. Forward-only is defensible **if** backup/restore exists; it is not defensible while P0-7 is also open.
- **Evidence:** `grep -rn "advisory\|pg_advisory" --include=*.ts packages/schema/src services apps` → no output. `packages/schema/src/cli.ts` accepts only `up`. 20 forward `.sql` files, zero `.down.sql`. `migrate` is invoked from the CLI and 14 test files — never from application startup, so it has no defined position in a rollout.
- **Files:** `packages/schema/src/index.ts`, `packages/schema/src/cli.ts`
- **Recommended fix:** Wrap the loop in `pg_advisory_lock`/`pg_advisory_unlock`. Two lines.
- **Confidence:** High

### P1-16 · Rate limiter keys on the socket address with `trustProxy` disabled

- **Severity:** P1
- **Type:** Bug
- **Why it matters:** Behind any load balancer the key is the proxy's address for every request. The "per-IP" login limit collapses into a single global bucket of 20 attempts per 15 minutes, so one attacker sending 20 bad logins locks every user out of Atlas for 15 minutes — a trivial DoS requiring no account. Distributed credential stuffing is also indistinguishable from normal traffic. The codebase itself asserts a TLS-terminating proxy is expected (`tlsExpected()`, HSTS wiring).
- **Evidence:** `apps/api/src/server.ts:34-39` constructs Fastify with only `logger` and `genReqId` — no `trustProxy`. `grep -rn "trustProxy\|keyGenerator\|x-forwarded" apps/ packages/ services/` → zero matches outside `dist/`. `server.ts:83` registers `@fastify/rate-limit` with no `keyGenerator`, so it falls back to `req.ip`. Limits at `auth.ts:124-125`.
- **Files:** `apps/api/src/server.ts`, `apps/api/src/auth.ts`
- **Recommended fix:** Set `trustProxy` to the specific proxy CIDR — not `true`, which lets a client forge `X-Forwarded-For` and evade the limit entirely.
- **Confidence:** High

### P1-17 · Portfolio derivation lives in HTTP handlers while `@atlas/portfolio-core` holds one function

- **Severity:** P1
- **Type:** Architectural weakness
- **Why it matters:** This is the structural cause of P0-3 and P0-4, not a coincidence. `recomputeDerivedState` — the canonical fold — is reachable only by importing the Fastify app, so `signals.ts` reimplemented it rather than take that dependency, and the two copies then diverged on gap handling. Every future consumer (a reconciliation job, a backfill CLI, a corporate-action replayer) faces the same choice and will make the same one. `@atlas/portfolio-core`'s own header states the extraction principle; it was applied to rule evaluation and then abandoned.
- **Evidence:** `packages/portfolio-core/src/index.ts` is 111 lines with two exports. `apps/api/src/portfolios.ts:107` — `recomputeDerivedState`, 61 lines of decimal folding; `grep -rn recomputeDerivedState` returns only two hits, both inside `portfolios.ts`. `apps/api/src/portfolios.ts:175-217` — `AMOUNT_SIGN`/`assertAmountSign`/`txAmount`, the cash-sign accounting invariant, defined in an HTTP module. `apps/api/src/signals.ts:147` — `computePerformance`, ~185 lines, callable from nowhere else. `portfolios.ts` is 640 lines with six distinct responsibilities.
- **Files:** `apps/api/src/portfolios.ts`, `apps/api/src/signals.ts`, `packages/portfolio-core/src/index.ts`
- **Recommended fix:** Move `recomputeDerivedState` and the amount-sign trio into `packages/portfolio-core` unchanged — they already take a `pg.PoolClient` and no Fastify types, so the move is mechanical. Then delete the duplicate fold at `signals.ts:231-253`. Land that before moving `computePerformance`.
- **Confidence:** High

### P1-18 · 307 query calls, zero row-type generics — the persistence boundary has no type checking

- **Severity:** P1
- **Type:** Architectural weakness
- **Why it matters:** `pg`'s `QueryResult` defaults to `any`, so every property read off a DB row is unchecked. A column rename produces `undefined` at runtime with no compile error and, in the fold, no exception either — `dec(t.quantity ?? 0)` turns a missing column into a zero-share position. This is the one place in a financial system where silent coercion is unacceptable, and it is where the type system is switched off; the codebase is otherwise unusually disciplined (3 `any` in ~26k LOC, zero `as unknown as`).
- **Evidence:** `grep -rn "\.query<" --include=*.ts packages services apps | grep -v test | wc -l` → **0**; the same grep for `.query(` → **307**. Consequence at `apps/api/src/portfolios.ts:123-136`.
- **Files:** repo-wide; densest in `apps/api/src/portfolios.ts`, `apps/api/src/theses.ts`, `services/workers/src/brief-worker.ts`
- **Recommended fix:** Not repo-wide Zod-on-read. Add row interfaces and use `client.query<TxRow>(…)` at the three folds that produce money. That converts a rename from a silent zero into a compile error where it matters. Leave the rest.
- **Confidence:** High

### P1-19 · Quiet hours (FR-8.6) do not exist anywhere in the system

- **Severity:** P1
- **Type:** Bug (missing mandatory requirement)
- **Why it matters:** FR-8.6 is `[MVP]` MUST, §18.4 carries a dedicated quiet-hours-exempt column for all eight notification classes, and §18.8 lists "anything during quiet hours except C0" as an explicitly banned anti-pattern. Atlas's entire claim is restraint. Waking a user at 03:00 with a C4 drift notification violates the most user-visible promise in §18 — and there is no timezone field with which to prevent it.
- **Evidence:** Grep for `quiet_hours|quietHours|timezone` across `apps`, `packages`, `services` returns exactly one hit, in a test comment (`apps/api/test/briefs.integration.test.ts:341`). `packages/schema/migrations/016_notification_feedback.sql:35-39` — `user_notification_prefs` holds only `weekly_budget_delta`; no window, no timezone.
- **Files:** `packages/schema/migrations/016_notification_feedback.sql`, `services/workers/src/relevance.ts`
- **Recommended fix:** Add user timezone and quiet window to `user_notification_prefs` plus a dispatcher check with a single C0 exemption.
- **Confidence:** High

### P1-20 · FR-6.8 half-met: the Red Team runs on analysis but not on thesis creation

- **Severity:** P1
- **Type:** Bug (partial mandatory requirement)
- **Why it matters:** FR-6.8 is explicit that the Red Team MUST run on "every deep analysis **and every thesis creation**", and §61.4 is titled "mandatory, expensive, never optional". Thesis creation is the higher-value path — the moment a user commits a belief to the ledger, and the one place a bear case changes an outcome. It is unguarded. The requirement currently reads as met.
- **Evidence:** Implemented on analysis: `services/intelligence/agents/src/orchestrator.ts:60` — `const redTeam = await runRedTeam(db, security, l1, opts);`, unconditional. Not on theses: `apps/api/src/theses.ts:12-19` imports `signal-engine`, `bus`, `auth`, `http`, `radar-service` — no `@atlas/agents` import at all; the POST handler (`:122-215`) writes the thesis, auto-generates radars, and invokes no agent.
- **Files:** `apps/api/src/theses.ts`, `services/intelligence/agents/src/orchestrator.ts`
- **Recommended fix:** Either run the Red Team asynchronously on thesis creation and attach the bear case to the record, or amend FR-6.8 to drop the clause and state why. Do not leave it silently half-implemented.
- **Confidence:** High

### P1-21 · Copilot responses omit the §31.4 intelligence envelope entirely

- **Severity:** P1
- **Type:** Bug
- **Why it matters:** §31.4 states that `confidence`, `provenance` and `gaps` are "required, non-nullable fields on every intelligence response … the API physically cannot express a confident, unsourced, gap-free claim." Copilot is the most-used intelligence surface and returns prose with none of them, so FR-11.4 (`[MVP]`, cite sources inline) is not met on that path. The §31.4 guarantee is true only where it was implemented, which makes it a convention rather than the type-system property the spec claims.
- **Evidence:** `apps/api/src/copilot.ts:218-226` returns `{ id, role, content, degraded, guard_approved, created_at }`; same at `:315` for the SSE turn. Compare `apps/api/src/contextualize.ts:62-88`, which builds the envelope (though it omits `confidence.basis` and `staleness`, both named in §31.4).
- **Files:** `apps/api/src/copilot.ts`, `apps/api/src/contextualize.ts`
- **Recommended fix:** Make the envelope a shared response type in `@atlas/contracts` that every intelligence route must construct, so omission is a compile error — which is what §31.4 actually specifies.
- **Confidence:** High

### P1-22 · The Guard ships three layers where PRD §21.6 mandates four, and three spec documents disagree

- **Severity:** P1
- **Type:** Inconsistency
- **Why it matters:** §9.3 sets the Guard escape rate at **0** and calls it "not aspirational". §21.6's L4 — a cross-family LLM judge sampled at 100% for user-facing generative output — exists precisely to catch novel framing the deterministic layers cannot enumerate, and it is absent. L2 is specified as a fine-tuned classifier and implemented as 12 regex cues. The code is honest about this and cites "§A4.1" from `Design.pdf` — but PRD §21.6 was never amended, and `docs/spec/README.md` designates the PRD as the single source of truth. Two engineers reading §21.6 and `guard/src/index.ts` today would build different guards. 33 code sites cite `§A*` sections that do not exist in the PRD; `grep -c "A4.1" docs/spec/atlas-ai-prd-tdd.md` → 0. The same precedence conflict affects FR-3.1 (PRD says ≥5 portfolios, code caps at 3 per Design §A5).
- **Evidence:** `services/intelligence/guard/src/index.ts:10-14` "Three layers, cheapest first (§A4.1)"; `guardCheck` at `:33-49`. `services/intelligence/guard/src/classifier.ts:14` — `CLASSIFIER_VERSION = 'heuristic.v0'`, `:26-39` twelve regex cues. `apps/api/src/portfolios.ts:11` — cap of 3.
- **Files:** `services/intelligence/guard/src/index.ts`, `services/intelligence/guard/src/classifier.ts`, `docs/spec/atlas-ai-prd-tdd.md` §21.6, `docs/spec/README.md`
- **Recommended fix:** Change the **document** first — amend §21.6 and FR-3.1 to state what actually governs pre-beta, and record which source document wins. Then decide whether §9.3's zero-escape target makes L4 a scheduled item.
- **Confidence:** High

---

## P2 — worth tracking; none block a private beta

| # | Title | Type | Evidence | Fix | Conf. |
|---|---|---|---|---|---|
| P2-1 | **Unlimited password guessing against `DELETE /v1/account`.** The re-auth verifies the plaintext with no rate limit — the limiter is non-global and only the two credential routes opt in. An attacker with a stolen session can grind at ~35 guesses/s against a live Argon2id verify, with a 10-char minimum and no complexity or breach check. | Bug | `apps/api/src/account.ts:155` (no route options), `:188-189` verify; `apps/api/src/server.ts:83` `{ global: false }`; `apps/api/src/auth.ts:103` | Add `{ config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }` — the same one-line pattern already at `auth.ts:128` | High |
| P2-2 | **Erasure leaves behind events not partitioned by `user_id`.** The sweep matches `partition_key = userId`; events partitioned by portfolio survive with full payloads (including `inputHash` over holdings) under a 7-year retention, and the user's deletion receipt undercounts. | Bug | `services/workers/src/account-worker.ts:69,80`; `packages/bus/src/index.ts:29-33,48`; `migrations/007_events_queue.sql:5,16` | Extend the match to `OR partition_key IN (SELECT id::text FROM portfolios WHERE user_id = $1)`, ordered **before** the portfolios hard-delete at `:54` | High |
| P2-3 | **`agent_messages` accumulates verbatim Layer-2 model output forever.** Every Copilot turn writes full prose about the user's holdings, keyed to `user_id`, with no TTL and no purge — and an immutability trigger blocks routine cleanup, so the only deletion path is GDPR erasure. | Architectural weakness | `runtime/src/run.ts:210-220`; `runtime/src/tracing.ts:40-56`; `migrations/011_agent_tracing.sql:45` | Stop persisting `output.text` when `userId !== null` — store the existing `outputHash` and token counts, which is what the reproducibility argument actually needs | High |
| P2-4 | **No way to revoke a leaked session but to wait 7 days.** No idle timeout, no rotation, no bulk revocation, no password-change route; logout revokes only the presented token. The export endpoint needs no re-auth, so a stolen cookie is a full personal-data exfiltration. | Architectural weakness | `apps/api/src/auth.ts:17,77-83,204`; `apps/api/src/account.ts:139,170` | For beta, one line: allow logout to revoke by `user_id`. A session list is a feature and out of scope | High |
| P2-5 | **A `buy` with only `amount` is accepted and silently creates no position.** Cash is debited correctly, the fold does `dec(t.quantity ?? 0)`, the holding never appears, and no error explains it. `t.price ?? 0` also understates cost basis. | Bug | `apps/api/src/portfolios.ts:31-41` (both optional for all nine types), `:202-206` (returns before any quantity check), `:133-135`; `migrations/004_portfolio.sql:32` | `superRefine` requiring `quantity` for buy/sell/split/spinoff and `price` for buy/sell; back it with a `CHECK` | High |
| P2-6 | **Currency decomposition falls back to a future price at the window start.** `?? barsBySec.get(sid)?.[0]` substitutes the first available bar, so the local-vs-FX split is computed between non-endpoint prices with no gap recorded. | Bug | `apps/api/src/signals.ts:291` | Drop the `??` — the `if (!startBar \|\| !endBar) continue;` on the next line already handles it — and push a gap there | High |
| P2-7 | **Notification budget is a schema constraint only for the daily cap.** §18.6 is explicit that budget enforcement is a database constraint. The 2/day cap is a trigger; the weekly budget is application code, and the learned delta is applied after config validation, unclamped — so feedback can drive a user to 0/week (below the floor of 1, i.e. permanent silence) or above the ceiling of 6. The five §18.6 adjustment rules are unimplemented. | Inconsistency | `migrations/009_briefs_notifications.sql:48-63`; `packages/relevance/src/index.ts:93-99`; `services/workers/src/relevance.ts:74`; `migrations/016:37` | Clamp to [1,6] at `relevance.ts:74` and add a `CHECK` on `weekly_budget_delta`; mark the adjustment rules post-MVP in §18.6 | High |
| P2-8 | **⌘K dialog declares `aria-modal` with no focus trap and no focus restore.** Tab walks out of the dialog into content it declared inert; on close focus drops to `<body>`. | Bug | `apps/web/src/copilot-ui.tsx:199-205`, `:167-169`. (Escape at `:101-103` and `role="log" aria-live="polite"` at `:216` are correct.) | Capture `document.activeElement` on mount and refocus in cleanup; add a Tab wrap handler | High |
| P2-9 | **Form field borders fail WCAG 1.4.11.** Inputs have no fill contrast against the card, so the 1px border is the only indicator a control exists: **1.31:1** light, **1.28:1** dark, against a 3:1 requirement. | Bug | `apps/web/src/styles.css:35-38` on `.card` `:27-33`; `--line #e3e1db` on `#ffffff`; dark `#35352f` on `#232320` (`:450-463`) | Add a `--field-line` token at ≥3:1 used only by the input rule; leave `--line` as a decorative divider | High |
| P2-10 | **CSV import commits with no parsed-row preview.** The only pre-commit feedback is column mapping; a mis-mapped quantity/price column or reversed date order is written and discovered as wrong numbers, with no undo. Rejected rows *are* surfaced well; accepted-but-wrong rows are not. | Architectural weakness | `apps/web/src/import-csv.tsx:45-57`, `:132-138` | Render the first ~5 rows through the current mapping above the Import button — client-side, no new endpoint | High |
| P2-11 | **Connection pool hardcoded at 10 per process with no override.** Used by API, workers, ingest and the migration CLI. API + 5 workers + ingest = 70 of PostgreSQL's default 100, and there is no pool-saturation metric. | Technical debt | `packages/schema/src/index.ts:21` — the only pool sizing in the codebase | `max: Number(process.env.ATLAS_DB_POOL_MAX ?? 10)`, validated by the P1-13 config check | High |
| P2-12 | **A running instance cannot be traced to a commit.** `/healthz` returns `{ ok: true }`; no version, SHA or build timestamp is emitted at startup, on an endpoint, or in logs. With no CI, the deployed `dist/` could come from any working tree, including a dirty one. | Technical debt | `apps/api/src/index.ts`; `apps/api/src/server.ts:110-113` | Add `version` and a build-time `ATLAS_GIT_SHA` to `/healthz` and the startup log | High |
| P2-13 | **Node version unpinned despite a hard floor.** README says Node 22+; nothing enforces it, and top-level `await` is used in three entry points. No `engines` field in any of the 18 workspace manifests, no `.nvmrc`. | Technical debt | `ls .nvmrc .node-version` → absent; `grep -rn "engines" --include=package.json .` → no output | Add `engines` to the root manifest and a `.nvmrc` | High |
| P2-14 | **Undeclared cross-workspace devDependencies resolve only via hoisting.** `apps/api`, `agents` and `egress` import `@atlas/workers`/`@atlas/api` in tests without declaring them, so the architecture test guards a declaration that does not exist. Root `npm ci` works; `npm ci --workspace=…` or any per-service container build fails — i.e. it breaks the moment P0-7 is fixed with per-service images. | Technical debt | `apps/api/package.json` devDeps = `{"@types/pg"}` vs 7 test files importing `@atlas/workers`; `services/workers/package.json` does it correctly | Add the three entries; optionally extend the architecture test to scan test-file imports | High |
| P2-15 | **`packages/contracts` is types-only, so non-HTTP writers validate nothing.** Zod appears in 11 files, all in `apps/api`, and zero packages or services — so ingest, workers and the intelligence plane write JSONB (`condition_ast`, event payloads) with no runtime check, and the API's Zod schemas are hand-mirrored copies that can drift narrower without a compile error. | Architectural weakness | `packages/contracts/package.json` `"dependencies": {}`; `apps/api/src/radar-service.ts:20-39` (the only `satisfies z.ZodType`) | Move only the shapes that cross a process boundary as JSONB — `RadarCondition` above all — into `contracts` as Zod with `z.infer` deriving the type | High |
| P2-16 | **Dead code kept alive by misleading comments.** `apps/api/src/internal.ts` has no importers — five references to it repo-wide are all comments — yet three files carry shims "so `@atlas/api/internal` keeps resolving", and it remains a published package subpath advertising API internals. | Technical debt | `apps/api/src/internal.ts:11` says so itself; `apps/api/package.json` `"./internal"` export; shims at `profile.ts:160`, `signals.ts:32` | Delete the module, the export and both shims; point callers at `@atlas/dataplane`. Net deletion | High |
| P2-17 | **Bus-owned tables read by direct SQL outside `packages/bus`, including a scheduling decision.** The write seam holds (no `INSERT INTO job_queue`/`events` outside the bus), but `weekly-review-worker.ts:284` makes a de-duplication decision by querying the queue's internal columns, so changing the status vocabulary breaks the scheduler silently, outside the bus's tests. | Architectural weakness | `services/workers/src/weekly-review-worker.ts:284`, `:145`; `apps/api/src/today.ts:50` | Add `enqueueUnique(db, topic, partitionKey, payload)` to `packages/bus` and use it at `:284` — that is the leak with behaviour attached | High |
| P2-18 | **`@atlas/agents` does its own SQL across 10 tables while `@atlas/dataplane` exists as the read layer.** Query knowledge for theses, rules, briefs, decisions and securities is now duplicated across three workspaces, so a schema change touches three instead of one. | Inconsistency | `agents/src/{context,copilot,memory}.ts` (13 `.query(` calls, 12 tables) vs `packages/dataplane/src` (273 lines, 5 exports) | Adopt the rule for new code; move only `buildUserBundle`'s loaders, which already have a twin in `apps/api`. Leave `memory.ts` | High |
| P2-19 | **§9 NFRs are unmeasurable.** Eleven p95 targets in §9.1 and SLOs in §43.2, with no latency instrumentation against any of them — including §9.1's most load-bearing claim, that deep analysis is deliberately slow but visibly working. | Spec gap | `apps/api/src/observability.ts:1-24` — "Counters are aggregate only"; grep for `p95\|histogram\|latency` returns a prose mention. The one latency captured (`guard/src/index.ts:46`) is never aggregated | Instrument the two that gate the experience (deep-analysis p95, Copilot first token); mark the rest v1 in §9.1 rather than leaving eleven unmeasured numbers reading as commitments | High |
| P2-20 | **"Persona" names two incompatible concepts.** In the PRD it is the §5 user archetype and §18.3's budget table is keyed on experience level; in code `Persona` is investment strategy. These are orthogonal — an advanced and a beginner passive-index investor get the same budget in code and different budgets in the spec. Code also cites §18.3 for numbers that live in §18.6. | Inconsistency | `config/notification-budgets.json` (keys `quality_growth`, `value`, `dividend_income`, `passive_index`); `services/workers/src/relevance.ts:60-74` | Rename `Persona` → `StrategyProfile` and fix the citations; then state in §18.3 which axis keys the budget | High |
| P2-21 | **Golden suite has no degenerate-portfolio cases.** Every case is a well-formed hand-computable portfolio. Absent: empty portfolio, single transaction, same-day buy+sell netting to zero, zero/negative quantity, out-of-order dates, sell exceeding holdings, missing FX (missing *price* is covered), last-decimal rounding. First-day and first-import users exercise wholly untested paths. | Technical debt | Full `it()` inventory of `golden.test.ts` + `adversarial.test.ts` (19 cases) | Add the empty portfolio and the same-day buy+sell netting to zero — they also reach the unprotected divide-by-zero guards in P1-2 | High |
| P2-22 | **A missing PostgreSQL makes the suite hang rather than fail.** A gate that hangs burns the CI timeout and yields no diagnosis. A failed `beforeAll` also reports its tests as *skipped*, so a reporter reading test counts rather than exit code would read it as green. | Bug | Full run emitted 3 files then produced no output for 75s+; a no-DB subset failed cleanly in 2.36s with `ECONNREFUSED` at `packages/schema/src/index.ts:71` | `connectionTimeoutMillis: 5000` on the test pool | Medium |
| P2-23 | **`apps/web` — 18 components, 3,920 lines, zero tests**, and `vitest.config.ts` has no `apps/web` glob, so nothing there could run even if written. Every flow through which a user enters financial data is untested. | Technical debt | `find apps/web -name '*.tsx'` → 18 files / 3,920 lines; no `apps/web/test` | Not a coverage target — one test for `import-csv.tsx` asserting a backend-rejected row is surfaced rather than silently dropped | High |
| P2-24 | **`resetDatabase` is a public export of `@atlas/schema`** and therefore ships in the production `dist/` imported by the API, workers and ingest. Test-only by intent, not by construction. | Technical debt | `packages/schema/src/index.ts:70`, exported from the package index | Move it to a `@atlas/schema/testing` subpath not imported by any production entry point | Medium |

---

## Verified as sound

Recorded so these are not re-litigated. Each was checked against the implementation, not against documentation.

**Security**
- **No IDOR across ~64 routes.** Every `:id` handler either calls an ownership helper (`ownedPortfolio`, `ownedThread`) or carries the owner predicate inline in the same statement that mutates, with `RETURNING` + 404 on empty. That shape closes the TOCTOU gap a separate check-then-write would open, and 404-not-403 avoids confirming another tenant's rows.
- **The Guard cannot be bypassed.** `UserFacingContent` has a private constructor, an ECMAScript `#private` brand and a non-exported `Symbol` factory (`egress/src/index.ts:41-68`), so TypeScript treats it nominally and no other module can fabricate one. `guardCheck`/`guardText` are imported by exactly one non-test module. Enforced by the type system, not by review.
- **The shared cache cannot hold personal data.** `shared_analysis_cache` has no `user_id` column at all (`migrations/012:5-9`) and writes are gated on `input.userId === null` (`run.ts:82,233`). Structural, not conventional.
- **No SQL injection.** Every `${}` inside a `query()` interpolates a module-level column constant or a generated placeholder index. No user input reaches an identifier position; no user-controlled `ORDER BY`.
- **No LLM output reaches a write path, a query, or a deterministic calculation.** Copilot tools are read-only, and the numeral-subset gate (`copilot.ts:301-304`) reverts to the deterministic fallback if the model emits a figure absent from the grounded context.
- **No DOM injection** — zero `dangerouslySetInnerHTML`/`innerHTML` in `apps/web/src`; the HTML export escapes and inserts only into text nodes.
- **Login enumeration properly closed** in body, status *and* timing via the decoy hash (`auth.ts:193`).
- **Sessions sound in shape**: 32 random bytes, SHA-256 at rest, `httpOnly`, `sameSite: 'lax'`, `Secure` keyed to TLS expectation; the SPA stores no credential (`api.ts:20`, `credentials: 'include'`). No CORS plugin is registered, so cross-origin reads are blocked by default and no CSRF token is needed.
- **Security headers match their test** — `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`, no `unsafe-inline`, `nosniff`, `no-referrer`, HSTS keyed to `tlsExpected()`.
- **Error handler does not leak internals** (`server.ts:98-108`). **Log redaction is real** — cookies, authorization, set-cookie, password, token; serializers deliberately drop headers, body and query string because query strings carry portfolio ids.
- **`apps/api/src/internal.ts` exposes no routes** — it is pure re-export and registers nothing.

**Backend & data**
- **decimal.js discipline is complete.** No JS `number` in any monetary, return or weight path; `precision: 34, rounding: ROUND_HALF_EVEN` pinned at module load; money crosses the DB and API boundaries as strings.
- **No float/double/real near money** across all 20 migrations — the only `real` is an embedding vector.
- **XIRR is honest.** `<2` flows → `null`; no sign change → `null` plus a declared gap rather than a fabricated root; 60 bisection iterations narrow to ~9.5×10⁻¹⁸ against a `1e-13` tolerance, so non-convergence cannot occur; `Decimal.pow` keeps it engine-independent.
- **Division-by-zero guards are complete** in `timeWeightedReturn`, `drawdown`, `currencyDecomposition`, `concentration`, `exposures`, `valuePortfolio`, `pearson` and `FxTable.rate`.
- **The job-claim query is genuinely atomic** — a single `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`, with lease-expired jobs at `max_attempts` retired in a pre-pass so a poison payload cannot loop forever.
- **Ingest upserts are constraint-backed** — every write except the ticker-change path targets a real PK with `ON CONFLICT`.
- **SSE lifecycle is handled** — `raw.on('close', stop)`, a single guarded write helper, and content fully guarded before any byte is streamed, so there is no partial-unguarded-output window.
- **Empty catches are narration fallbacks, not swallowed money errors** — each sets `degraded: true` (which, per P1-10, the UI then discards).
- **Erasure uses trigger-gated UPDATE rather than cascading deletes**, preserving the append-only `events`/`audit_log` invariant.
- **Migration atomicity** — each file runs in `BEGIN`/`COMMIT` with its `schema_migrations` insert in the same transaction. A half-applied *file* is impossible.
- **Bounded retries and concurrency** — exponential backoff, dead-letter at `max_attempts`, `drain()` capped at 1,000 ticks, `tick(batchSize = 16)`.
- **Real cost enforcement, not accounting** — `checkCostCeiling` runs *before* the provider call, with per-request hard abort and per-day/per-month degradation. Provider timeout 30s, deliberately inside the 300s lease.

**Architecture**
- **No cycles; apps are leaves.** Full import matrix across 17 workspaces: `contracts` imports nothing; `domain → contracts`; `signal-engine → contracts, domain`. No package or service imports `@atlas/api` in `src/`.
- **No deep-path imports** anywhere — every cross-workspace import goes through a package entry point.
- **Signal Engine purity is enforced by a failing build**, not by convention (`evals/architecture/architecture.test.ts`).
- **Type erosion is near-zero** — 3 `any` in ~26k LOC, zero `as unknown as`. The gap is at the DB boundary specifically (P1-18), not in the discipline generally.
- **tsconfig project references are correct** across all 16 buildable workspaces.
- **The relevance split and the two prompt modules are principled seams, not duplication** — verified by reading both sides.
- **`evals/architecture/architecture.test.ts` is the single best structural asset in the repo**, enforcing guard non-bypassability, `UserFacingContent` construction locality, signal-engine purity, no-float-on-money in migrations, append-only triggers, prompt linting over the live registry, and dependency direction.

**Frontend**
- **Regulatory copy is clean.** An exhaustive grep for advisory phrasing across `apps/web/src` returns only two explicit refusals, transaction vocabulary (`type: 'buy'` as a data value), and the user's own "No-buy list" rule type. No static advisory string exists.
- **Null handling is correct and centralised** — `MISSING = '—'` applied by every formatter; no path renders a missing figure as `0` or blank. Currency is attached to every money figure.
- **No float arithmetic in a money path** — `Number()` appears only at the display boundary and on ratios.
- **Accessibility already right**: `:focus-visible` rings throughout, skip links, 44px targets, `sr-only`, `aria-live`/`role="status"` on skeletons, `role="alert"` on errors, `aria-current`, `aria-pressed`, `aria-expanded`, `fieldset`/`legend`, plus `forced-colors`, `prefers-reduced-motion` and print stylesheets. No `onClick` on a `div`/`span` outside the modal backdrop. 14 of 16 audited contrast pairs pass AA, most at AAA.
- **`useResource` cancels correctly**; `App.tsx` is nine components, not one god component.

**Product**
- **The Contextualization Doctrine holds end to end.** Zero advice-constituting fields, response keys, prompt strings or UI copy. API shapes are doctrine-shaped by construction — `sections` typed `fact|tension|nuance|countercase|unknown`, tensions keyed to the closed §17.3 T1–T7 taxonomy and anchored to a row the user wrote. No `rating`, `signal`, `action`, `recommendation`, `target` or `verdict` field anywhere. §0 conformance is the best-executed part of this repo.
- **The lexical ruleset covers the §0 examples**, including `if I were you` / `in your shoes I'd`, and masks user quotes so the user's own directive language is not punished.
- **Thesis Ledger immutability is real** — a DB trigger, an API 409 pointing at `supersedes_id`, and a `/versions` endpoint keeping every superseded belief visible. Decision journal likewise trigger-protected with a NOT NULL reason.
- **No scope drift.** Despite 30+ merged branches, every module maps to an F- or FR-number; 46 distinct tags appear in code comments. `dev` is *under* documented MVP scope, not over it. Deferrals (Scorecard feature, Behavioral Agent, NL radar compilation) are documented in code with the spec's own reasoning.

**Build**
- `tsc -b tsconfig.build.json` succeeds across all 18 workspaces with no type errors; `apps/web` builds clean (221 kB JS, 14 kB CSS) and `npx tsc --noEmit` on `apps/web` passes. Root `npm ci --dry-run` succeeds against `lockfileVersion: 3`. Node v22.22.3.

---

## Not assessed

- **No PostgreSQL was reachable from the review environment**, so ~28 DB-backed test suites could not be executed and no finding was reproduced against a live database. P0-4 (fold ordering) and P1-6 (lease fencing) rest on SQL plus documented Postgres semantics; both are cheap to confirm against a live instance and should be before P0-4 is treated as final. Mutation testing of `apps/api` and `packages/bus` — including the `ownedPortfolio` predicate — was not possible for the same reason.
- **Guard *detection quality*.** The Guard was verified mandatory and unbypassable; whether its ruleset catches what it claims is a distinct adversarial exercise.
- **Prompt injection via third-party content.** The Copilot system prompt concatenates the context bundle without delimiters (`agents/src/copilot.ts:250-252`), and `notificationContext` embeds brief headline and body. Whether external news or filing text reaches that preamble unmodified was *not* traced — `agents/src/prompts.ts:68-70` suggests it can. If it does, anyone who can place text in a news feed has an unfenced channel into the system prompt. The numeral gate and the Guard sit downstream and would constrain the damage. **This is the highest-value single item remaining unexamined.**
- `npm audit`; `apps/web/src/onboarding.tsx` (507 lines, the highest-stakes first-run flow) beyond a gap-rendering grep; exhaustive label-association verification; any browser-rendered a11y check; `docs/spec/Design.pdf` (image-based — only extractable headings were read, and P1-22 depends on its exact wording); §20 subscription conformance; load behaviour and pool exhaustion; out-of-repo infrastructure that may already exist but is undiscoverable to anyone reading this repository.

---

## Scores

| Dimension | Score | Basis |
|---|---:|---|
| **Overall production readiness** | **4 / 10** | The application would mostly behave correctly if someone started it by hand and watched it. Nothing starts it, supervises it, schedules it, backs it up, or tells anyone when it stops. Nine P0s, five of them operational. |
| **Architecture** | **7.5 / 10** | Enforced dependency direction, no cycles, near-zero type erosion, structural guard and cache isolation, and an architecture test suite that functions as a real immune system. Held back by domain logic marooned in HTTP handlers, the duplicated fold that caused two P0s, and an untyped persistence boundary. |
| **Backend** | **6 / 10** | Exemplary decimal and gap-declaration discipline, honest XIRR, atomic job claiming, constraint-backed upserts. Undercut by silent FX value loss, non-deterministic cost basis, a quadratic import, unbounded market-data queries, no idempotency at the money boundary, and missing lease fencing. |
| **Frontend & UX** | **6 / 10** | Strong accessibility foundation, clean regulatory copy, correct null handling, 14 of 16 contrast pairs at AA or better. Undercut by hiding gaps in the exact branch where they matter, never rendering `degraded`, contract drift that fails open, error-as-empty on two list surfaces, and no double-submit guards. Zero tests across 3,920 lines. |
| **Security** | **7.5 / 10** | The strongest dimension. No IDOR across ~64 routes, no injection, no XSS, structurally unbypassable guard, structurally isolated cache, sound sessions and headers, timing-attack defence, real log redaction. Deductions are config-shaped rather than code-shaped: the fixture default, `trustProxy`, unlimited password guessing on account deletion, incomplete erasure, and unbounded Layer-2 trace retention. |
| **Testing** | **4 / 10** | Where tests exist they are high-signal — golden numbers genuinely pinned, the guard corpus load-bearing, the copilot evals truly adversarial rather than fixture playback. But the gate executes `dist/`, five mutants survive on the trust guards, no route is tested cross-tenant, the frontend has no tests, all five known defects sit in uncovered branches, and the suite cannot run without a local database. |
| **Maintainability** | **6.5 / 10** | Unusual discipline: 3 `any` in 26k LOC, ADRs throughout, 46 requirement tags traceable from code, no scope drift. Weighed down by a 640-line six-responsibility module, 307 untyped queries, a duplicated fold, dead code preserved by misleading comments, undeclared dependencies, a vocabulary collision, and three spec documents that disagree on precedence. |
| **DevOps** | **2 / 10** | The build is green and reproducible, log redaction is real, the queue-depth gauge reads from the database rather than memory, and cost ceilings are enforced pre-spend. Everything else is absent: no CI, no deploy definition, no scheduler, no supervision, no graceful shutdown, no alerting, no backup or restore, no config validation, no version stamp. |

---

## Director's answers

### Would you personally approve deploying Atlas to a private beta today?

**No — but the gap is days of work, not months, and it is almost entirely operational rather than architectural.**

Three things make it a no, and none of them is "the code is bad":

1. **Atlas would issue GDPR erasure certificates it cannot honour.** `DELETE /v1/account` returns the user a signed document naming a date. Nothing runs the worker that would act on it. That is a written promise to a user that the system is structurally incapable of keeping, and it is live the moment the first beta user deletes their account.
2. **Atlas may serve template prose as reasoned analysis, and no signal would reveal it.** If `ATLAS_LLM_PROVIDER` is unset or misspelled, the fixture answers every question with `degraded: false`, a green guard verdict, and a full confidence-and-provenance envelope. Users would make investment decisions on it. For a product whose entire thesis is earned confidence, this is the worst available failure.
3. **Portfolio value can be silently wrong and reported gap-free.** Missing FX deletes value from the series; the Reality Check then tells the user it checked everything and found nothing surprising. Cost basis can differ between two runs on identical data. These are the numbers the product exists to get right.

What makes this a "not yet" rather than a "no": every one of those has a small, well-understood fix, and the surrounding code is good enough that the fixes will hold. Five lines close the provider default. Two `gaps.push` calls close the FX omission. One `ORDER BY` column closes the ordering flap. One word changes `drain` to `watch`. The hard problems — tenant isolation, guard non-bypassability, decimal correctness, cache privacy — are already solved, and solved structurally rather than by convention. That is the expensive part, and it is done.

**I would approve after:** P0-1 (provider default), P0-3 (FX gaps, both halves), P0-5 (worker actually runs), P0-6 (shutdown handlers), P0-8 (contextualization capture), a supervised process with a restart policy, and one rehearsed database restore. P0-2 and P0-7's CI job should land in the same week; P0-4 and P0-9 I would accept as documented known issues for a small, hand-held private beta, provided P0-9 has counsel's written agreement — which, given §56 Q-01 is still marked Blocking, is a conversation that needs to happen regardless.

### What is the single biggest remaining technical risk?

**Atlas cannot tell you when it is degraded or idle.** Every other finding is bounded; this one is a property of the whole system.

The pattern repeats independently in five places built by different specialists' concerns:

- The fixture provider marks itself `degraded: false` because, from its own perspective, the deterministic draft *is* its answer.
- Missing FX drops value and returns `gaps: []`, in a file whose neighbouring branch declares a gap correctly.
- `prices_as_of` reports the *newest* price across the portfolio, so a stale leg is invisible.
- The API computes `degraded` faithfully and the UI never renders it.
- Workers emit no metrics at all, and the product's core promise is that silence means "nothing worth telling you" — so a dead worker looks exactly like a well-behaved product.

Individually each is a P0 or P1 with a small fix. Together they mean Atlas's failure modes are all *quiet*, and quiet failure is uniquely corrosive for a product whose entire value proposition is that you can trust what it tells you and trust its silences. A loud failure costs you an incident; a quiet one costs you the thesis. The mitigation is not one patch but a standing rule: **every degradation path must produce a signal the user or the operator can see** — which means `degraded` rendered, gaps declared at every `continue`, staleness reported as the oldest contributing date, and a worker heartbeat exposed as a metric.

### Five highest-impact fixes before public launch

1. **Make the test gate real.** `"test": "tsc -b tsconfig.build.json && vitest run"`, plus one CI job running `npm ci && npm run build && npm test` on every push. Add the cross-tenant route loop (P1-1), the three declared-gap cases that kill the surviving mutants (P1-2), and the two Guard quoted-span cases (P1-3). *Everything else in this report is only as trustworthy as this step — including the parts marked verified as sound.*
2. **Fail fast on configuration, and never serve a fixture as analysis.** One `config.ts` validated at boot: throw on a missing database URL or LLM provider in production, reject non-finite numerics, remove the `?? 'fixture'` default, and commit a `.env.example` covering all 14 variables. Add `trustProxy` set to the real proxy CIDR while you are there.
3. **Close the silent-degradation set.** Push gaps on both FX `continue` branches; report `prices_as_of` as the oldest contributing date; render `gaps`, `warnings` and provenance in *all three* Reality Check branches; render `degraded` wherever it is already transmitted; add `guard_approved` and `degraded` to the thread-open payload so the withheld state stops failing open.
4. **Make the write path deterministic and idempotent.** Add `seq` to `transactions` and order both folds by `(trade_date, seq)`; call `recomputeDerivedState` once per import rather than once per row; require an `Idempotency-Key` on `/import`; add lease renewal before each handler plus `AND locked_until > now()` on `completeJob`/`failJob`; wrap the ticker-change rewrite in a transaction and add the missing unique index; disable write buttons while their POST is in flight.
5. **Establish an operational floor.** One committed process definition (migrate-then-start ordering, API command, worker in `watch`, restart policy, static route for `apps/web/dist`); SIGTERM/`unhandledRejection` handlers; a scheduler for ingest and the weekly-review fan-out; worker-side metrics plus a heartbeat, actually scraped; and one rehearsed restore into a scratch database. Add `pg_advisory_lock` to the migration runner and a build SHA to `/healthz`.

**Sixth, and time-sensitive in a way none of the others are:** persist contextualizations (P0-8). Every day of beta without it is a day of claims that can never be graded, and §51.4 is explicit that this cannot be retrofitted. It is a single INSERT on a path that already builds the whole document.

---

*Prepared by atlas-director from independent reviews by atlas-architect, atlas-backend, atlas-frontend-ux, atlas-security, atlas-qa, atlas-product-owner and atlas-devops. All P0 findings were re-verified against the implementation by the Director before inclusion. Findings whose evidence did not survive verification were dropped; apparent disagreements between specialists (tenant isolation control vs. test coverage; worker crash recovery vs. lease fencing) are resolved inline at P1-1 and P1-6.*
