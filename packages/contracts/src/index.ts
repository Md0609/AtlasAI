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
// Contextualization (Phase 4a, §A4.1) — the structural provenance guarantee.
//
// The PSA does not emit free prose. It emits this document: typed sections
// where every numeral is a REFERENCE to a signal value, and the renderer
// refuses a literal numeral outside a quoted user span. Escapes then require
// a failure in the deterministic layers — testable to actual zero — and
// US-AI-02's 100% provenance is free: unprovenanced numbers are
// unrepresentable.
// ---------------------------------------------------------------------------

export type ContextSectionType = 'fact' | 'tension' | 'nuance' | 'countercase' | 'unknown';

/** §17.3 closed tension taxonomy. */
export type TensionType = 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7';

/** Where a verbatim user quote comes from — always the user's own rows (§28.2). */
export interface UserQuoteSource {
  table: 'theses' | 'thesis_conditions' | 'rules' | 'decisions' | 'profile_versions';
  id: string;
  column: string;
}

export type ContextSpan =
  /** Prose. MUST contain no numerals — the guard hard-fails otherwise. */
  | { kind: 'text'; text: string }
  /** A number, by reference. Formatting is rendering, not generation. */
  | { kind: 'signal'; signalId: string; format?: 'number' | 'percent' | 'currency'; dp?: number }
  /** The user's own words, verbatim; verified against the stored row. */
  | { kind: 'user_quote'; text: string; source: UserQuoteSource };

export interface ContextSection {
  type: ContextSectionType;
  spans: ContextSpan[];
  /** Required for tension sections. T1/T2 must anchor to the user's own row
   *  (§28.2: "a tension is a typed edge to something the user wrote"). */
  tensionType?: TensionType;
  anchor?: { table: UserQuoteSource['table']; id: string };
}

export interface ContextSignalValue {
  value: DecimalString;
  /** Required when format 'currency' renders this signal (§27.3.3). */
  currency?: Currency;
  provenance: Provenance;
}

/** §17.4: a confidence statement without falsifiers is a vibe. */
export interface ContextConfidence {
  level: 'high' | 'medium' | 'low' | 'insufficient';
  basis: ContextSpan[];
  whatWouldChangeIt: string[]; // required, non-empty, rendered
}

export interface ContextualizationDoc {
  userId: string; // Layer 2 is personal by definition (§21.2)
  subject: { scope: 'security' | 'portfolio'; securityId?: string };
  sections: ContextSection[];
  confidence: ContextConfidence;
  /** The signal bundle: every value a span may reference, with provenance. */
  signals: Record<string, ContextSignalValue>;
  generator: { agent: string; promptVersion: string; model: string };
}

// ---------------------------------------------------------------------------
// Agent I/O vocabulary (Phase 4b, §22). Layer-1 shared analysis and the
// Layer-2 PSA speak these typed shapes.
// ---------------------------------------------------------------------------

/**
 * A Layer-1 SecurityContext (§21.2). No user field, by construction — the
 * cache key and the regulatory boundary are the same line. Its signals are
 * security-level facts (valuation, fundamentals), never user weights.
 */
export interface SecurityContext {
  securityId: string;
  name: string;
  gicsSector: string | null;
  signals: Record<string, ContextSignalValue>;
}

/** One typed finding from a specialist or the Red Team (§22.14). */
export interface Finding {
  agent: string;
  kind: string; // e.g. 'financial.trend', 'valuation.multiple', 'redteam.bear'
  /** Prose about the numbers — numbers themselves are referenced by signalRefs. */
  statement: string;
  signalRefs: string[];
  confidence: ContextConfidence['level'];
}

// ---------------------------------------------------------------------------
// Compliance Guard verdicts (Phase 4a, §21.6 / §A4.1)
// ---------------------------------------------------------------------------

export type GuardLayer = 'structural' | 'lexical' | 'classifier';

export interface GuardViolation {
  layer: GuardLayer;
  code: string; // stable rule id, e.g. 'lex.directive_verb'
  detail: string;
}

