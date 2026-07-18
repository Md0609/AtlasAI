/**
 * Portfolio truth (Design §B1 Phase 1): portfolio/position/transaction CRUD,
 * CSV import with mapping, private assets.
 *
 * Structural rules enforced here:
 *  - §27.3.4: transactions are the source of truth. Positions and cash
 *    balances are a derived fold, recomputed in the SAME database
 *    transaction as every transaction write (§27.4 strong consistency).
 *  - Manual position entry (FR-3.2) is a synthetic buy transaction — there
 *    is no code path that writes positions directly.
 *  - Portfolio cap: 3 at MVP (Design §A5 cut of FR-3.1's ≥5).
 *  - FR-3.10: private assets are opaque line items, stale after 12 months.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { dec, str } from '@atlas/domain';
import { audit, requireUser } from './auth.js';
import { parseCsv, problem } from './http.js';
import { evaluateAndPersistUserRules } from './rules.js';

const MAX_PORTFOLIOS = 3;
const MAX_IMPORT_ROWS = 5000;

const portfolioSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(['taxable', 'tax_advantaged', 'pension', 'other']),
  base_currency: z.string().length(3),
});

const transactionSchema = z.object({
  security_id: z.string().uuid().optional(),
  type: z.enum(['buy', 'sell', 'dividend', 'split', 'spinoff', 'fee', 'fx', 'deposit', 'withdrawal']),
  trade_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  quantity: z.string().optional(),
  price: z.string().optional(),
  amount: z.string().optional(),
  currency: z.string().length(3),
  fee: z.string().optional(),
  note: z.string().max(500).optional(),
});

const positionEntrySchema = z.object({
  security_id: z.string().uuid(),
  quantity: z.string(),
  price: z.string(),
  currency: z.string().length(3),
  trade_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const privateAssetSchema = z.object({
  name: z.string().min(1).max(200),
  asset_class: z.string().min(1).max(60),
  value: z.string(),
  currency: z.string().length(3),
  country: z.string().length(2).optional(),
  liquidity: z.enum(['illiquid', 'semi_liquid']).default('illiquid'),
  valued_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const importSchema = z.object({
  csv: z.string().min(1),
  mapping: z.object({
    ticker: z.string().optional(),
    isin: z.string().optional(),
    date: z.string(),
    type: z.string().optional(),
    quantity: z.string(),
    price: z.string(),
    currency: z.string().optional(),
    fee: z.string().optional(),
  }),
  defaults: z
    .object({
      exchange: z.string().optional(),
      currency: z.string().length(3).optional(),
      type: z.enum(['buy', 'sell']).default('buy'),
      /**
       * When true, every imported buy gets a matching same-day deposit: the
       * cash that funded it lived at the broker, outside this record. Without
       * this, an import-only portfolio fabricates deeply negative cash and
       * every weight (and the Reality Check) is computed against a nonsense
       * denominator. Deposits also give MWR its external flows (US-PF-06).
       */
      assume_funded: z.boolean().default(false),
    })
    .default({}),
});

