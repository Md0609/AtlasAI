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
