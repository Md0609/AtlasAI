/**
 * Radar condition evaluation (radar.v1) — §16.1: "the evaluation is not
 * [an LLM]. An LLM never decides whether a radar fires." Pure decimal
 * arithmetic over pre-loaded context; not-computable is a declared gap,
 * never a guess (P6).
 *
 * P/E history note: trailing P/E series uses the latest TTM EPS against the
 * price series (the vendor snapshot carries one EPS point). This is stated
 * in the methodology, not hidden — a per-date EPS series upgrades it without
 * changing the contract.
 */
import type { RadarCondition, RadarEvaluation, RadarMetric, RadarTarget } from '@atlas/contracts';
import { Dec, dec, str } from '@atlas/domain';

export interface RadarEvalContext {
  /** Adjusted close history per security, ascending by date. */
  priceHistory: Map<string, Array<{ date: string; close: string }>>;
  /** Latest TTM diluted EPS per security (same currency as price). */
  epsBySecurity: Map<string, string>;
  /** Consolidated portfolio state; null when the user has no positions. */
  portfolio: {
    lookThroughWeights: Map<string, string>;
    sectorExposure: Map<string, string>;
    cashWeight: string;
  } | null;
  /** Latest rule evaluation status per rule id. */
  ruleBreach: Map<string, boolean>;
}

/** Structural validation: reject conditions the engine cannot evaluate. */
export function validateRadarCondition(c: RadarCondition): string[] {
  const errors: string[] = [];
  const m = c.metric;
  if (m.kind === 'fundamental' && !m.name) errors.push('fundamental metric requires a name');
  if (m.kind === 'portfolio.sector_exposure' && !m.sector) errors.push('sector is required');
  if (c.target.kind === 'self_history') {
    if (m.kind !== 'price' && m.kind !== 'valuation.pe_ttm') {
      errors.push('self_history targets are only supported for price and valuation metrics');
    }
    if (c.target.windowDays < 30) errors.push('self_history window must be at least 30 days');
    if (c.target.factor !== undefined && !/^\d+(\.\d+)?$/.test(c.target.factor)) {
      errors.push('self_history factor must be a positive decimal string');
    }
  }
  if (m.kind === 'rule.breach' && c.target.kind !== 'literal') {
    errors.push('rule.breach conditions take a literal target');
  }
  return errors;
}

function metricSeries(m: RadarMetric, ctx: RadarEvalContext): Array<{ date: string; value: Dec }> | null {
  if (m.kind === 'price') {
    const bars = ctx.priceHistory.get(m.securityId);
    if (!bars || bars.length === 0) return null;
    return bars.map((b) => ({ date: b.date, value: dec(b.close) }));
  }
  if (m.kind === 'valuation.pe_ttm') {
    const bars = ctx.priceHistory.get(m.securityId);
    const eps = ctx.epsBySecurity.get(m.securityId);
    if (!bars || bars.length === 0 || !eps || dec(eps).lte(0)) return null;
    return bars.map((b) => ({ date: b.date, value: dec(b.close).div(eps) }));
  }
  return null;
}

function currentValue(m: RadarMetric, ctx: RadarEvalContext): { value: Dec | null; gap: string | null } {
  switch (m.kind) {
    case 'price':
    case 'valuation.pe_ttm': {
      const series = metricSeries(m, ctx);
      if (!series) {
        return {
          value: null,
          gap: m.kind === 'price' ? 'no price history for this security' : 'no price history or no positive TTM EPS',
        };
      }
      return { value: series[series.length - 1]!.value, gap: null };
    }
    case 'fundamental':
      // Resolved from the fundamentals map in evaluateRadarCondition.
      return { value: null, gap: 'unreachable' };
    case 'portfolio.weight': {
      if (!ctx.portfolio) return { value: null, gap: 'no portfolio state' };
      const w = ctx.portfolio.lookThroughWeights.get(m.securityId);
      return { value: dec(w ?? 0), gap: null };
    }
    case 'portfolio.sector_exposure': {
      if (!ctx.portfolio) return { value: null, gap: 'no portfolio state' };
      return { value: dec(ctx.portfolio.sectorExposure.get(m.sector) ?? 0), gap: null };
    }
    case 'portfolio.cash_weight': {
      if (!ctx.portfolio) return { value: null, gap: 'no portfolio state' };
      return { value: dec(ctx.portfolio.cashWeight), gap: null };
    }
    case 'rule.breach': {
      const b = ctx.ruleBreach.get(m.ruleId);
      if (b === undefined) return { value: null, gap: 'rule has no evaluation yet' };
      return { value: dec(b ? 1 : 0), gap: null };
    }
  }
}