export async function ownedPortfolio(
  pool: pg.Pool,
  userId: string,
  portfolioId: string,
): Promise<{ id: string; base_currency: string; name: string; type: string } | null> {
  const { rows } = await pool.query(
    `SELECT id, base_currency, name, type FROM portfolios
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [portfolioId, userId],
  );
  return rows[0] ?? null;
}

/**
 * The fold: transactions → positions + cash balances. Runs inside the
 * caller's transaction so a torn write is impossible (§27.4).
 */
export async function recomputeDerivedState(client: pg.PoolClient, portfolioId: string): Promise<void> {
  const { rows: txs } = await client.query(
    `SELECT security_id, tx_type, quantity, price, amount, currency, fee
       FROM transactions WHERE portfolio_id = $1
      ORDER BY trade_date, created_at`,
    [portfolioId],
  );

  const pos = new Map<
    string,
    { qty: ReturnType<typeof dec>; cost: ReturnType<typeof dec>; ccy: string; mixedCcy: boolean }
  >();
  const cash = new Map<string, ReturnType<typeof dec>>();
  const bumpCash = (ccy: string, amt: ReturnType<typeof dec>) =>
    cash.set(ccy, (cash.get(ccy) ?? dec(0)).plus(amt));

  for (const t of txs) {
    const amount = dec(t.amount);
    bumpCash(t.currency, amount);
    if (!t.security_id) continue;
    const p = pos.get(t.security_id) ?? { qty: dec(0), cost: dec(0), ccy: t.currency, mixedCcy: false };
    if (t.tx_type === 'buy') {
      // Buys in different currencies for one security cannot be averaged
      // without an FX conversion we don't have here; a wrong avg_cost is
      // worse than none, so the whole cost basis becomes a declared gap.
      if (t.currency !== p.ccy) p.mixedCcy = true;
      const q = dec(t.quantity ?? 0);
      p.qty = p.qty.plus(q);
      p.cost = p.cost.plus(q.times(t.price ?? 0)).plus(t.fee ?? 0);
    } else if (t.tx_type === 'sell') {
      const q = dec(t.quantity ?? 0);
      const avg = p.qty.isZero() ? dec(0) : p.cost.div(p.qty);
      p.qty = p.qty.minus(q);
      p.cost = p.cost.minus(q.times(avg));
    } else if (t.tx_type === 'split' || t.tx_type === 'spinoff') {
      // quantity carries the share delta (e.g. a 10:1 split on 10 shares → +90)
      p.qty = p.qty.plus(dec(t.quantity ?? 0));
    }
    pos.set(t.security_id, p);
  }

  await client.query('DELETE FROM positions WHERE portfolio_id = $1', [portfolioId]);
  for (const [securityId, p] of pos) {
    if (p.qty.isZero()) continue;
    const avg = !p.mixedCcy && p.qty.gt(0) && p.cost.gt(0) ? p.cost.div(p.qty) : null;
    await client.query(
      `INSERT INTO positions (portfolio_id, security_id, quantity, avg_cost, cost_currency, updated_at)
       VALUES ($1,$2,$3,$4,$5, now())`,
      [portfolioId, securityId, str(p.qty), avg ? str(avg) : null, avg ? p.ccy : null],
    );
  }
  await client.query('DELETE FROM cash_balances WHERE portfolio_id = $1', [portfolioId]);
  for (const [ccy, amount] of cash) {
    if (amount.isZero()) continue;
    await client.query(
      `INSERT INTO cash_balances (portfolio_id, currency, amount, updated_at)
       VALUES ($1,$2,$3, now())`,
      [portfolioId, ccy, str(amount)],
    );
  }
}

/**
 * Sign conventions per transaction type. Getting these wrong silently corrupts
 * cash balances AND the TWR/MWR flows — the behavior-gap number (US-PF-06)
 * would be confidently wrong, which is the one failure mode we cannot have.
 * A withdrawal is cash out (≤0); a deposit is cash in (≥0); fees are ≤0.
 */
const AMOUNT_SIGN: Partial<Record<z.infer<typeof transactionSchema>['type'], 'positive' | 'negative'>> = {
  deposit: 'positive',
  dividend: 'positive',
  sell: 'positive',
  withdrawal: 'negative',
  fee: 'negative',
  buy: 'negative',
};

function assertAmountSign(type: z.infer<typeof transactionSchema>['type'], amount: string): void {
  const expected = AMOUNT_SIGN[type];
  if (!expected) return;
  const a = dec(amount);
  if (expected === 'positive' && a.isNegative()) {
    throw Object.assign(
      new Error(`${type} amount must be positive (cash in); got ${amount}`),
      { statusCode: 400 },
    );
  }
  if (expected === 'negative' && a.gt(0)) {
    throw Object.assign(
      new Error(`${type} amount must be negative (cash out); got ${amount}`),
      { statusCode: 400 },
    );
  }
}

function txAmount(input: z.infer<typeof transactionSchema>): string | null {
  if (input.amount !== undefined) {
    assertAmountSign(input.type, input.amount);
    return input.amount;
  }
  const fee = dec(input.fee ?? 0);
  if (input.type === 'buy' && input.quantity && input.price) {
    return str(dec(input.quantity).times(input.price).plus(fee).negated());
  }
  if (input.type === 'sell' && input.quantity && input.price) {
    return str(dec(input.quantity).times(input.price).minus(fee));
  }
  if (input.type === 'split' || input.type === 'spinoff') return '0';
  return null;
}

async function insertTransaction(
  client: pg.PoolClient,
  portfolioId: string,
  input: z.infer<typeof transactionSchema>,
): Promise<string> {
  const amount = txAmount(input);
  if (amount === null) {
    throw Object.assign(new Error('amount is required for this transaction type'), { statusCode: 400 });
  }
  const { rows } = await client.query(
    `INSERT INTO transactions (portfolio_id, security_id, tx_type, trade_date, quantity, price, amount, currency, fee, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      portfolioId,
      input.security_id ?? null,
      input.type,
      input.trade_date,
      input.quantity ?? null,
      input.price ?? null,
      amount,
      input.currency.toUpperCase(),
      input.fee ?? '0',
      input.note ?? null,
    ],
  );
  await recomputeDerivedState(client, portfolioId);
  return rows[0].id as string;
}

