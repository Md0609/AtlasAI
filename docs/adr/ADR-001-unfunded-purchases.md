# ADR-001 — Purchases without a recorded deposit (unfunded buys)

Status: accepted · 2026-11-10 · Engine 1.1.0 · Issue #3

## Context

The most common first use is importing a CSV of buys with no deposit. The
cash fold (`recomputeDerivedState`) then leaves a negative cash balance, and
the engine treats it as leverage — a deliberate, golden-tested choice
(`adversarial: negative cash`: position > 100 %, cash negative, weights sum
to 1). The consequences were silent and wrong-looking:

- `/exposure` `total_value_base` was the holdings **net of the debt** (for a
  buy at the day's close, the unrealised gain), with no warning.
- `/performance` chained the TWR over a capital base of ~0: −1984 % on a
  position that rose 3.7 %, and a drawdown of 126 %.

## Decision

1. **Keep the ledger and the leverage reading.** Transactions stay the
   source of truth, the cash fold is unchanged, and the valuation is still
   net of negative cash. The engine does not invent deposits that the user
   never recorded, and the golden tests are unchanged.
2. **Never silently.** A negative cash balance adds a gap:
   - `/exposure` (`component: valuation`): "negative EUR cash balance:
     purchases without a recorded deposit are treated as borrowed…".
   - `/performance` (`component: performance`): "EUR cash went negative…"
     the first time it happens in the window.
3. **TWR is undefined without a positive capital base.** A period that
   starts at a value ≤ 0 (with flows) while the portfolio is not empty, or
   that ends below zero, makes the TWR `null`. It is never chained into a
   number below −100 %. An empty portfolio before the first deposit still
   contributes nothing, as before.
4. **When the TWR is undefined, the drawdown is too.** On a net-of-debt
   residue it means nothing either. Both come back `null` with a gap that
   tells the user what to do: record the deposits that funded the buys.
5. **The drawdown is always in [0, 1].** A value at or below zero is a
   100 % drawdown, never more.
6. **Versioning.** `ENGINE_VERSION` 1.0.0 → 1.1.0: the results (TWR/drawdown
   `null` in the cases above) and the gaps change, so the reproducibility key
   changes (FR-5.6). The methodology identifiers (`performance.v1`, …) name
   the method and stay the same.

What still works for an unfunded portfolio: positions, the local-vs-FX
decomposition (it uses prices, not the value series), and the exposure
weights, which are labelled by the gap.

## Alternative not taken (needs an author decision)

**Implicit contributions:** treat every shortfall as an external deposit on
the day it happens. Value = holdings + positive cash, and the TWR would be
~ +3.7 % in the issue's example. That is what several brokers do, but it
changes what a negative balance means (leverage → contribution). It
contradicts the golden test `adversarial: negative cash` and the honest
`-10500 USD` leg asserted in the integration tests, and it would make a
genuinely leveraged account look unlevered. It can be adopted later as
`performance.v2` if the author decides so; this ADR keeps the current
meaning and makes it explicit.

## Consequences

- An import without deposits shows its positions and decomposition, and
  says plainly why the TWR and drawdown are missing (AT-3 should render that
  gap, not a blank KPI).
- Portfolios whose cash never goes negative get the same numbers and gaps
  as before. Only the `inputHash` changes, because the engine version is
  part of it. Partly funded (leveraged) portfolios keep their figures,
  bounded as above, and gain the negative-cash gap.
