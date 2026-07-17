/**
 * Correlation clusters (correlation.v1) + Surprise Detector (surprise.v1).
 * Property checks per §48.2: correlation bounded and symmetric-by-construction,
 * short history always warned, detectors fire deterministically, top-3 ranking
 * honors the unawareness prior.
 */
import { describe, expect, it } from 'vitest';
import { dec } from '@atlas/domain';
import {
  MIN_OBSERVATIONS,
  correlationClusters,
  detectSurprises,
  type ReturnSeriesInput,
  type SurpriseContext,
} from '../src/index.js';
import type { PortfolioSignals } from '../src/engine.js';

// -- helpers ---------------------------------------------------------------

/** Deterministic daily closes from a seed walk; two series with the same
 *  driver are near-perfectly correlated. */
function series(
  securityId: string,
  weight: string,
  days: number,
  driver: (t: number) => number,
  scale = 100,
): ReturnSeriesInput {
  const bars: Array<{ date: string; close: string }> = [];
  let px = scale;
  const start = Date.parse('2026-01-01T00:00:00Z');
  for (let t = 0; t < days; t++) {
    px = px * (1 + driver(t));
    bars.push({
      date: new Date(start + t * 86_400_000).toISOString().slice(0, 10),
      close: px.toFixed(6),
    });
  }
  return { securityId, label: securityId.toUpperCase(), weight, bars };
}

const driverA = (t: number) => 0.01 * Math.sin(0.9 * t) + 0.001;
const driverB = (t: number) => 0.013 * Math.sin(0.9 * t) - 0.0002; // same driver → high corr
const driverC = (t: number) => 0.011 * Math.cos(1.7 * t + 2); // different driver

describe('correlation.v1', () => {
  it('clusters co-moving series and leaves independent ones out', () => {
    const res = correlationClusters([
      series('aaa', '0.2', 200, driverA),
      series('bbb', '0.15', 200, driverB),
      series('ccc', '0.1', 200, driverC),
    ]);
    expect(res.clusters.length).toBe(1);
    const cluster = res.clusters[0]!;
    expect(cluster.members.map((m) => m.securityId).sort()).toEqual(['aaa', 'bbb']);
    expect(dec(cluster.weight).eq('0.35')).toBe(true);
    expect(dec(cluster.minPairCorrelation).gte('0.7')).toBe(true);
    // All pairwise correlations bounded in [-1, 1].
    for (const p of res.pairs) {
      expect(dec(p.correlation).abs().lte(1)).toBe(true);
    }
  });

  it('warns when the overlapping window is under one year (US-PF-03)', () => {
    const res = correlationClusters([
      series('aaa', '0.2', 120, driverA),
      series('bbb', '0.15', 120, driverB),
    ]);
    expect(res.warnings.some((w) => w.includes('under the 1 year'))).toBe(true);
  });

  it('declares a gap instead of correlating on too little data', () => {
    const res = correlationClusters([
      series('aaa', '0.2', MIN_OBSERVATIONS - 10, driverA),
      series('bbb', '0.15', 200, driverB),
    ]);
    expect(res.gaps.some((g) => g.securityId === 'aaa')).toBe(true);
    expect(res.pairs.length).toBe(0);
  });

  it('is deterministic: identical input, byte-identical output (FR-5.6)', () => {
    const input = [series('aaa', '0.2', 200, driverA), series('bbb', '0.15', 200, driverB)];
    expect(JSON.stringify(correlationClusters(input))).toBe(JSON.stringify(correlationClusters(input)));
  });
});

// -- surprise detector -----------------------------------------------------

function fakeSignals(overrides: Partial<PortfolioSignals> = {}): PortfolioSignals {
  const base: PortfolioSignals = {
    portfolioId: 'p1',
    engineVersion: 'test',
    inputHash: 'h',
    totalValueBase: '100000',
    baseCurrency: 'EUR',
    weights: { value: [], provenance: prov() },
    lookThrough: {
      value: [
        { securityId: 'msft', label: 'Microsoft', weight: '0.093', viaDirect: '0.031', viaFunds: '0.062' },
        { securityId: 'aapl', label: 'Apple', weight: '0.18', viaDirect: '0.18', viaFunds: '0' },
      ],
      provenance: prov(),
    },
    exposure: {
      sector: { value: [], provenance: prov() },
      country: { value: [], provenance: prov() },
      currency: {
        value: [
          { key: 'USD', weight: '0.71', marketValueBase: '71000' },
          { key: 'EUR', weight: '0.29', marketValueBase: '29000' },
        ],
        provenance: prov(),
      },
    },
    concentration: {
      value: { topN: [], hhi: '0.12', effectiveN: '8.4', nominalN: 22 },
      provenance: prov(),
    },
    cashWeight: '0.05',
    gaps: [],
    pricesAsOf: '2026-06-30',
    fxAsOf: '2026-06-30',
    holdingsAsOf: '2026-06-30',
    event: {
      type: 'signal.recomputed',
      eventId: 'e',
      occurredAt: 't',
      portfolioId: 'p1',
      engineVersion: 'test',
      inputHash: 'h',
    },
  };
  return { ...base, ...overrides };
}

