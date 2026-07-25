# Private-beta remediation plan

**Source:** *Atlas AI — Final Engineering Review Before Private Beta*, `dev` @ `c432122`, 2026-07-25.
**Status:** plan only. Nothing here is implemented yet.
**Prepared:** 2026-07-25, after independently re-verifying every P0 against the code and a live database.

---

## 0. Verification pass

The review arrived with file:line locators. I re-checked all nine P0s rather than trusting them, plus the P1s that criticise code written during the previous hardening pass. **Every finding I checked held.** Two are worth recording because I confirmed them more strongly than the review could.

### P0-2 confirmed empirically — the test gate is illusory

The review inferred this from `package.json`. I proved it. Mutating `services/signal-engine/src/concentration.ts` (`knownTotal.gt(0)` → `.gte(0)`) **without rebuilding**:

```
Test Files  6 passed (6)
Tests      49 passed (49)
```

A sabotaged Signal Engine is green.

**Correction, recorded because it changes what the evidence proves.** That mutant was a poor choice: the review lists it under **P1-2 as surviving in `dist` too**, so it survives for lack of coverage, and my demonstration confounded two causes. The isolated evidence is an A/B on one mutation — `valuation.ts`'s `valueLocal = quantity x close` changed to `x 2`, source only, no rebuild:

| | Result |
|---|---|
| Alias disabled (old behaviour) | `Tests 49 passed (49)` |
| Alias enabled (fixed) | `Tests 9 failed \| 40 passed (49)` |

Same mutation, same tree, one variable. That is the finding properly isolated: every other assurance in the review — including its own "verified as sound" section — rested on a gate that did not read the source.

### P0-4 confirmed against a live database — the review could not

The review flagged this as resting on "SQL plus documented Postgres semantics" because no database was reachable. Postgres was available here:

```sql
INSERT INTO t (trade_date, tag) VALUES ('2026-01-05','buy 10@100'),
                                       ('2026-01-05','buy 10@200'),
                                       ('2026-01-05','sell 10');
-- created_at distintos: 1 de 3
```

`now()` is `transaction_timestamp()`, so all rows of one import share a timestamp exactly as predicted. The sort key `(trade_date, created_at)` ties completely; `id` is a random uuid and recovers nothing. The consequence is real at `apps/api/src/portfolios.ts:138` — a `sell` folded while `p.qty` is zero sets `avg = 0` and never relieves cost.

**P0-4 should now be treated as confirmed, not provisional.**

### Findings that criticise the previous hardening pass — both correct

- **P1-6 (lease fencing).** `packages/bus/src/index.ts:157,169,179` all key on `WHERE id = $1` with no lease predicate, and `runner.ts:29` claims a batch of 16 under one 300s lease then runs them serially at `:43`. I wrote that lease. The recovery half works; the fencing half was never there. Accepted in full.
- **P1-16 (`trustProxy`).** Already recorded as the largest known gap in ADR-007. The review adds the sharper framing: it is not merely a weak limiter but a **trivial unauthenticated DoS** — 20 bad logins lock out every user for 15 minutes.

### One correction to the review's framing

**P0-9 and P1-22 are not engineering tasks.** Both are document decisions that happen to touch code:

- P0-9 (jurisdiction disclosure, AI labelling) needs counsel input; §56 Q-01 is still marked **Blocking** in the PRD. Building a disclosure flow before deciding *what must be disclosed per jurisdiction* would be building the wrong thing carefully.
- P1-22 is a precedence conflict, and the review's own recommendation is right: **change the document first.** I verified both halves — `grep -c "A4.1"` on the PRD returns `0` while the code cites `§A4.1` in 33 places, PRD §21.6 line 2570 does specify "Layer 4: LLM judge, different model", and FR-3.1 says "≥5 portfolios" against `MAX_PORTFOLIOS = 3` citing "Design §A5".

Both are flagged **DECISION REQUIRED** below and are excluded from the implementation waves.

---

## 1. Execution order

Ordered by dependency, not by severity. The rationale for each wave is in its heading.

