/**
 * @atlas/contracts — shared types: domain vocabulary, vendor records,
 * typed domain events (PRD §24.2), provenance (FR-5.5/5.6), API DTOs.
 *
 * Phase 1 scope only: identity scaffolding, security master, market data,
 * portfolio truth, Signal Engine v1 outputs. No intelligence-plane types yet
 * (Contextualization / UserFacingContent arrive in Phase 4a per Design §B1).
 */

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/** ISO-4217 currency code. Every monetary value carries one (PRD §27.3.3). */
export type Currency = string;

/** ISO-8601 calendar date, `YYYY-MM-DD`. */
export type IsoDate = string;

/** Decimal carried as a string. Money is NUMERIC, never float (PRD §27.3.2). */
export type DecimalString = string;

// ---------------------------------------------------------------------------
// Security master (PRD §27.2 SECURITY_MASTER — no user foreign keys, ever)
// ---------------------------------------------------------------------------

export type SecurityType = 'equity' | 'etf' | 'fund' | 'bond' | 'cash' | 'other';

export type IdentifierType = 'isin' | 'cusip' | 'sedol' | 'figi';

export type CorporateActionType =
  | 'split'
  | 'dividend'
  | 'ticker_change'
  | 'merger'
  | 'spinoff'
  | 'delisting';

export interface SecurityRef {
  id: string;
  name: string;
  type: SecurityType;
  isFund: boolean;
  gicsSector: string | null;
  gicsIndustry: string | null;
  country: string | null; // ISO-3166 alpha-2, country of risk
  currency: Currency; // trading/pricing currency of the primary listing
}

// ---------------------------------------------------------------------------
// Canonical vendor records (services/ingest normalization targets)
// The vendor adapter interface returns these; adapters translate vendor
// payloads into this shape. Mock vendor first (Design §B8), real vendor
// replaces it behind the same interface once the Phase-0 bake-off signs.
// ---------------------------------------------------------------------------

export interface VendorSecurity {
  vendorId: string;
  name: string;
  type: SecurityType;
  isin?: string;
  ticker: string;
  exchange: string; // MIC
  currency: Currency;
  country?: string;
  gicsSector?: string;
  gicsIndustry?: string;
  isFund: boolean;
}

export interface VendorBar {
  vendorId: string;
  date: IsoDate;
  open: DecimalString;
  high: DecimalString;
  low: DecimalString;
  close: DecimalString;
  volume: DecimalString;
  currency: Currency;
}

export interface VendorFxRate {
  base: Currency;
  quote: Currency;
  date: IsoDate;
  rate: DecimalString; // 1 base = rate quote
}

export interface VendorCorporateAction {
  vendorId: string;
  type: CorporateActionType;
  exDate: IsoDate;
  /** For splits: new shares per old share, e.g. "10" for a 10-for-1. */
  ratio?: DecimalString;
  /** For dividends: cash per share in `currency`. */
  cashAmount?: DecimalString;
  currency?: Currency;
  /** For ticker_change: the new ticker on the same exchange. */
  newTicker?: string;
  details?: Record<string, unknown>;
}

export interface VendorFundamental {
  vendorId: string;
  asOf: IsoDate;
  period: 'annual' | 'quarter' | 'ttm';
  metric: string; // e.g. 'revenue', 'eps_diluted', 'net_debt'
  value: DecimalString;
  currency?: Currency;
}

export interface VendorFundHolding {
  fundVendorId: string;
  holdingIsin?: string;
  holdingTicker?: string;
  holdingExchange?: string;
  holdingName: string;
  weight: DecimalString; // fraction of fund NAV, 0..1
  asOf: IsoDate;
}

// ---------------------------------------------------------------------------
// Portfolio (PRD §14.2, FR-3)
// ---------------------------------------------------------------------------

export type PortfolioType = 'taxable' | 'tax_advantaged' | 'pension' | 'other';

export type TransactionType =
  | 'buy'
  | 'sell'
  | 'dividend'
  | 'split'
  | 'spinoff'
  | 'fee'
  | 'fx'
  | 'deposit'
  | 'withdrawal';

export interface TransactionInput {
  securityId?: string; // null for cash-only movements (deposit/withdrawal/fee/fx)
  type: TransactionType;
  tradeDate: IsoDate;
  quantity?: DecimalString;
  price?: DecimalString; // per unit, in `currency`
  amount?: DecimalString; // signed cash effect in `currency`; derived if omitted for buy/sell
  currency: Currency;
  fee?: DecimalString;
  note?: string;
}