function prov() {
  return {
    engineVersion: 'test',
    inputHash: 'h',
    methodology: 'test',
    inputs: { pricesAsOf: null, fxAsOf: null, holdingsAsOf: null },
  };
}

const baseCtx = (): SurpriseContext => ({
  signals: fakeSignals(),
  correlation: null,
  statedStrategy: null,
  inferredStrategy: null,
  baseCurrency: 'EUR',
});

describe('surprise.v1', () => {
  it('reproduces the §14.3 worked example shape: hidden MSFT, effective-N, FX', () => {
    const res = detectSurprises(baseCtx());
    const kinds = res.top.map((s) => s.kind);
    // Priya's three surprises, ranked by unawareness prior:
    expect(kinds[0]).toBe('lookthrough_gap');
    expect(kinds).toContain('foreign_currency');
    expect(kinds).toContain('effective_n');
    const msft = res.top[0]!;
    expect(msft.headline).toContain('Microsoft');
    expect(msft.body).toContain('9.3%'); // total = computed, not generated
    expect(msft.body).toContain('3.1%');
    // Single-name concentration (18% Apple) exists but is OUT of the top 3 —
    // the user typed that position in themselves (low unawareness prior).
    expect(kinds).not.toContain('single_name_concentration');
    expect(res.others.some((o) => o.kind === 'single_name_concentration')).toBe(true);
  });

  it('flags a stated-vs-inferred strategy mismatch only when both are known', () => {
    const ctx = baseCtx();
    ctx.statedStrategy = 'value';
    ctx.inferredStrategy = 'quality_growth';
    const res = detectSurprises(ctx);
    const all = [...res.top, ...res.others.map((o) => ({ kind: o.kind }))];
    expect(all.some((s) => s.kind === 'strategy_mismatch')).toBe(true);

    ctx.inferredStrategy = 'unknown';
    const res2 = detectSurprises(ctx);
    const all2 = [...res2.top, ...res2.others.map((o) => ({ kind: o.kind }))];
    expect(all2.some((s) => s.kind === 'strategy_mismatch')).toBe(false);
  });

  it('propagates correlation warnings and surfaces a >25% cluster', () => {
    const ctx = baseCtx();
    ctx.correlation = {
      pairs: [],
      clusters: [
        {
          members: [
            { securityId: 'a', label: 'Adobe', weight: '0.25' },
            { securityId: 'b', label: 'Salesforce', weight: '0.20' },
          ],
          weight: '0.45',
          minPairCorrelation: '0.81',
        },
      ],
      windowDays: 120,
      warnings: ['correlations are computed on 120 days of overlapping history — under the 1 year needed'],
      gaps: [],
    };
    const res = detectSurprises(ctx);
    const cluster = [...res.top].find((s) => s.kind === 'correlation_cluster');
    expect(cluster).toBeTruthy();
    expect(cluster!.body).toContain('Adobe');
    expect(cluster!.body).toContain('45.0%');
    expect(res.warnings.length).toBe(1);
  });

  it('a quiet portfolio produces no manufactured surprises', () => {
    const ctx = baseCtx();
    ctx.signals = fakeSignals({
      lookThrough: {
        value: [
          { securityId: 'a', label: 'A', weight: '0.05', viaDirect: '0.05', viaFunds: '0' },
          { securityId: 'b', label: 'B', weight: '0.05', viaDirect: '0.05', viaFunds: '0' },
          { securityId: 'c', label: 'C', weight: '0.04', viaDirect: '0.04', viaFunds: '0' },
          { securityId: 'd', label: 'D', weight: '0.04', viaDirect: '0.04', viaFunds: '0' },
        ],
        provenance: prov(),
      },
      exposure: {
        sector: { value: [], provenance: prov() },
        country: { value: [], provenance: prov() },
        currency: {
          value: [{ key: 'EUR', weight: '1', marketValueBase: '100000' }],
          provenance: prov(),
        },
      },
      concentration: {
        value: { topN: [], hhi: '0.25', effectiveN: '3.9', nominalN: 4 },
        provenance: prov(),
      },
    });
    const res = detectSurprises(ctx);
    expect(res.top.length).toBe(0);
    expect(res.others.length).toBe(0);
  });
});
