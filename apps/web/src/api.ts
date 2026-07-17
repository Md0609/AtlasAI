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
  del: <T>(path: string) => request<T>('DELETE', path),
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