| Wave | Contents | Why here |
|---|---|---|
| **W0** | P0-2 | **DONE** — nothing below was verifiable until the gate read source |
| **W1** | P0-1, P1-13, P1-16 | Config correctness; a wrong deploy must refuse to boot |
| **W2** | P0-3, P0-4, P1-9, P1-10, P1-11 | The silent-degradation set — the review's central theme |
| **W3** | P0-5, P0-6, P0-7 | Operational floor; makes the product runnable at all |
| **W4** | P0-8 | Time-sensitive: every beta day without it is ungradeable forever |
| **W5** | P1-1, P1-2, P1-3, P2-21 | Close the test gaps W0 just made meaningful |
| **W6** | P1-4, P1-5, P1-6, P1-7, P1-8, P2-1 | Correctness and performance on the write/read paths |
| **W7** | P1-12, P2-8, P2-9 | Frontend honesty and accessibility |
| **W8** | P1-19, FR-12.2 | Unmet `[MVP]` MUSTs that do not depend on counsel |
| **—** | P0-9 (FR-12.1 half), P1-22 | **Blocked**: legal input / PRD ownership |

---

## 2. W0 — Make the test gate real

### P0-2 · `npm test` executes `dist/`, not `src/`

**Change:** `package.json:27` → `"test": "tsc -b tsconfig.build.json && vitest run"`.

**Considered and rejected:** aliasing Vitest to `src/` via `resolve.alias`. It would test source directly, but the deployed artefact is `dist/`, so the alias would test something nobody runs and hide build-level faults (a stale project reference, a `tsconfig` path error). Building first tests exactly what ships. This is also the review's recommendation.

**Second half, not optional:** add `vitest.config.ts` coverage for `apps/web` (P2-23) — the glob currently omits it entirely, so a frontend test could not run even if one existed. Adding the glob is one line; the tests themselves are W7.

**Verification:** re-run the mutation above and confirm it now fails. A fix that does not kill that mutant is not the fix.

**Cost:** 1h · **Risk:** low — build time is ~2s.

---

## 3. W1 — Configuration must fail loudly

### P0-1 · The LLM provider silently defaults to a fixture and reports `degraded: false`

`services/intelligence/runtime/src/providers/factory.ts:25` routes any unrecognised value — including a typo — to `FixtureProvider`, which sets `degraded: false` deliberately (`fixture.ts:72`). Template prose is then served with a green guard verdict and a full confidence envelope.

**Change:** make the ternary exhaustive over `ProviderName`; throw on an unset or unrecognised value when `NODE_ENV === 'production'`. Keep the fixture default in dev and test, where it is correct and load-bearing for the whole suite.

**Note on `degraded: false`:** leave it. The fixture's comment is right — from its own perspective the deterministic draft *is* its answer. The defect is the silent *selection*, not the honest self-report. Changing it would make every test assert a degradation that is not one.

**Cost:** 1h · **Risk:** low.

### P1-13 · No boot-time configuration validation

Every production-critical setting has a silently-working default: the database falls back to `postgres://atlas:atlas@127.0.0.1:5432/atlas` (`packages/schema/src/index.ts:16`), `ATLAS_COOKIE_SECURE` defers to `NODE_ENV` so a deploy that forgets it ships non-`Secure` cookies and no HSTS, and `Number(process.env.X ?? d)` appears in five places with no `isFinite` guard — `ATLAS_ERASURE_GRACE_DAYS=abc` writes an Invalid Date into a GDPR deadline.

**Change:** one `apps/api/src/config.ts`, read and validated once, called on line 1 of `index.ts`. Throws in production on a missing `ATLAS_DATABASE_URL` or LLM provider; rejects non-finite numerics everywhere. Commit `.env.example` enumerating all 14 variables.

**Cost:** 3h · **Risk:** low, but it will surface latent misconfiguration in whatever environment runs it next — which is the point.

### P1-16 · Rate limiter keys on the socket address with `trustProxy` unset

Already documented as the largest known gap. Behind any proxy the per-IP limit becomes one global bucket: **20 bad logins lock out every user for 15 minutes**, no account required.

**Change:** `trustProxy` set to the specific proxy CIDR. **Not `true`** — that lets any client forge `X-Forwarded-For` and evade the limit entirely, which is worse than the current state.

**Dependency:** the CIDR is a deployment fact, so this lands with W3's process definition.

