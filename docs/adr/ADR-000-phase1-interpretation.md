# ADR-000 — Phase 1 scope interpretation and deliberate deferrals

Status: accepted · 2026-07-17

## Context

The PRD (§51.5) and the Design blueprint (§B1) both define phases, with
different numbering. Per the Design document's own framing ("ground truth"
milestone) and the instruction to build **Phase 1**, this repo implements
**Design §B1 Phase 1 — Ground truth**, plus the minimal Phase-0 scaffolding
Phase 1 structurally requires.

## In scope (built)

- **Security master + entity resolution**: `securities` / `listings` /
  `security_identifiers` with validity windows; ISIN-first resolution, then
  live (exchange, ticker); conflicts surface as quality findings. Ticker
  changes close the old listing window and open a new one — old tickers keep
  resolving at their historical dates (exercised by CSV import tests).
- **EOD price ingest** behind a `VendorAdapter` interface with a deterministic
  `MockVendorAdapter` (real-vendor bake-off is a §B8 decision that hasn't
  happened; the adapter boundary is the contract). The mock injects known
  defects (missing bars, an outlier, a stale series) so quality checks have
  something real to catch.
- **Corporate actions**: splits, dividends, ticker changes; split-adjusted
  close computed in SQL from future split ratios; adjusted series is
  continuous across ex-dates (integration-tested).
- **Fundamentals + ETF look-through seed**: snapshot fundamentals; fund
  holdings with deliberately partial coverage so the **explicit unknown
  slice (D-006)** renders end-to-end.
- **Portfolio/position/transaction CRUD + CSV import with mapping UI**:
  transactions are the source of truth (§27.3.4); positions and cash are a
  derived fold recomputed in the same DB transaction (§27.4). Manual position
  entry is a synthetic buy — no code path writes positions directly.
- **Signal Engine v1**: valuation, weights, recursive cycle-safe look-through,
  sector/country/currency exposure, concentration (top-N, HHI, effective-N),
  TWR/MWR(XIRR)/drawdown, FR-3.6 local-vs-FX decomposition. All decimal
  arithmetic (decimal.js, 34 digits, banker's rounding); no floats in any
  computation path. Golden datasets with hand-computed expected values,
  adversarial fixtures (§48.2), seeded property tests, byte-identical
  reproducibility (FR-5.6), provenance on every value (FR-5.5).
- **Phase-0 slice carried along**: Argon2id email/password auth, opaque
  sessions (sha256 at rest), jurisdiction capture + gate at registration
  (FR-1.3/1.4), append-only `audit_log` enforced by a DB trigger, RFC 9457
  problem+json with `trace_id` (§31.5), quality dashboard v0 as a CLI report.

## Key decisions

1. **Portfolio cap = 3** (Design §A5 explicitly cuts FR-3.1's "≥5" for MVP).
2. **Concentration methodology**: HHI/effective-N over the *known* look-through
   single names, renormalized. Preserves effective-N ≤ nominal-N and never
   treats the unknown slice as a name. Top-N weights stay on the honest
   whole-portfolio denominator.
3. **Currency exposure** is computed on direct pricing currency (positions +
   cash). Look-through currency attribution is future work; the methodology
   string says which is which.
4. **CSV import transport**: JSON `{csv, mapping, defaults}` instead of §31.2
   multipart. Multipart + screenshot import lane arrive with the full import
   pipeline; mapping semantics are identical. Documented deviation.
5. **Split transactions** carry the share *delta* in `quantity` (a 10:1 split
   on 10 shares is recorded as +90).
6. **XIRR** is bisection on a fixed bracket with a fixed iteration budget in
   pure decimal arithmetic — deterministic by construction, returns `null`
   (a declared gap) when no sign change exists rather than fabricating a rate.

## Deliberately deferred (not Phase 1)

OAuth/TOTP and managed identity (D-015); billing; IaC/Terraform; exchange
holiday calendars (trading days are Mon–Fri at Phase 1 — noted in
`@atlas/domain`); dividend-reinvestment-adjusted closes; multipart/screenshot
import; beta/factor loadings and any Phase-2+ analytics; the intelligence
layer entirely (P5–P7); real vendor integration pending the §B8 bake-off;
web quality dashboard (CLI report stands in; contract is stable).

## Consequences

Everything user-visible that is computed carries provenance and declared
gaps. The unknown is rendered, never redistributed. Later phases replace the
mock vendor and extend the API surface without changing the contracts in
`@atlas/contracts`.
