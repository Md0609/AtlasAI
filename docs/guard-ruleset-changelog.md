# Compliance Guard rule set changelog

The Guard rule set is versioned like code (FR-12.3): every change to the
lexical rules or classifier cues lands here with a reason, and counsel signs
off on the rule set before GA (§0). The rules themselves live in
`services/intelligence/guard/src/lexical.ts` and `classifier.ts` — this file
is the human-readable history.

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
