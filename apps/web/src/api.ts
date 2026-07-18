/** Thin fetch client. Cookies carry the session; problem+json surfaces as Error. */

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  trace_id: string;
}

export class ApiError extends Error {
  constructor(public readonly problem: Problem) {
    super(problem.detail ?? problem.title);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    throw new ApiError(
      json ?? { type: 'unknown', title: res.statusText, status: res.status, trace_id: 'n/a' },
    );
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
};

export interface Me {
  id: string;
  email: string;
  jurisdiction: string;
  base_currency: string;
}

export interface Portfolio {
  id: string;
  name: string;
  type: string;
  base_currency: string;
}

export interface PositionRow {
  security_id: string;
  name: string;
  type: string;
  pricing_currency: string;
  quantity: string;
  avg_cost: string | null;
  cost_currency: string | null;
}

export interface ExposureResponse {
  data: {
    dimension: string;
    total_value_base: string;
    base_currency: string;
    slices: Array<{ key: string; weight: string; marketValueBase: string }>;
    weights: Array<{ securityId: string | null; label: string; weight: string; marketValueBase: string }>;
    look_through: Array<{ securityId: string | null; label: string; weight: string; viaDirect: string; viaFunds: string }>;
    concentration: {
      topN: Array<{ securityId: string; label: string; weight: string }>;
      hhi: string;
      effectiveN: string;
      nominalN: number;
    };
    cash_weight: string;
  };
  provenance: { engineVersion: string; inputHash: string; methodology: string };
  gaps: Array<{ component: string; reason: string; securityId?: string }>;
  staleness: { prices_as_of: string | null; fx_as_of: string | null; holdings_as_of: string | null };
}

// -- Phase 2: profile, scenarios, inference, rules, reality check -----------

export type Strategy = 'quality_growth' | 'value' | 'dividend_income' | 'passive_index' | 'unknown';

export interface Profile {
  version: number;
  experienceLevel: string | null;
  horizonYears: number | null;
  capitalBand: string | null;
  decumulation: boolean;
  statedStrategy: Strategy | null;
  inferredStrategy: Strategy | null;
  strategySource: string;
  strategyConfidence: string | null;
  riskStated: number | null;
  riskRevealed: number | null;
  riskDivergenceFlag: boolean;
  scenarioResponses: Array<{ scenarioId: string; answer: string; answerBand: number }>;
  changeReason: string;
  validFrom: string;
}

export interface RiskScenario {
  scenarioId: string;
  prompt: string;
  options: Array<{ key: string; label: string; band: number }>;
}

export interface StrategyInference {
  hypothesis: Strategy;
  confidence: string;
  evidence: Array<{ observation: string; metric: string; value: string }>;
  gaps: Array<{ component: string; reason: string }>;
}

export interface RuleRow {
  id: string;
  type: string;
  params: Record<string, unknown>;
  stated_reason: string;
  severity: string;
  created_at: string;
  evaluation: {
    status: 'ok' | 'breach' | 'not_evaluable';
    observed: { value: string | null; limit: string | null; detail: string | null };
    evaluated_at: string;
    breach_since: string | null;
  } | null;
}

export interface RuleSuggestion {
  type: string;
  params: Record<string, unknown>;
  current: string;
  rationale: string;
}

export interface Surprise {
  kind: string;
  headline: string;
  body: string;
  magnitude: string;
  score: string;
  values: Record<string, string | number>;
}

export interface RealityCheckResponse {
  data: {
    top: Surprise[];
    others: Array<{ kind: string; headline: string }>;
    total_value_base: string;
    base_currency: string;
    correlation: {
      clusters: Array<{
        members: Array<{ securityId: string; label: string; weight: string }>;
        weight: string;
        minPairCorrelation: string;
      }>;
      window_days: number;
    };
  };
  warnings: string[];
  gaps: Array<{ component: string; reason: string }>;
  provenance: { engineVersion: string; inputHash: string; methodology: string };
  staleness: { prices_as_of: string | null; fx_as_of: string | null; holdings_as_of: string | null };
}

export interface PerformanceResponse {
  data: {
    window?: { from: string; to: string };
    twr?: string | null;
    mwr?: string | null;
    max_drawdown?: string | null;
    current_drawdown?: string | null;
    currency_decomposition?: Array<{ currency: string; localReturn: string | null; fxReturn: string | null }>;
  } | null;
  gaps: Array<{ component: string; reason: string }>;
  staleness: { prices_as_of: string | null };
}