// ---------------------------------------------------------------------------
// Provenance (FR-5.5, FR-5.6) — attached to every Signal Engine output value
// ---------------------------------------------------------------------------

export interface Provenance {
  engineVersion: string;
  /** SHA-256 over canonicalized inputs: same inputs + same version ⇒ same hash. */
  inputHash: string;
  methodology: string; // stable methodology id, e.g. 'weights.v1'
  inputs: {
    pricesAsOf: IsoDate | null;
    fxAsOf: IsoDate | null;
    holdingsAsOf: IsoDate | null;
  };
}

export interface SignalValue<T> {
  value: T;
  provenance: Provenance;
}

// ---------------------------------------------------------------------------
// Signal Engine v1 outputs (Phase 1 subset of FR-3.4; factor loadings and
// beta deferred per Design §A4.4 / §A5)
// ---------------------------------------------------------------------------

export interface WeightRow {
  securityId: string | null; // null = cash
  label: string;
  marketValueBase: DecimalString;
  weight: DecimalString; // fraction of total portfolio value
}

export interface ExposureSlice {
  key: string; // sector / country / currency bucket; 'UNKNOWN' is first-class (D-006)
  weight: DecimalString;
  marketValueBase: DecimalString;
}

export interface LookThroughRow {
  securityId: string | null; // null = the explicit unknown slice
  label: string;
  weight: DecimalString;
  viaDirect: DecimalString;
  viaFunds: DecimalString;
}

export interface ConcentrationResult {
  topN: Array<{ securityId: string; label: string; weight: DecimalString }>;
  /** HHI over look-through single-name weights normalized to the known-equity subset. */
  hhi: DecimalString;
  effectiveN: DecimalString;
  nominalN: number;
}

export interface PerformanceResult {
  twr: DecimalString | null; // null when insufficient history — a first-class gap
  mwr: DecimalString | null;
  maxDrawdown: DecimalString | null;
  currentDrawdown: DecimalString | null;
  /** FR-3.6: local return vs FX return, separated, per currency bucket. */
  currencyDecomposition: Array<{
    currency: Currency;
    localReturn: DecimalString | null;
    fxReturn: DecimalString | null;
  }>;
}

// ---------------------------------------------------------------------------
// Typed domain events (PRD §24.2) — Phase 1 emits External + one Derived
// ---------------------------------------------------------------------------

export interface EventBase {
  eventId: string;
  occurredAt: string; // ISO-8601 timestamp
}

export interface MarketPriceEodEvent extends EventBase {
  type: 'market.price.eod';
  securityId: string;
  barDate: IsoDate;
}

export interface CorporateActionEvent extends EventBase {
  type: 'corporate.action';
  securityId: string;
  actionType: CorporateActionType;
  exDate: IsoDate;
}

export interface FundHoldingsUpdatedEvent extends EventBase {
  type: 'fund.holdings.updated';
  fundSecurityId: string;
  asOf: IsoDate;
}

export interface SignalRecomputedEvent extends EventBase {
  type: 'signal.recomputed';
  portfolioId: string;
  engineVersion: string;
  inputHash: string;
}

export type DomainEvent =
  | MarketPriceEodEvent
  | CorporateActionEvent
  | FundHoldingsUpdatedEvent
  | SignalRecomputedEvent;

// ---------------------------------------------------------------------------
// Investor Profile (Phase 2 "The mirror": FR-2, US-ONB-03/04)
// ---------------------------------------------------------------------------

export type ExperienceLevel = 'beginner' | 'intermediate' | 'advanced' | 'professional';

/** The four strategy cards (§6.1) plus first-class 'unknown' (FR-2.4). */
export type Strategy =
  | 'quality_growth'
  | 'value'
  | 'dividend_income'
  | 'passive_index'
  | 'unknown';

export type StrategySource = 'stated' | 'inferred' | 'hybrid' | 'unknown';

export type CapitalBand = '<25k' | '25k-100k' | '100k-500k' | '>500k';

/** 1 (sells everything at the first drawdown) … 5 (buys the dip on principle). */
export type RiskBand = 1 | 2 | 3 | 4 | 5;

