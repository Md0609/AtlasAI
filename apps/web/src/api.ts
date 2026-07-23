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

// ---------------------------------------------------------------------------
// Copilot (§11.2)
// ---------------------------------------------------------------------------

export type CopilotContextType = 'security' | 'portfolio' | 'notification' | 'global';

export interface CopilotThread {
  id: string;
  title: string;
  context_type: CopilotContextType;
  context_ref: string | null;
  created_at: string;
  last_message_at: string;
}

export interface CopilotMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  degraded?: boolean;
  guard_approved?: boolean;
  created_at: string;
}

export interface JournalEntry {
  id: string;
  kind: string;
  occurred_at: string;
  security_id: string | null;
  security_name: string | null;
  title: string;
  detail: string;
  source: string;
  source_ref: string | null;
}

export interface Today {
  needs_attention: boolean;
  attention_count: number;
  reviewed: { holdings: number; updates: number; material: number; window_days: number };
  receipt: Array<{ security_id: string; name: string; updates: number }>;
  quiet_days: { quiet: number; of: number };
  open_questions: Array<{ kind: string; text: string; security?: string; observed?: unknown }>;
  weekly_review: { next: string };
}

export const copilot = {
  listThreads: () => api.get<{ data: CopilotThread[] }>('/v1/copilot/threads'),
  getThread: (id: string) =>
    api.get<{ data: { thread: CopilotThread; messages: CopilotMessage[] } }>(`/v1/copilot/threads/${id}`),
  open: (context_type: CopilotContextType, context_ref?: string | null) =>
    api.post<{ data: { thread: CopilotThread; messages: CopilotMessage[] } }>('/v1/copilot/threads', {
      context_type,
      context_ref: context_ref ?? null,
    }),

  /**
   * Send a message and stream the guarded answer over SSE. onDelta receives
   * each text chunk; the promise resolves when the `done` event arrives.
   */
  async stream(
    threadId: string,
    message: string,
    onDelta: (text: string) => void,
  ): Promise<{ id: string; degraded: boolean; guard_approved: boolean }> {
    const res = await fetch(`/v1/copilot/threads/${threadId}/stream`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new ApiError(
        text ? JSON.parse(text) : { type: 'unknown', title: res.statusText, status: res.status, trace_id: 'n/a' },
      );
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done = { id: '', degraded: false, guard_approved: true };
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';
      for (const evt of events) {
        const isDone = evt.includes('event: done');
        const dataLine = evt.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        const payload = JSON.parse(dataLine.slice(6));
        if (isDone) done = payload;
        else if (payload.delta) onDelta(payload.delta);
      }
    }
    return done;
  },
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

// -- Phase 3: theses, radars, briefs, decisions -----------------------------

export interface RadarConditionAst {
  metric:
    | { kind: 'price'; securityId: string }
    | { kind: 'valuation.pe_ttm'; securityId: string }
    | { kind: 'fundamental'; securityId: string; name: string }
    | { kind: 'portfolio.weight'; securityId: string }
    | { kind: 'portfolio.sector_exposure'; sector: string }
    | { kind: 'portfolio.cash_weight' }
    | { kind: 'rule.breach'; ruleId: string };
  operator: 'lt' | 'lte' | 'gt' | 'gte';
  target:
    | { kind: 'literal'; value: string }
    | { kind: 'self_history'; stat: 'median' | 'min' | 'max'; windowDays: number; factor?: string };
}

export interface ThesisCondition {
  id: string;
  condition_nl: string;
  rendered: string;
  status: 'watching' | 'met';
  met_at: string | null;
  radar: { id: string | null; status: string | null; last_observed: { value: string | null; target: string | null } | null };
}

export interface Thesis {
  id: string;
  security_id: string;
  security_name: string;
  version: number;
  statement: string;
  time_horizon_months: number | null;
  confidence_at_creation: number | null;
  status: 'active' | 'falsified' | 'retired' | 'superseded';
  status_reason: string | null;
  created_at: string;
  stale: boolean;
  conditions: ThesisCondition[];
}

export interface Radar {
  id: string;
  name: string;
  security_id: string | null;
  security_name: string | null;
  condition_nl: string;
  rendered: string;
  source: 'manual' | 'thesis';
  status: 'active' | 'paused' | 'archived';
  paused_reason: string | null;
  snoozed_until: string | null;
  last_met: boolean | null;
  last_observed: { value: string | null; target: string | null; gap?: string | null } | null;
  last_evaluated_at: string | null;
  fire_count: number;
  created_at: string;
}

export interface RadarFire {
  id: string;
  radar_id: string;
  radar_name: string;
  condition_nl: string;
  source: string;
  fired_at: string;
  observed: { value: string | null; target: string | null };
  brief_id: string | null;
}

export interface Brief {
  id: string;
  class: 'C0' | 'C1' | 'C2';
  headline: string;
  body: string;
  tone: 'neutral' | 'light' | 'calm';
  security_id: string | null;
  security_name: string | null;
  thesis_id: string | null;
  created_at: string;
  read_at: string | null;
}

export interface Decision {
  id: string;
  action: string;
  security_id: string | null;
  security_name: string | null;
  thesis_id: string | null;
  brief_id: string | null;
  reason_free_text: string;
  decided_at: string;
}

export interface Suppression {
  id: string;
  class: string;
  reason: string;
  created_at: string;
  headline: string | null;
}

export interface SecurityHit {
  id: string;
  name: string;
  type: string;
  currency: string;
  ticker: string;
  exchange: string;
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
