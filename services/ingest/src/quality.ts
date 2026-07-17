/**
 * Data-quality checks (Design §B1 Phase 1: "data-quality checks
 * (completeness, staleness, outliers) + quality dashboard in ops/").
 *
 * Runs post-ingest against the canonical tables, never against vendor
 * payloads — the quality contract is on what the product will actually read.
 */
import type pg from 'pg';
import type { QualityFinding, QualityReport } from '@atlas/contracts';
import { tradingDaysBetween } from '@atlas/domain';

const OUTLIER_ABS_RETURN = 0.25; // |daily move| beyond this without a corporate action → error
const STALENESS_WARN_DAYS = 5; // trading-data gap at window end

export async function runQualityChecks(
  pool: pg.Pool,
  windowFrom: string,
  windowTo: string,
  extraFindings: QualityFinding[] = [],
): Promise<QualityReport> {
  const findings: QualityFinding[] = [...extraFindings];

  const { rows: universe } = await pool.query(
    `SELECT s.id, s.name, s.type FROM securities s ORDER BY s.name`,
  );
  const { rows: barCountRows } = await pool.query(
    `SELECT count(*)::int AS n FROM price_bars WHERE bar_date BETWEEN $1 AND $2`,
    [windowFrom, windowTo],
  );

  const expectedDays = tradingDaysBetween(windowFrom, windowTo);

  // --- Completeness + staleness per security -------------------------------
  const { rows: perSec } = await pool.query(
    `SELECT s.id, s.name,
            count(pb.bar_date)::int AS bars,
            max(pb.bar_date)::text AS last_bar
       FROM securities s
       LEFT JOIN price_bars pb
         ON pb.security_id = s.id AND pb.bar_date BETWEEN $1 AND $2
      WHERE s.type <> 'cash'
      GROUP BY s.id, s.name`,
    [windowFrom, windowTo],
  );

  for (const row of perSec) {
    const missing = expectedDays.length - (row.bars as number);
    if ((row.bars as number) === 0) {
      findings.push({
        kind: 'completeness',
        severity: 'error',
        securityId: row.id,
        message: `${row.name}: no price bars in window`,
      });
      continue;
    }
    if (missing > 0) {
      findings.push({
        kind: 'completeness',
        severity: missing > 10 ? 'error' : 'warn',
        securityId: row.id,
        message: `${row.name}: ${missing} missing trading day(s) in window`,
        details: { missing, expected: expectedDays.length, actual: row.bars },
      });
    }
    if (row.last_bar) {
      const staleDays = tradingDaysBetween(row.last_bar as string, windowTo).length - 1;
      if (staleDays > STALENESS_WARN_DAYS) {
        findings.push({
          kind: 'staleness',
          severity: staleDays > 10 ? 'error' : 'warn',
          securityId: row.id,
          message: `${row.name}: last bar ${row.last_bar}, ${staleDays} trading day(s) stale at window end`,
          details: { lastBar: row.last_bar, staleDays },
        });
      }
    }
  }

  // --- Outliers: big adjusted moves with no corporate action that day ------
  const { rows: outliers } = await pool.query(
    `WITH ret AS (
       SELECT pb.security_id, pb.bar_date,
              pb.adjusted_close / lag(pb.adjusted_close) OVER (PARTITION BY pb.security_id ORDER BY pb.bar_date) - 1 AS r
         FROM price_bars pb
        WHERE pb.bar_date BETWEEN $1 AND $2
     )
     SELECT ret.security_id, s.name, ret.bar_date::text AS bar_date, ret.r::float8 AS r
       FROM ret
       JOIN securities s ON s.id = ret.security_id
      WHERE abs(ret.r) > $3
        AND NOT EXISTS (
          SELECT 1 FROM corporate_actions ca
           WHERE ca.security_id = ret.security_id AND ca.ex_date = ret.bar_date
        )
      ORDER BY ret.bar_date`,
    [windowFrom, windowTo, OUTLIER_ABS_RETURN],
  );
  for (const o of outliers) {
    findings.push({
      kind: 'outlier',
      severity: 'error',
      securityId: o.security_id,
      message: `${o.name}: ${(Number(o.r) * 100).toFixed(1)}% adjusted move on ${o.bar_date} with no corporate action on file`,
      details: { date: o.bar_date, return: o.r },
    });
  }

  // --- Fund holdings weight sums ------------------------------------------
  const { rows: sums } = await pool.query(
    `SELECT fh.fund_security_id, s.name, fh.as_of::text AS as_of, sum(fh.weight)::float8 AS total
       FROM fund_holdings fh
       JOIN securities s ON s.id = fh.fund_security_id
      GROUP BY fh.fund_security_id, s.name, fh.as_of`,
  );
  for (const row of sums) {
    const total = Number(row.total);
    if (total > 1.005) {
      findings.push({
        kind: 'holdings_weight_sum',
        severity: 'error',
        securityId: row.fund_security_id,
        message: `${row.name}: holdings sum to ${(total * 100).toFixed(2)}% (> 100%) as of ${row.as_of}`,
        details: { total },
      });
    } else {
      findings.push({
        kind: 'holdings_weight_sum',
        severity: 'info',
        securityId: row.fund_security_id,
        message: `${row.name}: known holdings cover ${(total * 100).toFixed(2)}%; remainder renders as the explicit unknown slice (D-006)`,
        details: { total, unknown: 1 - total },
      });
    }
  }

  const summary: QualityReport['summary'] = {
    completeness: { warn: 0, error: 0 },
    staleness: { warn: 0, error: 0 },
    outlier: { warn: 0, error: 0 },
    holdings_weight_sum: { warn: 0, error: 0 },
    identifier_conflict: { warn: 0, error: 0 },
  };
  for (const f of findings) {
    if (f.severity === 'warn') summary[f.kind].warn += 1;
    if (f.severity === 'error') summary[f.kind].error += 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    universeSize: universe.length,
    barsIngested: barCountRows[0].n as number,
    findings,
    summary,
  };
}
