/**
 * Ingest pipeline integration test against a real Postgres (atlas_test).
 * Exercises Design §B1 Phase 1 acceptance ideas:
 *  - entity resolution (ISIN-first; ticker change keeps identity)
 *  - corporate-action split adjustment produces a continuous adjusted series
 *  - injected data defects surface as quality findings, not silent data
 *  - audit log is append-only at the database level
 *  - architecture rule: security-master tables carry no user FKs (§27.2)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate, resetDatabase } from '@atlas/schema';
import {
  CollectingEventSink,
  IngestPipeline,
  MockVendorAdapter,
  SNAPSHOT_FROM,
  SNAPSHOT_TO,
  runQualityChecks,
} from '@atlas/ingest';
import type { QualityReport } from '@atlas/contracts';
import { dec } from '@atlas/domain';

const TEST_URL =
  process.env.ATLAS_TEST_DATABASE_URL ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';

let pool: pg.Pool;
let report: QualityReport;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);
  const sink = new CollectingEventSink();
  const pipeline = new IngestPipeline(pool, new MockVendorAdapter(), sink);
  const stats = await pipeline.run(SNAPSHOT_FROM, SNAPSHOT_TO);
  // Idempotency: a second run must not duplicate anything (upserts + window guards)
  await pipeline.run(SNAPSHOT_FROM, SNAPSHOT_TO);
  report = await runQualityChecks(pool, SNAPSHOT_FROM, SNAPSHOT_TO, stats.resolutionFindings);
  expect(sink.events.some((e) => e.type === 'market.price.eod')).toBe(true);
});

afterAll(async () => {
  await pool.end();
});

const securityIdByTicker = async (ticker: string): Promise<string> => {
  const { rows } = await pool.query(
    `SELECT security_id FROM listings WHERE ticker = $1 ORDER BY valid_from DESC LIMIT 1`,
    [ticker],
  );
  expect(rows.length, `listing for ${ticker}`).toBe(1);
  return rows[0].security_id;
};

describe('entity resolution & corporate actions', () => {
  it('a ticker change keeps one security identity with two listing windows', async () => {
    const { rows } = await pool.query(
      `SELECT l.ticker, l.valid_from::text, l.valid_to::text
         FROM listings l
         JOIN security_identifiers si ON si.security_id = l.security_id
        WHERE si.id_type = 'isin' AND si.value = 'DE000SYN0001'
        ORDER BY l.valid_from`,
    );
    expect(rows.map((r) => r.ticker)).toEqual(['TICK', 'TCKR']);
    expect(rows[0].valid_to).toBe('2026-03-02'); // window closes on the ex-date
    expect(rows[1].valid_to).toBeNull();
    // Both windows point at the same security
    const { rows: secs } = await pool.query(
      `SELECT DISTINCT security_id FROM listings WHERE ticker IN ('TICK','TCKR')`,
    );
    expect(secs.length).toBe(1);
  });

  it('split adjustment: adjusted series is continuous across the NVDA 10:1 split', async () => {
    const nvda = await securityIdByTicker('NVDA');
    const { rows } = await pool.query(
      `SELECT bar_date::text, close::text, adjusted_close::text
         FROM price_bars WHERE security_id = $1 ORDER BY bar_date`,
      [nvda],
    );
    const exDate = '2026-04-15';
    const before = rows.filter((r) => r.bar_date < exDate);
    const onOrAfter = rows.filter((r) => r.bar_date >= exDate);
    expect(before.length).toBeGreaterThan(10);
    expect(onOrAfter.length).toBeGreaterThan(10);

    // Pre-split bars: adjusted = close / 10 (the future split ratio)
    for (const r of before.slice(0, 5)) {
      expect(dec(r.adjusted_close).toFixed(6)).toBe(dec(r.close).div(10).toFixed(6));
    }
    // Post-split bars: adjusted = close (no future splits)
    for (const r of onOrAfter.slice(-5)) {
      expect(dec(r.adjusted_close).toFixed(6)).toBe(dec(r.close).toFixed(6));
    }
    // Continuity: the adjusted return across the ex-date is NOT a −90% cliff
    const lastBefore = before[before.length - 1]!;
    const firstAfter = onOrAfter[0]!;
    const adjReturn = dec(firstAfter.adjusted_close).div(lastBefore.adjusted_close).minus(1).abs();
    expect(adjReturn.lt('0.2'), `adjusted move across split was ${adjReturn.toFixed(4)}`).toBe(true);
    // Raw closes DO cliff — that's the point of adjustment
    const rawReturn = dec(firstAfter.close).div(lastBefore.close).minus(1).abs();
    expect(rawReturn.gt('0.5')).toBe(true);
  });

  it('fund holdings landed with an explicit unknown remainder for IWDA', async () => {
    const iwda = await securityIdByTicker('IWDA');
    const { rows } = await pool.query(
      `SELECT sum(weight)::text AS covered FROM fund_holdings WHERE fund_security_id = $1`,
      [iwda],
    );
    const covered = dec(rows[0].covered);
    expect(covered.lt(1)).toBe(true); // seed coverage is deliberately partial (D-006)
    expect(covered.gt('0.1')).toBe(true);
  });
});

describe('quality checks catch every injected defect', () => {
  const findByKind = (kind: string) => report.findings.filter((f) => f.kind === kind);

  it('SAP −30% single-day move without a corporate action → outlier finding', () => {
    const outliers = findByKind('outlier');
    expect(outliers.some((f) => f.message.includes('2026-05-14'))).toBe(true);
  });

  it('MC missing bars 2026-02-10..12 → completeness finding', () => {
    const completeness = findByKind('completeness');
    expect(completeness.length).toBeGreaterThan(0);
  });

  it('TCKR stops trading after 2026-06-10 → staleness finding', () => {
    const staleness = findByKind('staleness');
    expect(staleness.length).toBeGreaterThan(0);
  });

  it('the NVDA split day is NOT flagged as an outlier (corporate action explains it)', () => {
    const outliers = findByKind('outlier');
    expect(outliers.some((f) => f.message.includes('2026-04-15'))).toBe(false);
  });

  it('holdings coverage below 100% reports as info (unknown slice), not error', () => {
    const holdings = findByKind('holdings_weight_sum');
    expect(holdings.length).toBeGreaterThan(0);
    expect(holdings.every((f) => f.severity !== 'error')).toBe(true);
  });
});

describe('structural rules', () => {
  it('audit_log rejects UPDATE at the database level', async () => {
    await pool.query(
      `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, trace_id, payload)
       VALUES (NULL, 'test.probe', 'test', NULL, 'trace-test', '{}')`,
    );
    await expect(
      pool.query(`UPDATE audit_log SET action = 'tampered' WHERE action = 'test.probe'`),
    ).rejects.toThrow(/append-only/i);
    await expect(
      pool.query(`DELETE FROM audit_log WHERE action = 'test.probe'`),
    ).rejects.toThrow(/append-only/i);
  });

  it('architecture rule §27.2: security-master tables have no FK to users', async () => {
    const { rows } = await pool.query(`
      SELECT tc.table_name, ccu.table_name AS references_table
        FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_name IN ('securities','listings','security_identifiers',
                               'corporate_actions','price_bars','fx_rates',
                               'fundamentals','fund_holdings')
         AND ccu.table_name = 'users'`);
    expect(rows).toEqual([]);
  });
});
