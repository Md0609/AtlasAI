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
2. **Never silently.** "Unfunded" means the **net** cash, in the base
   currency and across all currencies, is below zero while positions are
   held. A USD buy paid from EUR cash is funded. A fee before the first
   deposit, with nothing held yet, is not an unfunded purchase. In that case:
   - `/exposure` adds a gap (`component: valuation`): "negative net cash
     balance: purchases without a recorded deposit are treated as
     borrowed…".
   - `/performance` adds a gap (`component: performance`): "cash went
     negative while holding positions…".
3. **No TWR and no drawdown over an unfunded window.** The value series is
   then the holdings net of a debt that nobody recorded. Any return on it is
   noise, whatever its sign: a buy below the close leaves a small positive
   residue that would read as +74 %. Both come back `null` with a gap that
   says what to do: record the deposits that funded the buys.
4. **Engine guards for any caller** (`timeWeightedReturn`, `drawdown`):
   - A day that ends empty (sell everything and withdraw the proceeds)
     uses the end-of-day flow convention, r = (V − F) / V₋₁ − 1. It returns
     the day's real return, not −100 % (or a negative denominator).
   - A day with neither capital nor holdings contributes nothing. That
     covers an empty portfolio, or one that only has a fee before its first
     deposit.
   - A positive value with no positive capital base behind it, or a day
     that would lose more than 100 %, makes the TWR `null`. It never chains
     a value below −100 %.
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
- Portfolios whose net cash never goes negative while they hold positions
  keep the same TWR, MWR and gaps, with one exception: a day that ends
  empty now gives that day's real return instead of −100 %. Only the
  `inputHash` changes otherwise, because the engine version is part of it.
- Partly funded (leveraged) portfolios also lose their TWR and drawdown.
  Phase 1 has no margin model, so a leveraged account and one whose
  deposits were never recorded look the same.
- Known limitation, from before this change: the drawdown runs on the raw
  value series, flows included. A full withdrawal still shows as a 100 %
  drawdown on that day. Measuring it on a flow-adjusted index would be a
  separate methodology change.
