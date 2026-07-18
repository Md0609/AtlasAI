/**
 * @atlas/dataplane — the single owner of how engine inputs and agent context
 * are assembled from Postgres (Phase 4b extraction of the Phase 1–3 loaders).
 *
 * Why this is its own package: the API, the workers, AND the intelligence
 * plane (agents, Copilot) all need to load the same portfolio/context from
 * the DB. Before Phase 4b the loaders lived in apps/api and workers imported
 * them via @atlas/api/internal; that would create a cycle once the API calls
 * the agent runtime (api → agents → loaders → api). Pulling the pure,
 * fastify-free read path down here breaks the cycle: everyone imports
 * dataplane; dataplane imports no one above the engine.
 *
 * Everything here is a pure DB read → typed data. No writes, no HTTP, no
 * queue. A brief, a Copilot answer and an API response can never disagree
 * about what the portfolio looks like because they all come through here.
 */
import type pg from 'pg';
import type { EngineInputs } from '@atlas/signal-engine';

/** Anything with .query — a Pool, or a PoolClient inside a transaction (§27.4). */
export type Db = pg.Pool | pg.PoolClient;

export async function loadEngineInputs(
  pool: Db,
  portfolio: { id: string; base_currency: string },
): Promise<EngineInputs> {
  const { rows: posRows } = await pool.query(
    `SELECT security_id, quantity::text FROM positions WHERE portfolio_id = $1`,
    [portfolio.id],
  );
  const { rows: cashRows } = await pool.query(
    `SELECT currency, amount::text FROM cash_balances WHERE portfolio_id = $1`,
    [portfolio.id],
  );
  return enrichInputs(pool, portfolio.id, portfolio.base_currency, posRows, cashRows);
}

/**
 * Consolidated view across all of a user's live portfolios (§14.2: the
 * consolidated view is the default; rules are declared by the USER and
 * evaluated against everything they own).
 */
export async function loadConsolidatedInputs(
  db: Db,
  userId: string,
  baseCurrency: string,
): Promise<EngineInputs> {
  const { rows: posRows } = await db.query(
    `SELECT pos.security_id, sum(pos.quantity)::text AS quantity
       FROM positions pos JOIN portfolios p ON p.id = pos.portfolio_id
      WHERE p.user_id = $1 AND p.deleted_at IS NULL
      GROUP BY pos.security_id`,
    [userId],
  );
  const { rows: cashRows } = await db.query(
    `SELECT cb.currency, sum(cb.amount)::text AS amount
       FROM cash_balances cb JOIN portfolios p ON p.id = cb.portfolio_id
      WHERE p.user_id = $1 AND p.deleted_at IS NULL
      GROUP BY cb.currency`,
    [userId],
  );
  return enrichInputs(db, `consolidated-${userId}`, baseCurrency, posRows, cashRows);
}

async function enrichInputs(
  pool: Db,
  portfolioId: string,
  baseCurrency: string,
  posRows: Array<{ security_id: string; quantity: string }>,
  cashRows: Array<{ currency: string; amount: string }>,
): Promise<EngineInputs> {
  // Closure over fund holdings so recursive look-through has full metadata.
  const ids = new Set<string>(posRows.map((r) => r.security_id as string));
  const holdings: EngineInputs['fundHoldings'] = [];
  let frontier = [...ids];
  for (let depth = 0; depth < 6 && frontier.length > 0; depth++) {
    const { rows } = await pool.query(
      `SELECT fh.fund_security_id, fh.holding_security_id, fh.weight::text, fh.as_of::text
         FROM fund_holdings fh
        WHERE fh.fund_security_id = ANY($1)
          AND fh.as_of = (SELECT max(as_of) FROM fund_holdings x
                           WHERE x.fund_security_id = fh.fund_security_id)`,
      [frontier],
    );
    const next: string[] = [];
    for (const r of rows) {
      holdings.push({
        fundSecurityId: r.fund_security_id,
        holdingSecurityId: r.holding_security_id,
        weight: r.weight,
        asOf: r.as_of,
      });
      if (!ids.has(r.holding_security_id)) {
        ids.add(r.holding_security_id);
        next.push(r.holding_security_id);
      }
    }
    frontier = next;
  }

  const allIds = [...ids];
  const { rows: secRows } = allIds.length
    ? await pool.query(
        `SELECT id, name, type, is_fund, gics_sector, gics_industry, country, currency
           FROM securities WHERE id = ANY($1)`,
        [allIds],
      )
    : { rows: [] as Array<Record<string, unknown>> };

  const { rows: priceRows } = allIds.length
    ? await pool.query(
        `SELECT DISTINCT ON (security_id) security_id, adjusted_close::text, currency, bar_date::text
           FROM price_bars WHERE security_id = ANY($1)
          ORDER BY security_id, bar_date DESC`,
        [allIds],
      )
    : { rows: [] as Array<Record<string, unknown>> };

  const { rows: fxRows } = await pool.query(
    `SELECT DISTINCT ON (base_currency, quote_currency)
            base_currency, quote_currency, rate::text, rate_date::text
       FROM fx_rates ORDER BY base_currency, quote_currency, rate_date DESC`,
  );

  return {
    portfolioId,
    baseCurrency,
    positions: posRows.map((r) => ({ securityId: r.security_id, quantity: r.quantity })),
    securities: secRows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      type: r.type as EngineInputs['securities'][number]['type'],
      isFund: r.is_fund as boolean,
      gicsSector: (r.gics_sector as string | null) ?? null,
      gicsIndustry: (r.gics_industry as string | null) ?? null,
      country: (r.country as string | null) ?? null,
      currency: r.currency as string,
    })),
    prices: priceRows.map((r) => ({
      securityId: r.security_id as string,
      close: r.adjusted_close as string,
      currency: r.currency as string,
      asOf: r.bar_date as string,
    })),
    fx: fxRows.map((r) => ({
      base: r.base_currency,
      quote: r.quote_currency,
      rate: r.rate,
      asOf: r.rate_date,
    })),
    fundHoldings: holdings,
    cash: cashRows.map((r) => ({ currency: r.currency, amount: r.amount })),
  };
}