export interface ScenarioResponse {
  scenarioId: string;
  /** The scenario text as shown, with calibrated amounts baked in (evidence). */
  prompt: string;
  answer: string;
  /** The band this answer maps to; revealed = rounded mean across scenarios. */
  answerBand: RiskBand;
}

export interface InvestorProfile {
  version: number;
  experienceLevel: ExperienceLevel | null;
  horizonYears: number | null;
  capitalBand: CapitalBand | null;
  monthlyContribution: DecimalString | null;
  contributionCurrency: Currency | null;
  decumulation: boolean;
  statedStrategy: Strategy | null;
  inferredStrategy: Strategy | null;
  strategySource: StrategySource;
  strategyConfidence: DecimalString | null;
  riskStated: RiskBand | null;
  riskRevealed: RiskBand | null;
  /** True when |stated − revealed| > 2 bands (US-ONB-04). */
  riskDivergenceFlag: boolean;
  scenarioResponses: ScenarioResponse[];
  changeReason: string;
  changedBy: 'user' | 'atlas_inference' | 'review';
  validFrom: string;
}

/** A risk scenario calibrated to the user's actual money (US-ONB-04). */
export interface RiskScenario {
  scenarioId: string;
  prompt: string;
  options: Array<{ key: string; label: string; band: RiskBand }>;
}

// ---------------------------------------------------------------------------
// Rules engine (F-05, US-ONB-05, §14.6) — every type deterministically
// evaluable by the Signal Engine; no rule type ships that isn't.
// ---------------------------------------------------------------------------

export type RuleType =
  | 'max_single_name'
  | 'max_sector'
  | 'min_cash'
  | 'max_cash'
  | 'no_buy_list'
  | 'max_positions'
  | 'min_holding_period';

/** Shape of `params` per rule type (stored as JSONB, validated at the API). */
export interface RuleParams {
  /** Fractional limit for weight-based rules, e.g. "0.15". */
  limit?: DecimalString;
  /** GICS sector for max_sector. */
  sector?: string;
  /** Security ids for no_buy_list. */
  securityIds?: string[];
  /** Human label for no_buy_list ("no tobacco, no defence"). */
  label?: string;
  /** Count for max_positions. */
  count?: number;
  /** Months for min_holding_period. */
  months?: number;
}

export type RuleEvaluationStatus = 'ok' | 'breach' | 'not_evaluable';

export interface RuleEvaluationResult {
  ruleId: string;
  status: RuleEvaluationStatus;
  observed: {
    /** Observed value in the rule's own unit (weight fraction, count, months). */
    value: DecimalString | null;
    limit: DecimalString | null;
    /** Specific offenders, e.g. the name over the limit or the early sell. */
    detail: string | null;
  };
}

// ---------------------------------------------------------------------------
// Strategy inference (F-04) — deterministic hypothesis, presented as such
// ---------------------------------------------------------------------------

export interface StrategyEvidence {
  observation: string; // e.g. "68% of the portfolio is in index funds"
  metric: string; // stable id, e.g. 'fund_weight'
  value: DecimalString;
}

export interface StrategyInference {
  hypothesis: Strategy;
  /** 0..1; scales with how much of the portfolio the evidence covers. */
  confidence: DecimalString;
  evidence: StrategyEvidence[];
  gaps: Array<{ component: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Data quality (Design §B1 Phase 1: quality checks + ops dashboard v0)
// ---------------------------------------------------------------------------

export type QualityCheckKind =
  | 'completeness'
  | 'staleness'
  | 'outlier'
  | 'holdings_weight_sum'
  | 'identifier_conflict';

export interface QualityFinding {
  kind: QualityCheckKind;
  severity: 'info' | 'warn' | 'error';
  securityId?: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface QualityReport {
  generatedAt: string;
  universeSize: number;
  barsIngested: number;
  findings: QualityFinding[];
  summary: Record<QualityCheckKind, { warn: number; error: number }>;
}

// ---------------------------------------------------------------------------
// API DTOs (subset per §31.2 needed for Phase 1)
// ---------------------------------------------------------------------------

export interface ApiProblem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  trace_id: string;
}

export interface StalenessBlock {
  prices_as_of: IsoDate | null;
  fx_as_of: IsoDate | null;
  holdings_as_of: IsoDate | null;
}