export function registerPortfolioRoutes(app: FastifyInstance, pool: pg.Pool): void {
  // -- Portfolios -----------------------------------------------------------
  app.get('/v1/portfolios', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { rows } = await pool.query(
      `SELECT id, name, type, base_currency, created_at FROM portfolios
        WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
      [user.id],
    );
    return reply.send({ data: rows });
  });

  app.post('/v1/portfolios', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const parsed = portfolioSchema.safeParse(req.body);
    if (!parsed.success) {
      return problem(reply, req, 400, 'validation', 'Invalid portfolio payload', parsed.error.issues[0]?.message);
    }
    const { rows: countRows } = await pool.query(
      'SELECT count(*)::int AS n FROM portfolios WHERE user_id = $1 AND deleted_at IS NULL',
      [user.id],
    );
    if (countRows[0].n >= MAX_PORTFOLIOS) {
      return problem(
        reply,
        req,
        409,
        'portfolio-limit',
        `MVP supports up to ${MAX_PORTFOLIOS} portfolios`,
        'The limit rises after MVP (Design §A5).',
      );
    }
    const { rows } = await pool.query(
      `INSERT INTO portfolios (user_id, name, type, base_currency)
       VALUES ($1,$2,$3,$4) RETURNING id, name, type, base_currency, created_at`,
      [user.id, parsed.data.name, parsed.data.type, parsed.data.base_currency.toUpperCase()],
    );
    await audit(pool, user.id, 'portfolio.create', 'portfolio', rows[0].id, req.traceId, parsed.data);
    return reply.status(201).send(rows[0]);
  });

  app.get('/v1/portfolios/:id', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const p = await ownedPortfolio(pool, user.id, id);
    if (!p) return problem(reply, req, 404, 'not-found', 'Portfolio not found');
    return reply.send(p);
  });

  app.patch('/v1/portfolios/:id', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const p = await ownedPortfolio(pool, user.id, id);
    if (!p) return problem(reply, req, 404, 'not-found', 'Portfolio not found');
    const parsed = portfolioSchema.partial().safeParse(req.body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      return problem(reply, req, 400, 'validation', 'Nothing valid to update');
    }
    const fields = parsed.data;
    const { rows } = await pool.query(
      `UPDATE portfolios SET
         name = COALESCE($3, name),
         type = COALESCE($4, type),
         base_currency = COALESCE($5, base_currency)
       WHERE id = $1 AND user_id = $2
       RETURNING id, name, type, base_currency`,
      [id, user.id, fields.name ?? null, fields.type ?? null, fields.base_currency?.toUpperCase() ?? null],
    );
    await audit(pool, user.id, 'portfolio.update', 'portfolio', id, req.traceId, fields);
    return reply.send(rows[0]);
  });

  app.delete('/v1/portfolios/:id', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const p = await ownedPortfolio(pool, user.id, id);
    if (!p) return problem(reply, req, 404, 'not-found', 'Portfolio not found');
    await pool.query('UPDATE portfolios SET deleted_at = now() WHERE id = $1', [id]);
    await audit(pool, user.id, 'portfolio.delete', 'portfolio', id, req.traceId);
    return reply.status(204).send();
  });

  // -- Positions (read = derived state; write = synthetic buy) --------------
  app.get('/v1/portfolios/:id/positions', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const p = await ownedPortfolio(pool, user.id, id);
    if (!p) return problem(reply, req, 404, 'not-found', 'Portfolio not found');
    const { rows } = await pool.query(
      `SELECT pos.security_id, s.name, s.type, s.currency AS pricing_currency,
              pos.quantity::text, pos.avg_cost::text, pos.cost_currency
         FROM positions pos JOIN securities s ON s.id = pos.security_id
        WHERE pos.portfolio_id = $1 ORDER BY s.name`,
      [id],
    );
    const { rows: cashRows } = await pool.query(
      `SELECT currency, amount::text FROM cash_balances WHERE portfolio_id = $1 ORDER BY currency`,
      [id],
    );
    return reply.send({ data: { positions: rows, cash: cashRows } });
  });

  app.post('/v1/portfolios/:id/positions', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const p = await ownedPortfolio(pool, user.id, id);
    if (!p) return problem(reply, req, 404, 'not-found', 'Portfolio not found');
    const parsed = positionEntrySchema.safeParse(req.body);
    if (!parsed.success) {
      return problem(reply, req, 400, 'validation', 'Invalid position payload', parsed.error.issues[0]?.message);
    }
    // FR-3.2 manual entry → synthetic buy transaction; transactions stay the
    // single source of truth (§27.3.4).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const txId = await insertTransaction(client, id, {
        security_id: parsed.data.security_id,
        type: 'buy',
        trade_date: parsed.data.trade_date,
        quantity: parsed.data.quantity,
        price: parsed.data.price,
        currency: parsed.data.currency,
      });
      // §27.4: rule evaluation ↔ portfolio change is strong consistency.
      await evaluateAndPersistUserRules(client, user.id, user.baseCurrency);
      await audit(client, user.id, 'position.manual_entry', 'transaction', txId, req.traceId, parsed.data);
      await client.query('COMMIT');
      return reply.status(201).send({ transaction_id: txId });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // -- Transactions ---------------------------------------------------------
  app.get('/v1/portfolios/:id/transactions', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const p = await ownedPortfolio(pool, user.id, id);
    if (!p) return problem(reply, req, 404, 'not-found', 'Portfolio not found');
    const { rows } = await pool.query(
      `SELECT t.id, t.security_id, s.name AS security_name, t.tx_type, t.trade_date::text,
              t.quantity::text, t.price::text, t.amount::text, t.currency, t.fee::text, t.note
         FROM transactions t LEFT JOIN securities s ON s.id = t.security_id
        WHERE t.portfolio_id = $1 ORDER BY t.trade_date DESC, t.created_at DESC`,
      [id],
    );
    return reply.send({ data: rows });
  });

  app.post('/v1/portfolios/:id/transactions', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const p = await ownedPortfolio(pool, user.id, id);
    if (!p) return problem(reply, req, 404, 'not-found', 'Portfolio not found');
    const parsed = transactionSchema.safeParse(req.body);
    if (!parsed.success) {
      return problem(reply, req, 400, 'validation', 'Invalid transaction payload', parsed.error.issues[0]?.message);
    }
    if (parsed.data.security_id) {
      const s = await pool.query('SELECT 1 FROM securities WHERE id = $1', [parsed.data.security_id]);
      if (s.rows.length === 0) return problem(reply, req, 404, 'not-found', 'Security not found');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const txId = await insertTransaction(client, id, parsed.data);
      // §27.4: rule evaluation ↔ portfolio change is strong consistency.
      await evaluateAndPersistUserRules(client, user.id, user.baseCurrency);
      await audit(client, user.id, 'transaction.create', 'transaction', txId, req.traceId, {
        type: parsed.data.type,
        trade_date: parsed.data.trade_date,
      });
      await client.query('COMMIT');
      return reply.status(201).send({ id: txId });
    } catch (err) {
      await client.query('ROLLBACK');
      if ((err as { statusCode?: number }).statusCode === 400) {
        return problem(reply, req, 400, 'validation', (err as Error).message);
      }
      throw err;
    } finally {
      client.release();
    }
  });

  // -- CSV import with mapping (FR-3.2) -------------------------------------
  // Body is JSON { csv, mapping, defaults } rather than §31.2's multipart:
  // documented deviation in ADR-000 (multipart + screenshot lane arrive with
  // the full import pipeline; the mapping semantics are identical).
  app.post('/v1/portfolios/:id/import', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const p = await ownedPortfolio(pool, user.id, id);
    if (!p) return problem(reply, req, 404, 'not-found', 'Portfolio not found');
    const parsed = importSchema.safeParse(req.body);
    if (!parsed.success) {
      return problem(reply, req, 400, 'validation', 'Invalid import payload', parsed.error.issues[0]?.message);
    }
    const { csv, mapping, defaults } = parsed.data;
    const rows = parseCsv(csv);
    if (rows.length < 2) {
      return problem(reply, req, 400, 'validation', 'CSV needs a header row and at least one data row');
    }
    if (rows.length > MAX_IMPORT_ROWS + 1) {
      return problem(
        reply,
        req,
        400,
        'validation',
        `CSV import is capped at ${MAX_IMPORT_ROWS} rows per request`,
        'Split the file and import in batches.',
      );
    }
    const header = rows[0]!.map((h) => h.trim());
    const col = (name?: string) => (name ? header.indexOf(name) : -1);
    const cols = {
      ticker: col(mapping.ticker),
      isin: col(mapping.isin),
      date: col(mapping.date),
      type: col(mapping.type),
      quantity: col(mapping.quantity),
      price: col(mapping.price),
      currency: col(mapping.currency),
      fee: col(mapping.fee),
    };
    if (cols.date < 0 || cols.quantity < 0 || cols.price < 0 || (cols.ticker < 0 && cols.isin < 0)) {
      return problem(reply, req, 400, 'validation', 'Mapping must cover date, quantity, price and ticker or isin');
    }

    const skipped: Array<{ line: number; reason: string }> = [];
    let imported = 0;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 1; i < rows.length; i++) {
        const line = rows[i]!;
        const get = (idx: number) => (idx >= 0 ? (line[idx] ?? '').trim() : '');
        const tradeDate = get(cols.date);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
          skipped.push({ line: i + 1, reason: `unparseable date "${tradeDate}" (expected YYYY-MM-DD)` });
          continue;
        }
        // Entity resolution, import edition: ISIN first, then ticker valid at
        // the trade date (a listing window lookup — old tickers still resolve
        // after a ticker change).
        let securityId: string | null = null;
        const isin = get(cols.isin);
        if (isin) {
          const r = await client.query(
            `SELECT security_id FROM security_identifiers
              WHERE id_type = 'isin' AND value = $1 AND valid_to IS NULL`,
            [isin],
          );
          securityId = r.rows[0]?.security_id ?? null;
        }
        const ticker = get(cols.ticker);
        if (!securityId && ticker) {
          const params: unknown[] = [ticker, tradeDate];
          let sql = `SELECT security_id FROM listings
                      WHERE ticker = $1 AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2)`;
          if (defaults.exchange) {
            sql += ' AND exchange = $3';
            params.push(defaults.exchange);
          }
          const r = await client.query(sql, params);
          if (r.rows.length === 1) securityId = r.rows[0].security_id;
          else if (r.rows.length > 1) {
            skipped.push({ line: i + 1, reason: `ticker "${ticker}" is ambiguous across exchanges; set defaults.exchange` });
            continue;
          }
        }
        if (!securityId) {
          skipped.push({ line: i + 1, reason: `could not resolve security (ticker="${ticker}" isin="${isin}")` });
          continue;
        }
        const rawType = (get(cols.type) || defaults.type).toLowerCase();
        if (rawType !== 'buy' && rawType !== 'sell') {
          skipped.push({ line: i + 1, reason: `unsupported type "${rawType}" (buy/sell at Phase 1)` });
          continue;
        }
        const quantity = get(cols.quantity);
        const price = get(cols.price);
        if (!/^-?\d+(\.\d+)?$/.test(quantity) || !/^-?\d+(\.\d+)?$/.test(price)) {
          skipped.push({ line: i + 1, reason: 'quantity/price not numeric' });
          continue;
        }
        const currency = (get(cols.currency) || defaults.currency || p.base_currency).toUpperCase();
        const fee = get(cols.fee) || '0';
        if (defaults.assume_funded && rawType === 'buy') {
          await insertTransaction(client, id, {
            type: 'deposit',
            trade_date: tradeDate,
            amount: str(dec(quantity).times(price).plus(fee)),
            currency,
            note: 'auto: funding for imported buy',
          });
        }
        await insertTransaction(client, id, {
          security_id: securityId,
          type: rawType,
          trade_date: tradeDate,
          quantity,
          price,
          currency,
          fee,
        });
        imported += 1;
      }
      // One evaluation for the whole import, same transaction (§27.4).
      if (imported > 0) await evaluateAndPersistUserRules(client, user.id, user.baseCurrency);
      await audit(client, user.id, 'portfolio.import_csv', 'portfolio', id, req.traceId, {
        imported,
        skipped: skipped.length,
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return reply.send({ imported, skipped });
  });

  // -- Private assets (FR-3.10) ---------------------------------------------
  app.get('/v1/portfolios/:id/private-assets', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const p = await ownedPortfolio(pool, user.id, id);
    if (!p) return problem(reply, req, 404, 'not-found', 'Portfolio not found');
    const { rows } = await pool.query(
      `SELECT id, name, asset_class, value::text, currency, country, liquidity,
              valued_at::text,
              (valued_at < now()::date - interval '12 months') AS stale
         FROM private_assets
        WHERE portfolio_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
      [id],
    );
    return reply.send({ data: rows });
  });

  app.post('/v1/portfolios/:id/private-assets', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const p = await ownedPortfolio(pool, user.id, id);
    if (!p) return problem(reply, req, 404, 'not-found', 'Portfolio not found');
    const parsed = privateAssetSchema.safeParse(req.body);
    if (!parsed.success) {
      return problem(reply, req, 400, 'validation', 'Invalid private asset payload', parsed.error.issues[0]?.message);
    }
    const d = parsed.data;
    const { rows } = await pool.query(
      `INSERT INTO private_assets (portfolio_id, name, asset_class, value, currency, country, liquidity, valued_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, name, asset_class, value::text, currency, liquidity, valued_at::text`,
      [id, d.name, d.asset_class, d.value, d.currency.toUpperCase(), d.country ?? null, d.liquidity, d.valued_at],
    );
    await audit(pool, user.id, 'private_asset.create', 'private_asset', rows[0].id, req.traceId);
    return reply.status(201).send(rows[0]);
  });

  // -- Securities lookup (manual entry + import UI) -------------------------
  app.get('/v1/securities', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { query } = req.query as { query?: string };
    if (!query || query.trim().length < 1) return reply.send({ data: [] });
    const { rows } = await pool.query(
      `SELECT DISTINCT s.id, s.name, s.type, s.currency, l.ticker, l.exchange
         FROM securities s
         JOIN listings l ON l.security_id = s.id AND l.valid_to IS NULL
        WHERE s.name ILIKE '%' || $1 || '%' OR l.ticker ILIKE $1 || '%'
        ORDER BY s.name LIMIT 20`,
      [query.trim()],
    );
    return reply.send({ data: rows });
  });
}
