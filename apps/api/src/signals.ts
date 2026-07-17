/**
 * Deterministic analytics endpoints (§31.2): exposure + performance.
 * Every number comes from the Signal Engine (P4); this file only loads
 * inputs, calls the engine, and returns values WITH provenance + staleness
 * (§31.4 discipline applied to deterministic responses; the full intelligence
 * envelope with confidence/guard arrives in Phase 4).
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import {
  ENGINE_VERSION,
  computePortfolioSignals,
  timeWeightedReturn,
  xirr,
  drawdown,
  currencyDecomposition,
  type EngineInputs,
  type ValuePoint,
  type Flow,
  type CashflowPoint,
  type CurrencyBucketInput,
} from '@atlas/signal-engine';
import { Dec, dec, inputHash, str, tradingDaysBetween } from '@atlas/domain';
import { requireUser } from './auth.js';
import { problem } from './http.js';
import { ownedPortfolio } from './portfolios.js';

// ---------------------------------------------------------------------------
// Input loading
// ---------------------------------------------------------------------------

export async function loadEngineInputs(
  pool: pg.Pool,
  portfolio: { id: string; base_currency: string },
): Promise<EngineInputs> {
  const { rows: posRows } = await pool.query(
    `SELECT security_id, quantity::text FROM positions WHERE portfolio_id = $1`,
    [portfolio.id],
  );

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
    : { rows: [] as any[] };

  const { rows: priceRows } = allIds.length
    ? await pool.query(
        `SELECT DISTINCT ON (security_id) security_id, adjusted_close::text, currency, bar_date::text
           FROM price_bars WHERE security_id = ANY($1)
          ORDER BY security_id, bar_date DESC`,
        [allIds],
      )
    : { rows: [] as any[] };

  const { rows: fxRows } = await pool.query(
    `SELECT DISTINCT ON (base_currency, quote_currency)
            base_currency, quote_currency, rate::text, rate_date::text
       FROM fx_rates ORDER BY base_currency, quote_currency, rate_date DESC`,
  );

  const { rows: cashRows } = await pool.query(
    `SELECT currency, amount::text FROM cash_balances WHERE portfolio_id = $1`,
    [portfolio.id],
  );

  return {
    portfolioId: portfolio.id,
    baseCurrency: portfolio.base_currency,
    positions: posRows.map((r) => ({ securityId: r.security_id, quantity: r.quantity })),
    securities: secRows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      isFund: r.is_fund,
      gicsSector: r.gics_sector,
      gicsIndustry: r.gics_industry,
      country: r.country,
      currency: r.currency,
    })),
    prices: priceRows.map((r) => ({
      securityId: r.security_id,
      close: r.adjusted_close,
      currency: r.currency,
      asOf: r.bar_date,
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

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerSignalRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.get('/v1/portfolios/:id/exposure', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const q = req.query as { dimension?: string };
    const dimension = q.dimension ?? 'sector';
    if (!['sector', 'country', 'currency'].includes(dimension)) {
      return problem(reply, req, 400, 'validation', `dimension must be sector|country|currency`);
    }
    const p = await ownedPortfolio(pool, user.id, id);
    if (!p) return problem(reply, req, 404, 'not-found', 'Portfolio not found');

    const inputs = await loadEngineInputs(pool, p);
    const signals = computePortfolioSignals(inputs, new Date().toISOString());
    const slice = signals.exposure[dimension as 'sector' | 'country' | 'currency'];

    return reply.send({
      data: {
        dimension,
        total_value_base: signals.totalValueBase,
        base_currency: signals.baseCurrency,
        slices: slice.value,
        weights: signals.weights.value,
        look_through: signals.lookThrough.value,
        concentration: signals.concentration.value,
        cash_weight: signals.cashWeight,
      },
      provenance: slice.provenance,
      gaps: signals.gaps,
      staleness: {
        prices_as_of: signals.pricesAsOf,
        fx_as_of: signals.fxAsOf,
        holdings_as_of: signals.holdingsAsOf,
      },
      generated_at: new Date().toISOString(),
    });
  });

  app.get('/v1/portfolios/:id/performance', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const q = req.query as { method?: string };
    const method = q.method ?? 'both';
    if (!['twr', 'mwr', 'both'].includes(method)) {
      return problem(reply, req, 400, 'validation', 'method must be twr|mwr|both');
    }
    const p = await ownedPortfolio(pool, user.id, id);
    if (!p) return problem(reply, req, 404, 'not-found', 'Portfolio not found');

    const perf = await computePerformance(pool, p);
    if (!perf) {
      return reply.send({
        data: null,
        gaps: [{ component: 'performance', reason: 'insufficient history: need transactions and at least 2 daily valuations' }],
        staleness: { prices_as_of: null, fx_as_of: null, holdings_as_of: null },
        generated_at: new Date().toISOString(),
      });
    }
    const { result, pricesAsOf, fxAsOf, gaps } = perf;
    const data: Record<string, unknown> = {
      window: result.window,
      currency_decomposition: result.currencyDecomposition,
      series_points: result.seriesPoints,
    };
    if (method !== 'mwr') {
      data.twr = result.twr;
      data.max_drawdown = result.maxDrawdown;
      data.current_drawdown = result.currentDrawdown;
    }
    if (method !== 'twr') data.mwr = result.mwr;

    return reply.send({
      data,
      provenance: {
        engineVersion: result.engineVersion,
        inputHash: result.inputHash,
        methodology: 'performance.v1',
        inputs: { pricesAsOf, fxAsOf, holdingsAsOf: null },
      },
      gaps,
      staleness: { prices_as_of: pricesAsOf, fx_as_of: fxAsOf, holdings_as_of: null },
      generated_at: new Date().toISOString(),
    });
  });
}

// ---------------------------------------------------------------------------
// Performance assembly: daily valuation series from transactions + bars + fx
// ---------------------------------------------------------------------------

interface PerfOut {
  result: {
    twr: string | null;
    mwr: string | null;
    maxDrawdown: string | null;
    currentDrawdown: string | null;
    currencyDecomposition: ReturnType<typeof currencyDecomposition>;
    window: { from: string; to: string };
    seriesPoints: number;
    engineVersion: string;
    inputHash: string;
  };
  pricesAsOf: string | null;
  fxAsOf: string | null;
  gaps: Array<{ component: string; reason: string }>;
}

async function computePerformance(
  pool: pg.Pool,
  portfolio: { id: string; base_currency: string },
): Promise<PerfOut | null> {
  const { rows: txs } = await pool.query(
    `SELECT security_id, tx_type, trade_date::text, quantity::text, amount::text, currency
       FROM transactions WHERE portfolio_id = $1 ORDER BY trade_date, created_at`,
    [portfolio.id],
  );
  if (txs.length === 0) return null;

  const secIds = [...new Set(txs.filter((t) => t.security_id).map((t) => t.security_id as string))];
  const { rows: bars } = secIds.length
    ? await pool.query(
        `SELECT security_id, bar_date::text, adjusted_close::text, currency
           FROM price_bars WHERE security_id = ANY($1) ORDER BY bar_date`,
        [secIds],
      )
    : { rows: [] as any[] };
  const { rows: fxRows } = await pool.query(
    `SELECT base_currency, quote_currency, rate_date::text, rate::text
       FROM fx_rates ORDER BY rate_date`,
  );

  const firstTx = txs[0]!.trade_date as string;
  const lastBar = bars.length ? (bars[bars.length - 1]!.bar_date as string) : firstTx;
  if (lastBar <= firstTx) return null;
  const days = tradingDaysBetween(firstTx, lastBar);
  if (days.length < 2) return null;

  // forward-fillable structures
  const barsBySec = new Map<string, Array<{ d: string; px: string; ccy: string }>>();
  for (const b of bars) {
    const list = barsBySec.get(b.security_id) ?? [];
    list.push({ d: b.bar_date, px: b.adjusted_close, ccy: b.currency });
    barsBySec.set(b.security_id, list);
  }
  const fxByPairDate = new Map<string, Array<{ d: string; rate: string }>>();
  for (const f of fxRows) {
    const key = `${f.base_currency}/${f.quote_currency}`;
    const list = fxByPairDate.get(key) ?? [];
    list.push({ d: f.rate_date, rate: f.rate });
    fxByPairDate.set(key, list);
  }
  const lastAtOrBefore = <T extends { d: string }>(list: T[] | undefined, day: string): T | null => {
    if (!list) return null;
    let found: T | null = null;
    for (const item of list) {
      if (item.d > day) break;
      found = item;
    }
    return found;
  };
  const fxRate = (from: string, to: string, day: string): Dec | null => {
    if (from === to) return dec(1);
    const direct = lastAtOrBefore(fxByPairDate.get(`${from}/${to}`), day);
    if (direct) return dec(direct.rate);
    const inverse = lastAtOrBefore(fxByPairDate.get(`${to}/${from}`), day);
    if (inverse && !dec(inverse.rate).isZero()) return dec(1).div(inverse.rate);
    return null;
  };

  const gaps: Array<{ component: string; reason: string }> = [];
  const gapNoted = new Set<string>();

  // per-day folds
  let fxAsOf: string | null = null;
  for (const f of fxRows) {
    if (!fxAsOf || f.rate_date > fxAsOf) fxAsOf = f.rate_date;
  }
  const txByDate = new Map<string, typeof txs>();
  for (const t of txs) {
    const list = txByDate.get(t.trade_date) ?? [];
    list.push(t);
    txByDate.set(t.trade_date, list);
  }

  const qty = new Map<string, Dec>();
  const cash = new Map<string, Dec>();
  const series: ValuePoint[] = [];
  const flows: Flow[] = [];
  const mwrFlows: CashflowPoint[] = [];
  let pricesAsOf: string | null = null;

  for (const day of days) {
    for (const t of txByDate.get(day) ?? []) {
      const amount = dec(t.amount);
      cash.set(t.currency, (cash.get(t.currency) ?? dec(0)).plus(amount));
      if (t.security_id && ['buy', 'sell', 'split', 'spinoff'].includes(t.tx_type)) {
        const dq =
          t.tx_type === 'sell' ? dec(t.quantity ?? 0).negated() : dec(t.quantity ?? 0);
        qty.set(t.security_id, (qty.get(t.security_id) ?? dec(0)).plus(dq));
      }
      if (t.tx_type === 'deposit' || t.tx_type === 'withdrawal') {
        const rate = fxRate(t.currency, portfolio.base_currency, day);
        if (rate === null) {
          if (!gapNoted.has(`fx-${t.currency}`)) {
            gapNoted.add(`fx-${t.currency}`);
            gaps.push({ component: 'performance', reason: `no FX path ${t.currency}→${portfolio.base_currency}` });
          }
          continue;
        }
        const amtBase = amount.times(rate);
        flows.push({ date: day, amount: str(amtBase) });
        mwrFlows.push({ date: day, amount: str(amtBase.negated()) }); // deposit = investment
      }
    }

    let value = dec(0);
    for (const [sid, q] of qty) {
      if (q.isZero()) continue;
      const bar = lastAtOrBefore(barsBySec.get(sid), day);
      if (!bar) {
        if (!gapNoted.has(`px-${sid}`)) {
          gapNoted.add(`px-${sid}`);
          gaps.push({ component: 'performance', reason: `no price history at window start for a held security` });
        }
        continue;
      }
      const rate = fxRate(bar.ccy, portfolio.base_currency, day);
      if (rate === null) continue;
      value = value.plus(q.times(bar.px).times(rate));
      if (!pricesAsOf || bar.d > pricesAsOf) pricesAsOf = bar.d;
    }
    for (const [ccy, amt] of cash) {
      const rate = fxRate(ccy, portfolio.base_currency, day);
      if (rate === null) continue;
      value = value.plus(amt.times(rate));
    }
    series.push({ date: day, value: str(value) });
  }

  const twr = timeWeightedReturn(series, flows);
  const terminal = dec(series[series.length - 1]!.value);
  const mwrInput: CashflowPoint[] = [...mwrFlows, { date: days[days.length - 1]!, amount: str(terminal) }];
  const mwr = xirr(mwrInput);
  const dd = drawdown(series);

  // FR-3.6 decomposition: pricing-currency buckets, window start vs end.
  const startDay = days[0]!;
  const endDay = days[days.length - 1]!;
  const bucketMap = new Map<string, { start: Dec; end: Dec }>();
  for (const [sid, q] of qty) {
    if (q.isZero()) continue;
    const startBar = lastAtOrBefore(barsBySec.get(sid), startDay) ?? barsBySec.get(sid)?.[0];
    const endBar = lastAtOrBefore(barsBySec.get(sid), endDay);
    if (!startBar || !endBar) continue;
    const b = bucketMap.get(endBar.ccy) ?? { start: dec(0), end: dec(0) };
    b.start = b.start.plus(q.times(startBar.px));
    b.end = b.end.plus(q.times(endBar.px));
    bucketMap.set(endBar.ccy, b);
  }
  const buckets: CurrencyBucketInput[] = [...bucketMap.entries()].map(([ccy, b]) => {
    const isBase = ccy === portfolio.base_currency;
    const fs = isBase ? null : fxRate(ccy, portfolio.base_currency, startDay);
    const fe = isBase ? null : fxRate(ccy, portfolio.base_currency, endDay);
    return {
      currency: ccy,
      startLocalValue: str(b.start),
      endLocalValue: str(b.end),
      fxStart: fs === null ? null : str(fs),
      fxEnd: fe === null ? null : str(fe),
    };
  });

  const hash = inputHash({
    engineVersion: ENGINE_VERSION,
    portfolioId: portfolio.id,
    series,
    flows,
  });

  return {
    result: {
      twr: twr === null ? null : str(twr),
      mwr: mwr === null ? null : str(mwr),
      maxDrawdown: dd ? str(dd.max) : null,
      currentDrawdown: dd ? str(dd.current) : null,
      currencyDecomposition: currencyDecomposition(buckets),
      window: { from: startDay, to: endDay },
      seriesPoints: series.length,
      engineVersion: ENGINE_VERSION,
      inputHash: hash,
    },
    pricesAsOf,
    fxAsOf,
    gaps,
  };
}