**Cost:** 1h + the deployment decision · **Risk:** medium — a wrong CIDR silently disables the limiter. Needs a test asserting a forged `X-Forwarded-For` from an untrusted source is ignored.

---

## 4. W2 — The silent-degradation set

The review's strongest observation: Atlas's failure modes are all quiet, and quiet failure is uniquely corrosive for a product whose value is trustworthy silence. These are one theme, not five bugs.

### P0-3 · Missing FX silently deletes value, and the UI hides the gap in the branch where it matters

Two independent halves that compose into the core trust failure.

**Backend** (`apps/api/src/signals.ts:266,272`): two bare `if (rate === null) continue;` with no `gaps.push` — directly after a missing-*price* branch at `:259` that **does** push one. The same condition is handled correctly in the engine (`valuation.ts:39-47`). So it is an omission, not a convention.

**Frontend** (`apps/web/src/reality-ui.tsx`): only the surprises branch renders `warnings` + `gaps` + provenance. The no-surprise branch renders `warnings` only; the empty branch renders neither — while asserting "Atlas checked your look-through exposure, your concentration, your currency mix… and found nothing that should surprise you."

**Change:** push a deduped gap in both `continue` branches (`gapNoted` already exists). Lift `warnings` + `gaps` + the provenance footer out of all three branches into one block rendered **before** the early returns, so no future branch can omit them.

**Cost:** 3h · **Risk:** low. **Test:** a portfolio with a missing FX rate returns non-empty `gaps`, and each of the three Reality Check branches renders them.

### P0-4 · Cost basis is non-deterministic

Confirmed against a live database (§0).

**Change:** `ALTER TABLE transactions ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY`; order by `(trade_date, seq)` in both folds (`portfolios.ts:111`, `signals.ts:153`).

**Rejected as the final fix:** `ORDER BY trade_date, created_at, id`. It stops the flapping but freezes an arbitrary order — it makes a wrong answer *stable*, which is harder to notice than a wrong answer that moves.

**Open question for implementation:** ordering by insertion sequence is right for imports (broker files are chronological), but a user who adds a back-dated transaction later gets it folded last within its day. Correct for cost basis under FIFO-ish averaging; worth a comment stating the choice rather than leaving it implicit.

**Cost:** 4h incl. migration · **Risk:** medium — touches the money fold. Needs the P2-21 golden cases (same-day buy+sell netting to zero) landed alongside.

### P1-9 · `staleness.prices_as_of` reports the newest price as a portfolio-wide claim

`valuation.ts:48` takes the max. A portfolio with one six-month-stale position reads "prices as of 25 Jul 2026", and that position is still folded into total value, weights and concentration.

**Change:** report the **oldest** contributing price date, and push a gap for any position trailing `max(asOf)` by more than a threshold. The cheaper alternative — relabel the UI to "newest price" — makes the current value honest but leaves the stale position invisible, so prefer the first.

**Cost:** 2h · **Risk:** low.

### P1-10 · `degraded` is declared, transmitted, and rendered nowhere

The UI half of this theme, and what would have made P0-1 visible. `apps/web/src/api.ts:61` declares it, `:115,131` carry it, zero render sites.

**Change:** add `provenance.narration.degraded` to `RealityCheckResponse` (currently not even representable) and render one muted line beside the existing "(withheld…)" treatment at `copilot-ui.tsx:222` and in the Reality Check provenance footer.

**Cost:** 2h · **Risk:** low.

### P1-11 · Contract drift fails open — a guard-withheld Copilot opener renders as a normal answer

`POST /v1/copilot/threads` omits `guard_approved`; the hand-written web type marks it optional; `m.guard_approved === false` is false for `undefined`. A refused opening turn renders as if Atlas answered.

**Change:** add both fields to the 201 payload; widen `PerformanceResponse` (which also omits `provenance`, `fx_as_of`, `holdings_as_of` that the API already sends). **Structural follow-up, not in this wave:** have `apps/web` depend on `packages/contracts` — this class of bug is a compile error the moment it does.

**Cost:** 2h now, 1d for the structural fix · **Risk:** low.

---

## 5. W3 — Operational floor

### P0-5 · Nothing runs the workers

