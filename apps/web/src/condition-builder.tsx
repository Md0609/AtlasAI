/**
 * Structured condition builder (§A4.3): the primary authoring surface —
 * every condition is machine-evaluable by construction. The NL box that
 * prefills this builder arrives with the LLM lane (Phase 4b); the builder
 * is the contract, not a stopgap.
 */
import { useState } from 'react';
import type { RadarConditionAst } from './api';

export type MetricKind = 'price' | 'valuation.pe_ttm' | 'portfolio.weight' | 'portfolio.cash_weight';

export interface BuilderValue {
  metricKind: MetricKind;
  operator: 'lt' | 'lte' | 'gt' | 'gte';
  targetKind: 'literal' | 'self_history';
  literal: string;
  stat: 'median' | 'min' | 'max';
  windowDays: number;
  factor: string;
}

export const defaultBuilderValue: BuilderValue = {
  metricKind: 'price',
  operator: 'lt',
  targetKind: 'literal',
  literal: '',
  stat: 'median',
  windowDays: 365,
  factor: '',
};

export function buildAst(v: BuilderValue, securityId: string): RadarConditionAst | null {
  const metric: RadarConditionAst['metric'] =
    v.metricKind === 'portfolio.cash_weight'
      ? { kind: 'portfolio.cash_weight' }
      : { kind: v.metricKind, securityId };
  let target: RadarConditionAst['target'];
  if (v.targetKind === 'literal') {
    if (!/^-?\d+(\.\d+)?$/.test(v.literal.trim())) return null;
    target = { kind: 'literal', value: v.literal.trim() };
  } else {
    target = {
      kind: 'self_history',
      stat: v.stat,
      windowDays: v.windowDays,
      ...(v.factor.trim() ? { factor: v.factor.trim() } : {}),
    };
  }
  return { metric, operator: v.operator, target };
}

const METRIC_LABELS: Record<MetricKind, string> = {
  price: 'Price',
  'valuation.pe_ttm': 'Trailing P/E',
  'portfolio.weight': 'Portfolio weight (look-through, 0–1)',
  'portfolio.cash_weight': 'Cash weight (0–1)',
};

export function ConditionBuilder({
  value,
  onChange,
  allowPortfolioMetrics,
}: {
  value: BuilderValue;
  onChange: (v: BuilderValue) => void;
  allowPortfolioMetrics: boolean;
}) {
  const [v, set] = [value, (patch: Partial<BuilderValue>) => onChange({ ...value, ...patch })];
  const metricOptions: MetricKind[] = allowPortfolioMetrics
    ? ['price', 'valuation.pe_ttm', 'portfolio.weight', 'portfolio.cash_weight']
    : ['price', 'valuation.pe_ttm', 'portfolio.weight'];
  const selfHistoryOk = v.metricKind === 'price' || v.metricKind === 'valuation.pe_ttm';

  return (
    <div className="builder">
      <div className="inline">
        <label>
          Metric
          <select value={v.metricKind} onChange={(e) => {
            const metricKind = e.target.value as MetricKind;
            set({ metricKind, ...(metricKind !== 'price' && metricKind !== 'valuation.pe_ttm' ? { targetKind: 'literal' } : {}) });
          }}>
            {metricOptions.map((m) => (
              <option key={m} value={m}>{METRIC_LABELS[m]}</option>
            ))}
          </select>
        </label>
        <label>
          Is
          <select value={v.operator} onChange={(e) => set({ operator: e.target.value as BuilderValue['operator'] })}>
            <option value="lt">below</option>
            <option value="lte">at or below</option>
            <option value="gt">above</option>
            <option value="gte">at or above</option>
          </select>
        </label>
        <label>
          Compared to
          <select
            value={v.targetKind}
            onChange={(e) => set({ targetKind: e.target.value as BuilderValue['targetKind'] })}
          >
            <option value="literal">a fixed value</option>
            {selfHistoryOk && <option value="self_history">its own history</option>}
          </select>
        </label>
      </div>
      {v.targetKind === 'literal' ? (
        <label>
          Value
          <input value={v.literal} placeholder="e.g. 150" onChange={(e) => set({ literal: e.target.value })} />
        </label>
      ) : (
        <div className="inline">
          <label>
            Statistic
            <select value={v.stat} onChange={(e) => set({ stat: e.target.value as BuilderValue['stat'] })}>
              <option value="median">median</option>
              <option value="min">minimum</option>
              <option value="max">maximum</option>
            </select>
          </label>
          <label>
            Window (days)
            <input
              type="number"
              min={30}
              value={v.windowDays}
              onChange={(e) => set({ windowDays: Math.max(30, Number(e.target.value) || 365) })}
            />
          </label>
          <label>
            × factor (optional)
            <input value={v.factor} placeholder="e.g. 0.9" onChange={(e) => set({ factor: e.target.value })} />
          </label>
        </div>
      )}
    </div>
  );
}
