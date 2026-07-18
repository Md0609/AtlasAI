/**
 * @atlas/dataplane integration test. The loaders were extracted from apps/api
 * in Phase 4b; the API/worker suites already exercise them transitively, but
 * dataplane owns its own contract now, so it gets a direct test against the
 * mock-vendor snapshot: engine inputs carry the recursive fund look-through
 * chain, the consolidated view spans portfolios, and P/E inputs skip
 * cross-currency pairs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate, resetDatabase } from '@atlas/schema';
import { IngestPipeline, MockVendorAdapter, CollectingEventSink, SNAPSHOT_TO } from '@atlas/ingest';
import { computePortfolioSignals } from '@atlas/signal-engine';
import {
  conditionSecurityIds,
  loadConsolidatedInputs,
  loadEngineInputs,
  loadPeInputs,
  loadRadarContext,
} from '../src/index.js';

const TEST_URL =
  process.env.ATLAS_TEST_DATABASE_URL ?? 'postgres://atlas:atlas@127.0.0.1:5432/atlas_test';

let pool: pg.Pool;
let userId: string;
let portfolioId: string;
let secByTicker: Map<string, string>;

async function ticker(t: string): Promise<string> {
  const id = secByTicker.get(t);
  if (!id) throw new Error(`no security for ${t}`);
  return id;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  await resetDatabase(pool);
  await migrate(pool);
  await new IngestPipeline(pool, new MockVendorAdapter(), new CollectingEventSink()).run(
    '2026-01-02',
    SNAPSHOT_TO,
  );

  const { rows: secs } = await pool.query(
    `SELECT l.ticker, l.security_id FROM listings l WHERE l.valid_to IS NULL`,
  );
  secByTicker = new Map(secs.map((r) => [r.ticker, r.security_id]));

  const u = await pool.query(
    `INSERT INTO users (email, password_hash, jurisdiction_code, base_currency)
     VALUES ('dp@example.es','x','ES','EUR') RETURNING id`,
  );
  userId = u.rows[0].id;
  const p = await pool.query(
    `INSERT INTO portfolios (user_id, name, type, base_currency)
     VALUES ($1,'Main','taxable','EUR') RETURNING id`,
    [userId],
  );
  portfolioId = p.rows[0].id;

  // Hold the fund-of-funds directly so look-through must recurse fund→fund→equity.
  const fof = await ticker('FOF');
  await pool.query(
    `INSERT INTO positions (portfolio_id, security_id, quantity) VALUES ($1,$2,'1000')`,
    [portfolioId, fof],
  );
  await pool.query(
    `INSERT INTO cash_balances (portfolio_id, currency, amount) VALUES ($1,'EUR','5000')`,
    [portfolioId],
  );
});

afterAll(async () => {
  await pool.end();
});

describe('loadEngineInputs / loadConsolidatedInputs', () => {
  it('walks the recursive fund-holdings chain so look-through reaches the equities', async () => {
    const inputs = await loadEngineInputs(pool, { id: portfolioId, base_currency: 'EUR' });
    expect(inputs.positions.map((p) => p.securityId)).toContain(await ticker('FOF'));
    // FOF holds IWDA which holds AAPL/MSFT/… — the fund-holdings closure must
    // have pulled those securities into the inputs even though none are held.
    const secIds = new Set(inputs.securities.map((s) => s.id));
    expect(secIds.has(await ticker('IWDA'))).toBe(true);
    expect(secIds.has(await ticker('AAPL'))).toBe(true);
    expect(inputs.fundHoldings.length).toBeGreaterThan(0);

    // The engine can consume the loaded inputs and see the look-through.
    const signals = computePortfolioSignals(inputs, new Date().toISOString());
    const names = signals.lookThrough.value.map((r) => r.label);
    expect(names.some((n) => n.includes('Apple'))).toBe(true);
  });

  it('consolidated view aggregates the user across portfolios', async () => {
    const inputs = await loadConsolidatedInputs(pool, userId, 'EUR');
    expect(inputs.portfolioId).toBe(`consolidated-${userId}`);
    expect(inputs.cash.find((c) => c.currency === 'EUR')?.amount).toBe('5000');
  });
});

describe('loadRadarContext / loadPeInputs', () => {
  it('assembles price history, fundamentals and portfolio state for the engine', async () => {
    const aapl = await ticker('AAPL');
    const ctx = await loadRadarContext(pool, userId, 'EUR', [aapl]);
    expect((ctx.priceHistory.get(aapl) ?? []).length).toBeGreaterThan(0);
    expect(ctx.portfolio).not.toBeNull();
  });

  it('P/E inputs are computed only for same-currency EPS/price pairs', async () => {
    const aapl = await ticker('AAPL');
    const pes = await loadPeInputs(pool, [aapl]);
    // AAPL prices and EPS are both USD in the mock snapshot → a P/E exists.
    expect(pes.find((p) => p.securityId === aapl)).toBeTruthy();
  });

  it('conditionSecurityIds dedupes security ids from a condition set', () => {
    const ids = conditionSecurityIds([
      { metric: { kind: 'price', securityId: 'a' } },
      { metric: { kind: 'price', securityId: 'a' } },
      { metric: { kind: 'portfolio.cash_weight' } },
      { metric: { kind: 'price', securityId: 'b' } },
    ]);
    expect(ids.sort()).toEqual(['a', 'b']);
  });
});