`package.json:32` is `drain` — process until quiet, then exit. No scheduler anywhere. **`DELETE /v1/account` has already been shipping users a signed certificate naming an erasure date, and nothing will ever run that job.** `watch` mode exists and is implemented (`cli.ts:24`); nothing invokes it.

**Change:** deployed worker invocation → `watch`; one scheduled invocation each for ingest and the weekly-review fan-out.

**Cost:** 1h once W3's process definition exists · **Risk:** low.

### P0-6 · No graceful shutdown, no crash handlers

Zero handlers repo-wide; the only two greps hit are comments I wrote. Node exits on unhandled rejection by default and nothing restarts it.

**Change:** `SIGTERM`/`SIGINT` → `app.close()` then `pool.end()`; an `unhandledRejection` handler that logs with the trace id before exiting; in the worker `watch` loop, set a flag on SIGTERM and break after the current tick.

**Cost:** 3h · **Risk:** low. **Interacts with P1-6:** a worker that shuts down cleanly mid-batch should release its remaining leases rather than let them expire.

### P0-7 · No deployment definition, no CI, no backup/restore

Three absences that compound. A repo-wide find for `*.yml`, `*.yaml`, `*.tf`, `Procfile`, `*.service`, `deploy*`, `.env*`, `*.sh` returns **nothing**. `@fastify/static` is not registered, so `apps/web/dist` is served by nothing. 84 commits on `dev` have never reached `master`, ungated.

**Change:** (a) one committed process definition — migrate-then-start ordering, API command, worker in `watch`, restart policy, static route for `apps/web/dist`; (b) one CI job running `npm ci && npm run build && npm test`, which also enforces W0; (c) one script that dumps **and restores into a scratch database**, executed once before beta.

**On (c):** backup is not the test, restore is. A dump that has never been restored is a file, not a recovery plan. Atlas's core asset — hand-entered transactions and an immutable thesis ledger — cannot be re-derived from anywhere.

**Cost:** 1–2d · **Risk:** medium; needs your input on the target platform.
**DECISION NEEDED:** where does this deploy? The process definition's shape (Dockerfile / compose / systemd / PaaS) follows from that, and so does P1-16's proxy CIDR.

---

## 6. W4 — Contextualization capture

### P0-8 · Contextualizations are generated and discarded

`apps/api/src/contextualize.ts` builds a full `ContextualizationDoc` including `confidence.whatWouldChangeIt` — the falsifier set a grader needs — serialises it and returns. A grep of the file for `INSERT INTO|recordEvent` returns **zero**. §51.4 names this as the one mistake that cannot be undone, and it breaks FR-10.1 (`[MVP]` MUST) and FR-12.4.

**Why it gets its own wave:** it is the only finding here that gets *worse with time* rather than staying constant. Every beta day without it is a day of permanently ungradeable claims.

**Change:** persist the doc append-only on every successful contextualize — doc JSON, signals, confidence, generator, trace_id. **Do not build the grader**; §51.4 defers that to v1.1. Capture only.

**Cost:** 4h incl. migration · **Risk:** low — additive, on a path that already builds the whole document.

---

## 7. W5 — Close the test gaps

Deliberately after W0: written before it, these tests would pass against stale `dist/` and prove nothing.

| # | Change | Cost |
|---|---|---|
| **P1-1** | One parameterised `cross-tenant.integration.test.ts`: register A and B, create a portfolio as A, loop every `:id` route asserting B gets 404 and no cookie gets 401. Security verified no IDOR exists across ~64 routes; **nothing asserts it**, so dropping `AND user_id = $2` on a new route ships green | 4h |
| **P1-2** | Three golden cases killing the five surviving mutants: TWR over a series with a zero-value day returns finite; `xirr([{-100,d0},{+1,d365}])` returns `null`; concentration with all-zero named weights returns no effective-N | 3h |
| **P1-3** | Two Guard cases: a directive inside `quoted: true` is approved; the same directive in an adjacent `quoted: false` segment is rejected. The carve-out is the Guard's only bypass surface and has zero tests | 1h |
| **P2-21** | Degenerate golden cases: empty portfolio, same-day buy+sell netting to zero. These also reach P1-2's unprotected guards and are the P0-4 regression test | 2h |

---

