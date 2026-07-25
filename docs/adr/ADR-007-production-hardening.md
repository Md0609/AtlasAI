# ADR-007 — Production hardening (P0/P1 from the pre-launch audit)

**Status:** accepted
**Date:** 2026-07-25
**Context:** pre-production audit. Scope is limited to findings that block a
first private deployment. No new features; no refactoring of working code.

---

## 1. The Compliance Guard fails closed on text it cannot read

### The finding, corrected

The audit reported "the Guard is English-only and you sell in Spain" and
recommended porting the rule set to ES/DE/FR/PT. **That recommendation was
wrong and was not implemented.** The PRD is explicit in three places:

- §1106 — "Internationalization: English at MVP; ES/DE/FR/PT at v1.1."
- §4714 — out of scope: "i18n (v1.1) — English only."
- §4766 — "Launch: Public beta, EU only, English."

i18n is F-40, a v1.1 feature. Translating the rule set would have been building
it. The enabled EU jurisdictions are about *what Atlas may lawfully show*
(FR-1.3/1.4) and about currency — "architecture, not translation".

The real defect is narrower and worse. The English rule set is a *precondition*
that nothing checked. Given a Spanish question, a real provider answers in
Spanish; every English pattern misses; the classifier scores 0; and the Guard
returns `approved: true`. It reports a pass it never performed. §875 — "0
escapes… any escape is a P0 incident" — does not exempt other languages.

Verified in a test: `lexicalScreen()` returns `[]` and the classifier scores
`0` for "Deberías vender Microsoft ahora mismo". Approved, before this change.

### Decision

Add **layer 0, an evaluability screen**, ahead of the existing three. It does
not detect directives in other languages — that is i18n. It establishes that
the text is in the language the other layers can read, and **refuses to approve
it otherwise**.

Rejection routes to the deterministic template via the caller's existing
degradation path (refusal, numeral drift, guard rejection all already land
there), so no new failure mode is introduced — only an existing one correctly
triggered.

### Consequences

- The Guard can now reject output it previously waved through. It cannot
  approve anything it previously rejected: the change is monotonic in the safe
  direction.
- **Product impact, accepted deliberately:** if a real provider answers in a
  non-English language, the user gets the deterministic template instead of
  narrated prose. Correct for an English MVP; revisit with F-40, when the rule
  set gains those languages and layer 0 gains them as approved inputs.
- False positives degrade real output, so the screen is built to avoid them:
  function words only (never nouns — European security names are the main
  source of foreign text in legitimate English output), three-character
  minimum ("Telefónica **de** España **y** **La** Caixa" must not trip it), and
  no word that is also English. User quotes stay masked, as in every layer.
- Two signals, either sufficient: ≥2 distinct foreign function words, or ≥12
  words with <10% English function words.

### Alternatives rejected

- **Port the rule set to ES/DE/FR/PT** — this is F-40. Out of scope, and it
  would need counsel review per jurisdiction before it could be trusted.
- **Force English in the system prompt only** — a prompt is a request, not a
  control. It also cannot be verified after the fact, which is the whole point.
- **A language-detection dependency** (`franc`, `cld3`) — the Guard is
  specified as a stateless library with no network and no I/O (§A3.2/§A3.3).
  A versioned deterministic heuristic matches both that constraint and the
  existing classifier's design.

---

## 2. Job leases (P0-3)

**Decision:** `job_queue.locked_until`. A claim takes a 300s lease; an expired
lease makes the job claimable again and stops it blocking its partition.

**Why it needed a decision at all:** it changes delivery characteristics. A
crashed worker's job now runs a second time. That is already the contract
(D-010, at-least-once, idempotent consumers, dedup at the effect boundary), so
the change makes the implementation match the stated semantics rather than
introducing new ones — the previous behaviour was *stronger* than promised in
the happy path and catastrophic in the unhappy one.

**Consequence:** a reclaim counts as an attempt, so a payload that kills its
worker reaches the DLQ rather than cycling forever.

## 3. Re-authentication before erasure (P1-2)

**Decision:** `DELETE /v1/account` requires the password.

**Tension considered:** §6.6 forbids friction at cancellation. Read carefully,
it forbids *dark patterns and retention offers* — persuasion. Verifying
identity protects the user, not the business: nothing asks why, nothing is
offered to change their mind, and the export stays exactly as reachable as
before (pinned by a test). Rejected the alternative of leaving a session
sufficient: a stolen cookie destroying an irreplaceable reasoning history is
not a risk this product can carry.

## 4. Provider timeout degrades rather than throws (P1-5)

**Decision:** 30s default, both an `AbortSignal` and a `Promise.race`.

Both are needed: the signal lets a cooperative provider cancel and stop the
meter; the race protects against the provider that ignores it, which is
precisely the one that hangs. On timeout the turn degrades to the deterministic
template — the same path as refusal, numeral drift and the cost ceiling — so no
new failure mode enters the system.

Timeout (30s) is deliberately well inside the job lease (300s): a slow turn
should degrade, never lose its job.

## What was NOT done, and why

- **Rule-set i18n (F-40).** v1.1 per the PRD. Layer 0 makes English-only safe;
  it does not make Atlas multilingual.
- **Redis-backed rate limiting.** Out of scope by instruction. The in-memory
  store still means the limit is per process and `trustProxy` is still unset,
  so behind a load balancer the login limiter is either useless or a global
  lockout. **This is the largest remaining gap before a public deployment.**
- **Register account enumeration.** `409 email-taken` still discloses that an
  address is registered. Closing it means replying 202 and sending an email —
  a new feature.
- **Real token streaming.** The Copilot still generates fully before writing.
  Deliberate (nothing unscreened reaches a user), but with a live provider the
  user waits on a spinner for the whole generation. A product decision.