export interface GuardVerdict {
  approved: boolean;
  violations: GuardViolation[];
  rulesetVersion: string; // lexical rule set version — versioned like code (FR-12.3)
  classifierVersion: string;
  classifierScore: DecimalString;
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// Radar conditions (Phase 3, §16.3 grammar — the MVP machine-evaluable
// subset per FR-7.3; compound conditions and time qualifiers are v1.1 per
// FR-7.4). Comparisons are edge-triggered by the evaluator, which makes
// crosses_above/below redundant: `price <= X` fired on the false→true
// transition IS a downward cross.
// ---------------------------------------------------------------------------

export type RadarMetric =
  | { kind: 'price'; securityId: string }
  | { kind: 'valuation.pe_ttm'; securityId: string }
  | { kind: 'fundamental'; securityId: string; name: string }
  | { kind: 'portfolio.weight'; securityId: string } // look-through total
  | { kind: 'portfolio.sector_exposure'; sector: string }
  | { kind: 'portfolio.cash_weight' }
  | { kind: 'rule.breach'; ruleId: string };

export type RadarOperator = 'lt' | 'lte' | 'gt' | 'gte';

export type RadarTarget =
  | { kind: 'literal'; value: DecimalString }
  /** A stat over the metric's own history, e.g. "below its 5y median × 0.9". */
  | { kind: 'self_history'; stat: 'median' | 'min' | 'max'; windowDays: number; factor?: DecimalString };

export interface RadarCondition {
  metric: RadarMetric;
  operator: RadarOperator;
  target: RadarTarget;
}

export interface RadarEvaluation {
  /** Current metric value; null when not computable (declared gap). */
  value: DecimalString | null;
  /** Resolved target value; null when not computable. */
  target: DecimalString | null;
  met: boolean | null; // null = not evaluable
  gap: string | null;
}

// ---------------------------------------------------------------------------
// Correlation clusters (US-PF-03, §14.3 D8) — Phase 2, computed on available
// history with an explicit warning when the window is short.
// ---------------------------------------------------------------------------

export interface CorrelationPair {
  a: string; // securityId
  b: string;
  correlation: DecimalString;
  observations: number;
}

export interface CorrelationCluster {
  members: Array<{ securityId: string; label: string; weight: DecimalString }>;
  /** Σ direct weights of the members, as a fraction of total portfolio. */
  weight: DecimalString;
  /** Minimum pairwise correlation inside the cluster. */
  minPairCorrelation: DecimalString;
}

export interface CorrelationResult {
  pairs: CorrelationPair[];
  clusters: CorrelationCluster[];
  /** Days of history actually used; <365 carries a mandatory warning. */
  windowDays: number;
  warnings: string[];
  gaps: Array<{ component: string; reason: string; securityId?: string }>;
}

// ---------------------------------------------------------------------------
// Portfolio Reality Check (F-09, §14.3) — Surprise Detector, template-
// narrated v0 (Design §B1 Phase 2; LLM narration arrives Phase 4b).
// ---------------------------------------------------------------------------

export type SurpriseKind =
  | 'lookthrough_gap' // D1: hidden exposure arriving through funds
  | 'effective_n' // D2: nominal diversification vs effective
  | 'single_name_concentration' // D4
  | 'foreign_currency' // D5
  | 'strategy_mismatch' // D6: stated vs inferred strategy
  | 'correlation_cluster'; // D8

export interface Surprise {
  kind: SurpriseKind;
  headline: string;
  body: string;
  /** Raw magnitude of the finding, before the unawareness prior. */
  magnitude: DecimalString;
  /** magnitude × unawareness prior — the ranking key (§14.3). */
  score: DecimalString;
  /** The numbers narrated, machine-readable (every numeral is computed). */
  values: Record<string, DecimalString | string | number>;
}

export interface RealityCheckResult {
  /** Top 3 by score (§14.3: "Top 3 only" — the rest are one click away). */
  top: Surprise[];
  /** Remaining detected surprises, headline only. */
  others: Array<{ kind: SurpriseKind; headline: string }>;
  warnings: string[];
  gaps: Array<{ component: string; reason: string }>;
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

export interface RadarFiredEvent extends EventBase {
  type: 'radar.fired';
  radarId: string;
  userId: string;
}

/**
 * §24.2: thesis.falsified is downstream of radar.fired. The event records
 * that the user's own stated condition was met — the thesis STATUS change
 * remains a user decision (P1: Atlas surfaces, the user decides).
 */
export interface ThesisFalsifiedEvent extends EventBase {
  type: 'thesis.falsified';
  thesisId: string;
  conditionId: string;
  userId: string;
}

export type DomainEvent =
  | MarketPriceEodEvent
  | CorporateActionEvent
  | FundHoldingsUpdatedEvent
  | SignalRecomputedEvent
  | RadarFiredEvent
  | ThesisFalsifiedEvent;

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

// ---------------------------------------------------------------------------
// Relevance scoring (§18.3) — the deterministic ranking model. Independent of
// the LLM provider by construction: pure arithmetic over normalized features.
// ---------------------------------------------------------------------------

/**
 * A persona is the user's strategy classification (§6.1). It selects the
 * default relevance weights and the weekly notification budget. Derived from
 * the profile's stated strategy, falling back to inferred, then 'unknown'.
 */
export type Persona = Strategy;

/**
 * The nine relevance inputs (§18.3). Each is normalized to [0, 1] as a decimal
 * string; normalization is the caller's job (feature extraction), so the scorer
 * stays a pure weighted sum and is unit-testable in isolation.
 */
export interface RelevanceFeatures {
  materiality: DecimalString;
  positionWeight: DecimalString;
  thesisLinkage: DecimalString;
  ruleLinkage: DecimalString;
  strategyLinkage: DecimalString;
  novelty: DecimalString;
  actionability: DecimalString;
  noisePrior: DecimalString;
  recentVolume: DecimalString;
}

/**
 * The nine weights (§18.3): w1..w7 are additive, w8..w9 are subtracted (their
 * sign is applied by the scorer, so weights are stored as positive magnitudes).
 */
export interface RelevanceWeights {
  w1: DecimalString; // materiality
  w2: DecimalString; // positionWeight
  w3: DecimalString; // thesisLinkage
  w4: DecimalString; // ruleLinkage
  w5: DecimalString; // strategyLinkage
  w6: DecimalString; // novelty
  w7: DecimalString; // actionability
  w8: DecimalString; // noisePrior   (subtracted)
  w9: DecimalString; // recentVolume (subtracted)
}

/** A candidate interruption to be scored/ranked; `id` is the stable tie-break. */
export interface RelevanceCandidate {
  id: string;
  features: RelevanceFeatures;
}

export interface ScoredCandidate extends RelevanceCandidate {
  score: DecimalString;
}

/** Weekly notification budget per persona (§18.3 "weekly notification budgets"). */
export type WeeklyBudget = Record<Persona, number>;