## 8. W6 — Write- and read-path correctness

| # | Finding | Change | Cost |
|---|---|---|---|
| **P1-4** | CSV import is quadratic — `recomputeDerivedState` runs once per row inside one transaction (up to 10,000 folds for a 5,000-row file) | Split `insertTransaction` into an insert-only form; call the fold once after the loop, beside the existing single `evaluateAndPersistUserRules` whose comment already states that intent | 3h |
| **P1-5** | Performance endpoint selects the entire `fx_rates` table with no filter and all `price_bars` with no date bound, then linear-scans per (day, security) | Bound both queries by `[firstTx, lastBar]` plus one bar before the window; replace `lastAtOrBefore` with a monotonic per-series cursor — the day loop is already ascending, so results are identical at O(D+B) | 4h |
| **P1-6** | Lease covers a batch of 16 but jobs run serially; `completeJob`/`failJob` have no fencing predicate | Renew the lease immediately before each handler (`UPDATE … WHERE id = $1 AND status = 'processing' RETURNING id`; skip if no row — that is also the fencing check); add `AND locked_until > now()` to both terminal transitions | 4h |
| **P1-7** | No idempotency at the money boundary: a retried import doubles the portfolio | `Idempotency-Key` on `/import` recorded in a table with a `UNIQUE` constraint, or `import_batch_id` + `UNIQUE (portfolio_id, import_batch_id, source_line)` | 4h |
| **P1-8** | Ticker-change listing rewrite is two autocommitted statements; a crash between them leaves a security with **no live listing**, unrecoverable by re-running ingest | Wrap in `BEGIN`/`COMMIT` like the neighbouring stages already do; add `CREATE UNIQUE INDEX listings_window_uni` so the race guard becomes `ON CONFLICT DO NOTHING` | 3h |
| **P2-1** | Unlimited password guessing against `DELETE /v1/account` — the re-auth added last pass has no rate limit | `{ config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }`, the one-line pattern already at `auth.ts:128`. **My omission from the previous pass** | 30m |

---

## 9. W7 — Frontend honesty and accessibility

| # | Finding | Change | Cost |
|---|---|---|---|
| **P1-12** | Two list surfaces render "the request failed" as "you own nothing" — on a 5xx a user with 40 positions is told "Nothing here yet", whose plausible next action is re-importing, which (given P1-7) doubles the portfolio. Six write forms have no double-submit guard | Convert `Positions`, `Home.refresh`, `CopilotHistory` to `useResource` + `ErrorState`; copy the `saving` pattern from `add-holding.tsx:36` into each write form, starting with the two that write transactions | 4h |
| **P2-8** | ⌘K declares `aria-modal` with no focus trap and no focus restore | Capture `document.activeElement` on mount, refocus in cleanup, add a Tab wrap handler | 2h |
| **P2-9** | Form field borders fail WCAG 1.4.11 — 1.31:1 light, 1.28:1 dark against a 3:1 requirement. The border is the only indicator a control exists | Add a `--field-line` token at ≥3:1 used only by the input rule; leave `--line` decorative | 1h |

---


## 9b. W8 — Unmet `[MVP]` MUSTs that need no legal input

Both are mandatory requirements that are currently unimplemented while reading
as met. Neither depends on Q-01.

### P1-19 · Quiet hours (FR-8.6) do not exist anywhere

`[MVP]` MUST. §18.4 carries a dedicated quiet-hours-exempt column for all eight
notification classes and §18.8 lists "anything during quiet hours except C0" as
an explicitly banned anti-pattern. A repo-wide grep for
`quiet_hours|quietHours|timezone` returns **one hit, in a test comment**.
`user_notification_prefs` holds only `weekly_budget_delta` — there is no
timezone field with which to prevent a 03:00 notification.

Atlas's entire claim is restraint. This is the most user-visible promise in §18
and it is absent.

**Change:** add user timezone and a quiet window to `user_notification_prefs`;
a dispatcher check in the notification path with a single C0 exemption, matching
the §18.4 table.

**Open question for implementation:** what happens to a non-C0 brief raised
during quiet hours — deferred to the window's end, or dropped and folded into
the Weekly Review? §18.4 says exempt/not-exempt but not the disposition. The
suppression machinery already exists and already records a reason, so deferral
is the smaller change and keeps the "nothing is deleted" promise the Today
surface makes. Will flag rather than decide silently.

