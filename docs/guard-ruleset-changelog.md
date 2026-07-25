# Compliance Guard rule set changelog

The Guard rule set is versioned like code (FR-12.3): every change to the
lexical rules or classifier cues lands here with a reason, and counsel signs
off on the rule set before GA (§0). The rules themselves live in
`services/intelligence/guard/src/lexical.ts` and `classifier.ts` — this file
is the human-readable history.

## lang.v1 — 2026-07-25 (production hardening)

Adds **layer 0, the evaluability screen** (`language.ts`). No lexical rule or
classifier cue changed.

Every rule in layers 2 and 3 is an English regex, which is correct per the PRD
(i18n is F-40, v1.1; launch is "EU only, English"). What was missing is that
nothing verified that precondition. Non-English output passed every English
pattern, scored 0 on the classifier, and was returned as `approved: true` — a
pass the Guard had not actually performed. §875 makes no exception for the
language a directive is written in.

Layer 0 does not screen for directives in other languages; that would be
implementing i18n. It establishes that the text is in the language the other
layers can read, and refuses to approve it otherwise. The caller degrades to
the deterministic template, which is the existing path for refusal, numeral
drift and guard rejection.

| Code | Fires when |
|---|---|
| `lang.not_evaluable` | ≥2 distinct non-English function words, or ≥12 words with <10% English function words |

False-positive controls: function words only (never nouns — European security
names are the main source of foreign text in legitimate output), minimum three
characters (so "Telefónica **de** España **y** **La** Caixa" does not trip it),
and nothing that is also an English word ("per", "con", "die", "man", "war",
"hat", "den", "son", "plus" are all deliberately excluded). User quotes are
masked, as with every other layer: the user's Spanish thesis is their prose.

**Counsel note:** this widens what the Guard rejects. It cannot widen what it
approves.

## lex.v1 · heuristic.v0 — 2026-07-18 (Phase 4a, initial)

Lexical rules (deterministic, run on rendered text with user quotes masked):

| Code | Catches |
|---|---|
| `lex.directive_second_person` | "you should buy/sell/trim…" |
| `lex.first_person_recommendation` | "we recommend / I suggest…" |
| `lex.imperative_trade_verb` | sentence-initial "Buy X." "Sell before…" |
| `lex.rating` | buy/sell/hold ratings, over/underweight (§12.3 rejected feature) |
| `lex.price_target` | "price target", "our target of…" (§22.2) |
| `lex.prediction` | "will outperform/double/reach…" |
| `lex.return_promise` | "guaranteed returns", "can't lose", "risk-free profit" |
| `lex.entry_exit_call` | "compelling entry point", "now is the time to buy" |
| `lex.urgency` | "don't miss out", "before it's too late" |
| `lex.conditional_self_recommendation` | "if I were you…", "personally I'd buy" |

Classifier cues (heuristic.v0, threshold 0.15 per §21.6): paraphrase signals
— "no-brainer", "load up", "hard to see how you lose", "deserves a spot in
your portfolio", herding cues ("smart money is…"), "the move here is".

Structural layer (not versioned separately — it is the schema): literal
numerals in prose, unresolved signal references, currency-less currency
renders, missing falsifiers (§17.4), unanchored T1/T2 tensions (§28.2).
