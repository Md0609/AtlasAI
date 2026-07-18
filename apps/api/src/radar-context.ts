/**
 * Radar evaluation context assembly (Phase 3). One loader, used by the API
 * (baseline evaluation at creation time) and by the radar worker — the two
 * can never disagree about what a condition sees.
 */
import { computePortfolioSignals, type RadarEvalContextFull } from '@atlas/signal-engine';
import { loadConsolidatedInputs, type Db } from './signals.js';

export async function loadRadarContext(
  db: Db,
  userId: string,
  baseCurrency: string,
  securityIds: string[],
): Promise<RadarEvalContextFull> {
  const priceHistory = new Map<string, Array<{ date: string; close: string }>>();
  const epsBySecurity = new Map<string, string>();
  const fundamentals = new Map<string, string>();

  if (securityIds.length > 0) {
    const { rows: bars } = await db.query(
      `SELECT security_id, bar_date::text AS date, adjusted_close::text AS close
         FROM price_bars WHERE security_id = ANY($1)
        ORDER BY security_id, bar_date`,
      [securityIds],
    );
    for (const b of bars) {
      const list = priceHistory.get(b.security_id) ?? [];
      list.push({ date: b.date, close: b.close });
      priceHistory.set(b.security_id, list);
    }
    const { rows: funds } = await db.query(
      `SELECT DISTINCT ON (security_id, metric) security_id, metric, value::text
         FROM fundamentals WHERE security_id = ANY($1)
        ORDER BY security_id, metric, as_of DESC`,
      [securityIds],
    );
    for (const f of funds) {
      fundamentals.set(`${f.security_id}:${f.metric}`, f.value);
      if (f.metric === 'eps_diluted_ttm') epsBySecurity.set(f.security_id, f.value);
    }
  }

  const inputs = await loadConsolidatedInputs(db, userId, baseCurrency);
  let portfolio: RadarEvalContextFull['portfolio'] = null;
  if (inputs.positions.length > 0 || inputs.cash.length > 0) {
    const signals = computePortfolioSignals(inputs, new Date().toISOString());
    portfolio = {
      lookThroughWeights: new Map(
        signals.lookThrough.value
          .filter((r) => r.securityId !== null)
          .map((r) => [r.securityId as string, r.weight]),
      ),
      sectorExposure: new Map(signals.exposure.sector.value.map((s) => [s.key, s.weight])),
      cashWeight: signals.cashWeight,
    };
  }

  const { rows: ruleRows } = await db.query(
    `SELECT DISTINCT ON (rule_id) rule_id, status FROM rule_evaluations
      WHERE user_id = $1 ORDER BY rule_id, evaluated_at DESC`,
    [userId],
  );
  const ruleBreach = new Map<string, boolean>(ruleRows.map((r) => [r.rule_id, r.status === 'breach']));

  return { priceHistory, epsBySecurity, fundamentals, portfolio, ruleBreach };
}

/** Security ids a set of conditions reads — drives the context load. */
export function conditionSecurityIds(asts: Array<{ metric: { kind: string; securityId?: string } }>): string[] {
  const ids = new Set<string>();
  for (const ast of asts) {
    if (ast.metric.securityId) ids.add(ast.metric.securityId);
  }
  return [...ids];
}