**Cost:** 6h incl. migration · **Risk:** medium — touches the dispatch path.

### FR-12.2 · No "AI-generated" marker on model-generated prose

`[MVP]` MUST. Atlas ships model-generated prose across Reality Check narration,
briefs, Copilot and contextualization with nothing identifying it as
AI-generated. The Guard protects the *content*; nothing establishes the
*posture*.

**Why this half is not blocked:** the requirement is that model-generated output
be labelled. What the label *says* is a copy decision. It carries no
jurisdiction-specific legal claim, so it does not wait on Q-01 — unlike FR-12.1,
whose text is a legal artefact.

**Change:** a persistent marker on every surface rendering `UserFacingContent`.
Pairs naturally with P1-10 (rendering `degraded`), which touches the same
footers.

**Cost:** 3h · **Risk:** low.

## 10. Decisions taken (2026-07-25)

Recorded here so the waves below are read against them.

**Deployment — W3 stays blocked, deliberately.** Atlas is not being deployed
yet, so no platform-specific work lands. **The single decision W3 needs is: what
runs the processes?** Everything else follows mechanically from it — the process
definition's format (Dockerfile / compose / systemd unit / PaaS manifest), the
migrate-then-start ordering, the restart policy, the static route for
`apps/web/dist`, and **P1-16's `trustProxy` CIDR**, which cannot be set to a
correct value without knowing the proxy in front. Setting it to `true` instead
would let any client forge `X-Forwarded-For` and evade the rate limit entirely,
which is worse than today. So P1-16 waits with W3 rather than shipping a guess.

Nothing else in the plan depends on this. W0-W2 and W4-W8 are all
platform-neutral.

**P0-9 splits.** FR-12.2 (the "AI-generated" marker) is a product requirement
with no legal content: the PRD requires that model-generated prose be labelled
as such, and what the label says is a copy decision, not counsel's. It moves
into **W8**. FR-12.1 (the jurisdiction disclosure gate) stays blocked — its text
is a legal artefact and §56 Q-01 is still marked **Blocking**. No placeholder
text will be invented, and it will not be marked resolved.

**P1-19 (quiet hours) is treated as an `[MVP]` MUST**, not a product option. It
moves out of "not in scope" into **W8** and is a beta blocker.

## 11. Still blocked

### P0-9 · FR-12.1 / FR-12.2 — jurisdiction disclosure and AI labelling

Both are `[MVP]` MUSTs. Atlas ships model-generated prose across Reality Check, briefs, Copilot and contextualization with **no label** identifying it as AI-generated and **no jurisdiction disclosure** at first analytical use. The Guard protects the *content*; nothing establishes the *posture*.

**Why I am not planning an implementation:** §56 Q-01 — "Is the Contextualization Doctrine legally durable in DE/FR/NL/ES?" — is still marked **Blocking** in the PRD. The disclosure text is a legal artefact, and building a versioned acknowledgement flow before counsel says what must be acknowledged means building the wrong thing carefully.

**Resolved:** FR-12.2's marker is in **W8**. FR-12.1's gate remains blocked on Q-01 — no text invented, not marked resolved.

### P1-22 · Three spec documents disagree, and the PRD is nominally authoritative

Verified: `grep -c "A4.1"` on the PRD → `0`, while 33 code sites cite `§A*` sections. PRD §21.6 line 2570 specifies "Layer 4: LLM judge, different model"; the code ships three layers. FR-3.1 says "≥5 portfolios"; `MAX_PORTFOLIOS = 3` citing "Design §A5". `docs/spec/README.md` names the PRD as single source of truth.

**Recommendation, which is also the review's:** change the **document**, not the code. Amend §21.6 and FR-3.1 to state what governs pre-beta, and record which document wins when they conflict. Then decide separately whether §9.3's zero-escape target makes the L4 judge a scheduled item rather than a dropped one.

**Needed from you:** the PRD is yours. I can draft the amendments, but I should not silently edit the authority document.

---

## 11. Explicitly not in scope

Tracked, not planned. Each is defensible to carry into a hand-held private beta.