/** Extended context: latest fundamental value per (securityId, metric name). */
export interface RadarEvalContextFull extends RadarEvalContext {
  fundamentals: Map<string, string>; // key `${securityId}:${name}`
}

function resolveTarget(
  t: RadarTarget,
  m: RadarMetric,
  ctx: RadarEvalContext,
): { target: Dec | null; gap: string | null } {
  if (t.kind === 'literal') return { target: dec(t.value), gap: null };
  const series = metricSeries(m, ctx);
  if (!series) return { target: null, gap: 'no history to compute the self-history target' };
  const lastDate = series[series.length - 1]!.date;
  const cutoffMs = Date.parse(`${lastDate}T00:00:00Z`) - t.windowDays * 86_400_000;
  const window = series.filter((p) => Date.parse(`${p.date}T00:00:00Z`) >= cutoffMs);
  if (window.length < 10) {
    return { target: null, gap: `only ${window.length} observations in the self-history window (need 10)` };
  }
  const values = window.map((p) => p.value).sort((a, b) => a.cmp(b));
  let stat: Dec;
  if (t.stat === 'min') stat = values[0]!;
  else if (t.stat === 'max') stat = values[values.length - 1]!;
  else {
    const mid = Math.floor(values.length / 2);
    stat =
      values.length % 2 === 1 ? values[mid]! : values[mid - 1]!.plus(values[mid]!).div(2);
  }
  return { target: t.factor ? stat.times(t.factor) : stat, gap: null };
}

export function evaluateRadarCondition(
  condition: RadarCondition,
  ctx: RadarEvalContextFull,
): RadarEvaluation {
  // Fundamentals resolve from the dedicated map; everything else from currentValue.
  let value: Dec | null;
  let gap: string | null;
  if (condition.metric.kind === 'fundamental') {
    const key = `${condition.metric.securityId}:${condition.metric.name}`;
    const v = ctx.fundamentals.get(key);
    value = v === undefined ? null : dec(v);
    gap = v === undefined ? `no fundamental "${condition.metric.name}" on file for this security` : null;
  } else {
    ({ value, gap } = currentValue(condition.metric, ctx));
  }
  if (value === null) return { value: null, target: null, met: null, gap };

  const { target, gap: tGap } = resolveTarget(condition.target, condition.metric, ctx);
  if (target === null) return { value: str(value), target: null, met: null, gap: tGap };

  let met: boolean;
  switch (condition.operator) {
    case 'lt':
      met = value.lt(target);
      break;
    case 'lte':
      met = value.lte(target);
      break;
    case 'gt':
      met = value.gt(target);
      break;
    case 'gte':
      met = value.gte(target);
      break;
  }
  return { value: str(value), target: str(target), met, gap: null };
}

/** Human rendering of the compiled rule (§16.2: shown for confirmation). */
export function renderCondition(c: RadarCondition): string {
  const metric = (() => {
    switch (c.metric.kind) {
      case 'price':
        return 'price';
      case 'valuation.pe_ttm':
        return 'trailing P/E';
      case 'fundamental':
        return c.metric.name;
      case 'portfolio.weight':
        return 'portfolio weight (look-through)';
      case 'portfolio.sector_exposure':
        return `${c.metric.sector} exposure`;
      case 'portfolio.cash_weight':
        return 'cash weight';
      case 'rule.breach':
        return 'rule breach';
    }
  })();
  const op = { lt: 'below', lte: 'at or below', gt: 'above', gte: 'at or above' }[c.operator];
  const target =
    c.target.kind === 'literal'
      ? c.target.value
      : `its own ${c.target.windowDays}-day ${c.target.stat}${c.target.factor ? ` × ${c.target.factor}` : ''}`;
  return `${metric} ${op} ${target}`;
}
