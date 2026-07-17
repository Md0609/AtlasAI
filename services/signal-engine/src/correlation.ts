/**
 * Correlation clusters (correlation.v1) — US-PF-03, §14.3 D8.
 *
 * Pairwise Pearson correlation of daily simple returns over the common
 * date window, in pure decimal arithmetic (FR-5.6: deterministic, byte-
 * identical). Clusters are connected components over pairs with
 * correlation ≥ threshold; cluster weight is the sum of members' direct
 * portfolio weights.
 *
 * Honesty rules:
 *  - pairs with fewer than MIN_OBSERVATIONS overlapping returns are not
 *    evaluated (declared gap), never guessed;
 *  - a window under one year always carries a warning (US-PF-03: "explicit
 *    warning where history is <1y").
 */
import type { CorrelationCluster, CorrelationPair, CorrelationResult } from '@atlas/contracts';
import { Dec, ZERO, dec, str } from '@atlas/domain';

export interface ReturnSeriesInput {
  securityId: string;
  label: string;
  /** Direct portfolio weight (fraction of total value). */
  weight: string;
  /** Daily closes, ascending by date; returns are computed on adjacent days. */
  bars: Array<{ date: string; close: string }>;
}

export const MIN_OBSERVATIONS = 60;
export const CLUSTER_THRESHOLD = '0.7';

export function correlationClusters(
  series: ReturnSeriesInput[],
  threshold: string = CLUSTER_THRESHOLD,
): CorrelationResult {
  const gaps: CorrelationResult['gaps'] = [];
  const warnings: string[] = [];

  // Daily simple returns keyed by date, per security.
  const returns = new Map<string, Map<string, Dec>>();
  let windowStart: string | null = null;
  let windowEnd: string | null = null;
  for (const s of [...series].sort((a, b) => a.securityId.localeCompare(b.securityId))) {
    const r = new Map<string, Dec>();
    for (let i = 1; i < s.bars.length; i++) {
      const prev = dec(s.bars[i - 1]!.close);
      if (prev.isZero()) continue;
      r.set(s.bars[i]!.date, dec(s.bars[i]!.close).div(prev).minus(1));
    }
    if (r.size + 1 < MIN_OBSERVATIONS) {
      gaps.push({
        component: 'correlation',
        reason: `only ${r.size} daily returns available (need ${MIN_OBSERVATIONS})`,
        securityId: s.securityId,
      });
      continue;
    }
    returns.set(s.securityId, r);
    const first = s.bars[0]!.date;
    const last = s.bars[s.bars.length - 1]!.date;
    if (!windowStart || first > windowStart) windowStart = first; // common window: latest start
    if (!windowEnd || last < windowEnd) windowEnd = last; // earliest end
  }

  const windowDays =
    windowStart && windowEnd && windowEnd > windowStart
      ? Math.round((Date.parse(`${windowEnd}T00:00:00Z`) - Date.parse(`${windowStart}T00:00:00Z`)) / 86_400_000)
      : 0;
  if (returns.size >= 2 && windowDays < 365) {
    warnings.push(
      `correlations are computed on ${windowDays} days of overlapping history — under the 1 year needed for stable estimates; treat clusters as indicative`,
    );
  }

  // Pairwise Pearson over the intersection of dates.
  const ids = [...returns.keys()];
  const pairs: CorrelationPair[] = [];
  const th = dec(threshold);
  const edges: Array<[string, string, Dec]> = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const ra = returns.get(ids[i]!)!;
      const rb = returns.get(ids[j]!)!;
      const common: Array<[Dec, Dec]> = [];
      for (const [date, va] of ra) {
        const vb = rb.get(date);
        if (vb !== undefined) common.push([va, vb]);
      }
      if (common.length < MIN_OBSERVATIONS) {
        gaps.push({
          component: 'correlation',
          reason: `pair has only ${common.length} overlapping return days (need ${MIN_OBSERVATIONS})`,
        });
        continue;
      }
      const corr = pearson(common);
      if (corr === null) continue; // zero variance — degenerate, skip honestly
      pairs.push({ a: ids[i]!, b: ids[j]!, correlation: str(corr), observations: common.length });
      if (corr.gte(th)) edges.push([ids[i]!, ids[j]!, corr]);
    }
  }

  // Connected components over threshold edges (union-find).
  const parent = new Map<string, string>(ids.map((id) => [id, id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const [a, b] of edges) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const root = find(id);
    groups.set(root, [...(groups.get(root) ?? []), id]);
  }

  const metaById = new Map(series.map((s) => [s.securityId, s]));
  const clusters: CorrelationCluster[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    let minCorr: Dec | null = null;
    for (const [a, b, c] of edges) {
      if (members.includes(a) && members.includes(b)) {
        if (minCorr === null || c.lt(minCorr)) minCorr = c;
      }
    }
    const weight = members.reduce((acc, id) => acc.plus(metaById.get(id)?.weight ?? '0'), ZERO);
    clusters.push({
      members: members
        .sort()
        .map((id) => ({
          securityId: id,
          label: metaById.get(id)?.label ?? id,
          weight: metaById.get(id)?.weight ?? '0',
        })),
      weight: str(weight),
      minPairCorrelation: str(minCorr ?? ZERO),
    });
  }
  clusters.sort((a, b) => dec(b.weight).cmp(dec(a.weight)));

  return { pairs, clusters, windowDays, warnings, gaps };
}

/** Pearson correlation in decimal arithmetic; null when either variance is 0. */
function pearson(xy: Array<[Dec, Dec]>): Dec | null {
  const n = dec(xy.length);
  let sx = ZERO;
  let sy = ZERO;
  for (const [x, y] of xy) {
    sx = sx.plus(x);
    sy = sy.plus(y);
  }
  const mx = sx.div(n);
  const my = sy.div(n);
  let cov = ZERO;
  let vx = ZERO;
  let vy = ZERO;
  for (const [x, y] of xy) {
    const dx = x.minus(mx);
    const dy = y.minus(my);
    cov = cov.plus(dx.times(dy));
    vx = vx.plus(dx.times(dx));
    vy = vy.plus(dy.times(dy));
  }
  if (vx.isZero() || vy.isZero()) return null;
  return cov.div(vx.sqrt().times(vy.sqrt()));
}