- **P2-2** erasure misses events partitioned by portfolio · **P2-3** `agent_messages` retains verbatim Layer-2 output forever · **P2-4** no session revocation short of 7 days · **P2-5** a `buy` with only `amount` silently creates no position · **P2-6** currency decomposition falls back to a future price · **P2-7** weekly budget unclamped · **P2-10** CSV import has no parsed-row preview · **P2-11** pool hardcoded at 10 · **P2-12** no version stamp · **P2-13** Node unpinned · **P2-14** undeclared cross-workspace devDeps (**breaks the moment P0-7 uses per-service images** — revisit then) · **P2-15** contracts is types-only · **P2-16** dead `internal.ts` · **P2-17** bus tables read outside the bus · **P2-18** agents does its own SQL · **P2-19** §9 NFRs unmeasurable · **P2-20** "Persona" names two concepts · **P2-22** suite hangs without Postgres · **P2-24** `resetDatabase` ships in production `dist/`
- **P1-14** worker metrics · **P1-15** migration advisory lock · **P1-17** portfolio logic marooned in HTTP handlers · **P1-18** 307 untyped queries · **P1-20** Red Team not run on thesis creation · **P1-21** Copilot omits the §31.4 envelope

**P1-19 is no longer here** — it is an `[MVP]` MUST and moved to W8.

One more deserves a second look despite being out of scope: **P2-22** (a suite that hangs rather than fails burns a CI timeout, and a failed `beforeAll` reports its tests as *skipped*, which reads as green to a reporter counting tests rather than exit codes).

---


---

# W0 — COMPLETED 2026-07-25

## The problem

`npm test` could pass against source that was never executed. The Signal Engine
— the module this repo calls its release gate — was gradeable only in whatever
state it had last been compiled in.

## Root cause

Two mechanisms, and only the first was in the review.

**1. Every workspace entry point is compiled output.** All 16 buildable
workspaces declare `"main": "dist/index.js"` (and `@atlas/api`,
`"dist/server.js"`). `node_modules/@atlas/*` are symlinks to the workspace
directories, so Vite's resolver reads those manifests and loads `dist/`. A test
importing `@atlas/signal-engine` graded the previous build.

**2. Resolution was MIXED, and this was not previously identified.** Tests
inside a workspace mostly import `../src/`, while the Signal Engine's three most
important suites (`golden`, `properties`, `adversarial`) and every `apps/api`
integration test import `@atlas/*`. Several files did both at once —
`radar.test.ts` imports `../src/radar.js` *and* `@atlas/contracts`.

The consequence is worse than staleness. Measured directly:

```
identical namespace object? false
identical function ref?     false
```

Importing `@atlas/guard` and `guard/src/index.ts` in one test yielded two
distinct module instances. Five modules hold module-level state —
`factory.ts`'s provider override and cache, `observability.ts`'s counters,
`auth.ts`'s decoy hash, `embedder.ts`'s cache — and each would have had two
independent copies. A test calling `setProviderForTests()` through one
specifier while the code under test reads the other would configure nothing,
and pass.

## The fix

**1. `vitest.config.ts` aliases every `@atlas/*` specifier to TypeScript
source.** The map is *derived* from each workspace's own entry point rather
than hardcoded, so a new package is covered when it is created, and a package
whose entry is not `index` (`@atlas/api` → `src/server.ts`) needs no special
case. Subpath exports are emitted before their bare package and every pattern is
anchored, so `@atlas/api` cannot swallow `@atlas/api/internal`.

This removes both defects at once: no compiled artefact remains that could be
stale, and one specifier means one instance.

**2. `"test": "tsc -b tsconfig.build.json && vitest run"`.** Still required
after the alias, for a reason the alias cannot cover: **Vitest transforms with
esbuild, which erases types without checking them.** Without the build step the
suite would pass on code `tsc` rejects. The build also keeps `dist/` current,
which is what production actually runs. `test:only` was added for the inner
development loop where the build is redundant.

**3. `apps/web` added to the test glob.** It had none, so a frontend test could
not have run even if written. Tests are a later wave; this stops that wave
having to fix the config too.

## Evidence

An A/B on a single mutation — `valuation.ts`'s `valueLocal = quantity x close`
changed to `x 2`, in **source only**, with no rebuild:

| Configuration | Result |
|---|---|
| Alias disabled (old behaviour) | `Test Files 6 passed \| Tests 49 passed (49)` |
| Alias enabled (fixed) | `Test Files 2 failed \| Tests 9 failed, 40 passed (49)` |

Restoring the source returns the suite to green. One variable, opposite results.

**Integration path verified separately**, because `apps/api` tests import
`@atlas/api` rather than relative source. Mutating `apps/api/src/server.ts`
(`frame-ancestors 'none'` → `'self'`), no rebuild:

```
x security headers > cannot be framed - the clickjacking fix that matters most
  -> expected 'default-src...' to contain "frame-ancestors 'none'"
```

Restored, and the file returns to 5/5.

## Tests added

`evals/architecture/resolution.test.ts`, 6 cases. They do not re-run a mutation
— a test cannot usefully sabotage the tree it runs in — they pin the properties
that make mutation detectable:

- the same function reference through the package name and through `src/`
  (measured `false` before the fix), for both `@atlas/guard` and
  `@atlas/signal-engine`;
- module-level state shared across specifiers;
- every `@atlas` specifier maps to a `.ts` under `src/` and never into `dist/`;
- every workspace building to `dist` has an alias, checked against the manifests
  rather than a hardcoded list;
- `@atlas/api/internal` resolves to `src/internal.ts` and is ordered before the
  bare package;
- `npm test` runs `tsc -b` before `vitest`.

Removing the alias fails these immediately.

## Verification commands

```bash
npm run build                     # tsc -b across 18 workspaces + apps/web
npm test                          # build, then the full suite
npx vitest run evals/architecture/resolution.test.ts

# Reproduce the A/B (restore the file afterwards):
#   edit services/signal-engine/src/valuation.ts, append .times(2) to valueLocal
npx vitest run services/signal-engine   # expect failures WITHOUT rebuilding
```

## Result

```
Build:  clean (tsc -b + vite, 18 workspaces)
Suite:  391 passed / 43 files   (was 385 / 42)
```

## Discovered during W0, not previously recorded

- **Mixed resolution and dual module instances** (above). The review reported
  the gate as reading `dist`; it read both, inconsistently, sometimes within one
  file.
- **My own P0-2 evidence was confounded.** The `concentration.ts` mutant I first
  used survives in `dist` too, for lack of coverage (the review's P1-2). It
  demonstrated nothing about staleness. Corrected in §0 with the isolated A/B.
- **`@atlas/api/internal` has no importers**, confirming P2-16: all five
  repo-wide references are comments. It is still a published subpath advertising
  API internals, and it is now also an alias rule that exists only to keep a
  dead export resolvable.

## Pending decisions from W0

None. The wave introduced no architectural choice needing approval: aliasing
test resolution to source changes what the suite reads, not what the product
does, and `dist/` remains exactly what production runs.

## 12. Effort

| Wave | Effort | Blocks beta? |
|---|---|---|
| W0 test gate | 1h | **Yes** |
| W1 configuration | 5h | **Yes** |
| W2 silent degradation | 13h | **Yes** |
| W3 operational floor | 2–3d | **Yes** |
| W4 contextualization capture | 4h | **Yes** — and worsens daily |
| W5 test coverage | 10h | Recommended |
| W6 write/read correctness | 18h | P1-7, P2-1 recommended; rest can follow |
| W7 frontend | 7h | P1-12 recommended |

**W0–W4: roughly 4–5 working days.** That is the review's own conclusion — the gap is operational, not architectural, and the expensive problems (tenant isolation, guard non-bypassability, decimal discipline, cache privacy) are already solved structurally.

**The prerequisite is not code:** W3 cannot start without knowing where this deploys, and that answer also unblocks P1-16.

---

## 13. Standing rule this plan adopts

The review's central diagnosis, worth carrying forward as a review criterion rather than a one-off fix list:

> **Every degradation path must produce a signal the user or the operator can see.**

Concretely: `degraded` rendered wherever it is computed, a gap declared at every `continue`, staleness reported as the *oldest* contributing date, and a worker heartbeat exposed as a metric. A loud failure costs an incident; a quiet one costs the thesis.
