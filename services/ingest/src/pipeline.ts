/**
 * Ingestion pipeline: vendor records → canonical rows.
 *
 *  - Entity resolution (Design §B1 Phase 1): ISIN first, then live
 *    (exchange, ticker) listing, else create. Conflicts are surfaced as
 *    quality findings, never silently merged. Target accuracy >99.5% (§9.3).
 *  - Idempotent upserts throughout (§24.3 at-least-once ⇒ consumers dedupe).
 *  - Split adjustment: `adjusted_close = close / Π(future split ratios)`,
 *    recomputed deterministically after every corporate-action ingest.
 *  - Emits typed domain events (§24.2) to an EventSink; the queue consumer
 *    arrives in Phase 3 — Phase 1 uses a collecting sink.
 */
import type pg from 'pg';
import type {
  DomainEvent,
  QualityFinding,
  VendorBar,
  VendorCorporateAction,
  VendorFundHolding,
  VendorFundamental,
  VendorFxRate,
  VendorSecurity,
} from '@atlas/contracts';
import { randomUUID } from 'node:crypto';
import type { VendorAdapter } from './adapter.js';

export interface EventSink {
  emit(event: DomainEvent): void;
}

export class CollectingEventSink implements EventSink {
  readonly events: DomainEvent[] = [];
  emit(event: DomainEvent): void {
    this.events.push(event);
  }
}

export interface IngestStats {
  securitiesResolved: number;
  securitiesCreated: number;
  barsUpserted: number;
  fxUpserted: number;
  corporateActions: number;
  fundamentals: number;
  fundHoldings: number;
  resolutionFindings: QualityFinding[];
}

const now = () => new Date().toISOString();

function normName(n: string): string {
  return n.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export class IngestPipeline {
  constructor(
    private readonly pool: pg.Pool,
    private readonly adapter: VendorAdapter,
    private readonly sink: EventSink,
  ) {}

  /** vendorId → canonical security uuid, resolved during security ingest. */
  private readonly vendorMap = new Map<string, string>();

  async run(from: string, to: string): Promise<IngestStats> {
    const stats: IngestStats = {
      securitiesResolved: 0,
      securitiesCreated: 0,
      barsUpserted: 0,
      fxUpserted: 0,
      corporateActions: 0,
      fundamentals: 0,
      fundHoldings: 0,
      resolutionFindings: [],
    };
    await this.ingestSecurities(stats);
    await this.ingestCorporateActions(from, to, stats);
    await this.ingestBars(from, to, stats);
    await this.applySplitAdjustments();
    await this.ingestFx(from, to, stats);
    await this.ingestFundamentals(stats);
    await this.ingestFundHoldings(stats);
    return stats;
  }

  // -------------------------------------------------------------------------
  // Securities + entity resolution
  // -------------------------------------------------------------------------

  private async resolveOrCreate(sec: VendorSecurity, stats: IngestStats): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let securityId: string | null = null;

      if (sec.isin) {
        const { rows } = await client.query(
          `SELECT si.security_id, s.name FROM security_identifiers si
             JOIN securities s ON s.id = si.security_id
            WHERE si.id_type = 'isin' AND si.value = $1 AND si.valid_to IS NULL`,
          [sec.isin],
        );
        if (rows.length > 0) {
          securityId = rows[0].security_id as string;
          if (normName(rows[0].name as string) !== normName(sec.name)) {
            stats.resolutionFindings.push({
              kind: 'identifier_conflict',
              severity: 'warn',
              securityId,
              message: `ISIN ${sec.isin} resolves to "${rows[0].name}" but vendor says "${sec.name}"`,
              details: { isin: sec.isin, existing: rows[0].name, vendor: sec.name },
            });
          }
        }
      }

      if (!securityId) {
        const { rows } = await client.query(
          `SELECT security_id FROM listings
            WHERE exchange = $1 AND ticker = $2 AND valid_to IS NULL`,
          [sec.exchange, sec.ticker],
        );
        if (rows.length > 0) securityId = rows[0].security_id as string;
      }

      if (securityId) {
        stats.securitiesResolved += 1;
      } else {
        const { rows } = await client.query(
          `INSERT INTO securities (name, type, is_fund, gics_sector, gics_industry, country, currency)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [sec.name, sec.type, sec.isFund, sec.gicsSector ?? null, sec.gicsIndustry ?? null, sec.country ?? null, sec.currency],
        );
        securityId = rows[0].id as string;
        await client.query(
          `INSERT INTO listings (security_id, exchange, ticker, currency, is_primary, valid_from)
           VALUES ($1,$2,$3,$4,true,$5)`,
          [securityId, sec.exchange, sec.ticker, sec.currency, '1900-01-01'],
        );
        if (sec.isin) {
          await client.query(
            `INSERT INTO security_identifiers (security_id, id_type, value, valid_from)
             VALUES ($1,'isin',$2,$3)`,
            [securityId, sec.isin, '1900-01-01'],
          );
        }
        stats.securitiesCreated += 1;
      }
      await client.query('COMMIT');
      return securityId;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async ingestSecurities(stats: IngestStats): Promise<void> {
    const securities = await this.adapter.fetchSecurities();
    for (const sec of securities) {
      const id = await this.resolveOrCreate(sec, stats);
      this.vendorMap.set(sec.vendorId, id);
    }
  }

  private requireSecurity(vendorId: string): string {
    const id = this.vendorMap.get(vendorId);
    if (!id) throw new Error(`Unresolved vendorId ${vendorId} — securities must ingest first`);
    return id;
  }

  // -------------------------------------------------------------------------
  // Corporate actions (incl. ticker change → listing window management)
  // -------------------------------------------------------------------------

  private async ingestCorporateActions(from: string, to: string, stats: IngestStats): Promise<void> {
    const actions = await this.adapter.fetchCorporateActions(from, to);
    for (const a of actions) {
      const securityId = this.requireSecurity(a.vendorId);
      const res = await this.pool.query(
        `INSERT INTO corporate_actions (security_id, action_type, ex_date, ratio, cash_amount, currency, details, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (security_id, action_type, ex_date) DO NOTHING`,
        [securityId, a.type, a.exDate, a.ratio ?? null, a.cashAmount ?? null, a.currency ?? null, JSON.stringify(a.details ?? {}), this.adapter.source],
      );
      if ((res.rowCount ?? 0) > 0) {
        stats.corporateActions += 1;
        this.sink.emit({
          type: 'corporate.action',
          eventId: randomUUID(),
          occurredAt: now(),
          securityId,
          actionType: a.type,
          exDate: a.exDate,
        });
      }

      if (a.type === 'ticker_change') {
        const prev = (a.details as { previousTicker?: string } | undefined)?.previousTicker;
        if (prev) {
          const { rows } = await this.pool.query(
            `SELECT id, exchange, currency, is_primary FROM listings l
              WHERE l.security_id = $1 AND l.ticker = $2 AND l.valid_to IS NULL`,
            [securityId, prev],
          );
          if (rows.length > 0) {
            await this.pool.query('UPDATE listings SET valid_to = $2 WHERE id = $1', [rows[0].id, a.exDate]);
            await this.pool.query(
              `INSERT INTO listings (security_id, exchange, ticker, currency, is_primary, valid_from)
               VALUES ($1,$2,$3,$4,$5,$6)
               ON CONFLICT DO NOTHING`,
              [securityId, rows[0].exchange, a.newTicker, rows[0].currency, rows[0].is_primary, a.exDate],
            );
          } else {
            // Vendor feed already lists the new ticker (our mock does): record
            // the historical window so old CSVs importing "TICK" still resolve,
            // and start the live listing at the ex-date so the windows are
            // disjoint — ticker→security resolution stays historically exact.
            // NB: the unique index on (exchange, ticker) is partial (live rows
            // only), so ON CONFLICT can't dedupe closed windows — guard with
            // NOT EXISTS to keep re-runs idempotent.
            await this.pool.query(
              `INSERT INTO listings (security_id, exchange, ticker, currency, is_primary, valid_from, valid_to)
               SELECT $1, exchange, $2, currency, false, '1900-01-01', $3
                 FROM listings l WHERE l.security_id = $1 AND l.valid_to IS NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM listings h
                     WHERE h.security_id = $1 AND h.ticker = $2 AND h.valid_to IS NOT NULL)
                LIMIT 1`,
              [securityId, prev, a.exDate],
            );
            await this.pool.query(
              `UPDATE listings SET valid_from = $2
                WHERE security_id = $1 AND ticker = $3 AND valid_to IS NULL AND valid_from < $2`,
              [securityId, a.exDate, a.newTicker],
            );
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Prices
  // -------------------------------------------------------------------------

  private async ingestBars(from: string, to: string, stats: IngestStats): Promise<void> {
    const bars = await this.adapter.fetchEodBars(from, to);

    // Ensure monthly partitions before writing (§27.3.6).
    const months = new Set(bars.map((b) => b.date.slice(0, 7)));
    for (const m of months) {
      await this.pool.query('SELECT ensure_price_bars_partition($1)', [`${m}-01`]);
    }

    const latestBySecurity = new Map<string, string>();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const bar of bars) {
        const securityId = this.requireSecurity(bar.vendorId);
        await client.query(
          `INSERT INTO price_bars (security_id, bar_date, open, high, low, close, adjusted_close, volume, currency, source)
           VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9)
           ON CONFLICT (security_id, bar_date) DO UPDATE
             SET open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low,
                 close=EXCLUDED.close, adjusted_close=EXCLUDED.adjusted_close,
                 volume=EXCLUDED.volume, currency=EXCLUDED.currency,
                 source=EXCLUDED.source, ingested_at=now()`,
          [securityId, bar.date, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.currency, this.adapter.source],
        );
        stats.barsUpserted += 1;
        const prev = latestBySecurity.get(securityId);
        if (!prev || bar.date > prev) latestBySecurity.set(securityId, bar.date);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    for (const [securityId, barDate] of latestBySecurity) {
      this.sink.emit({
        type: 'market.price.eod',
        eventId: randomUUID(),
        occurredAt: now(),
        securityId,
        barDate,
      });
    }
  }

  /**
   * adjusted_close = close / Π(ratio of splits with ex_date > bar_date).
   * Bars on/after the ex-date are already on the new share basis.
   * Deterministic and idempotent: recomputed from raw close each time.
   */
  private async applySplitAdjustments(): Promise<void> {
    await this.pool.query(`
      WITH factors AS (
        SELECT pb.security_id, pb.bar_date,
               COALESCE((
                 SELECT exp(sum(ln(ca.ratio)))
                   FROM corporate_actions ca
                  WHERE ca.security_id = pb.security_id
                    AND ca.action_type = 'split'
                    AND ca.ratio IS NOT NULL
                    AND ca.ex_date > pb.bar_date
               ), 1) AS split_factor
          FROM price_bars pb
      )
      UPDATE price_bars pb
         SET adjusted_close = round(pb.close / f.split_factor, 6)
        FROM factors f
       WHERE f.security_id = pb.security_id AND f.bar_date = pb.bar_date
    `);
  }

  // -------------------------------------------------------------------------
  // FX, fundamentals, fund holdings
  // -------------------------------------------------------------------------

  private async ingestFx(from: string, to: string, stats: IngestStats): Promise<void> {
    const rates = await this.adapter.fetchFxRates(from, to);
    for (const r of rates) {
      await this.pool.query(
        `INSERT INTO fx_rates (base_currency, quote_currency, rate_date, rate, source)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (base_currency, quote_currency, rate_date) DO UPDATE
           SET rate = EXCLUDED.rate, source = EXCLUDED.source, ingested_at = now()`,
        [r.base, r.quote, r.date, r.rate, this.adapter.source],
      );
      stats.fxUpserted += 1;
    }
  }

  private async ingestFundamentals(stats: IngestStats): Promise<void> {
    const rows = await this.adapter.fetchFundamentals();
    for (const f of rows) {
      const securityId = this.requireSecurity(f.vendorId);
      await this.pool.query(
        `INSERT INTO fundamentals (security_id, as_of, period, metric, value, currency, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (security_id, as_of, period, metric) DO UPDATE
           SET value = EXCLUDED.value, currency = EXCLUDED.currency,
               source = EXCLUDED.source, ingested_at = now()`,
        [securityId, f.asOf, f.period, f.metric, f.value, f.currency ?? null, this.adapter.source],
      );
      stats.fundamentals += 1;
    }
  }

  private async ingestFundHoldings(stats: IngestStats): Promise<void> {
    const holdings = await this.adapter.fetchFundHoldings();
    const touchedFunds = new Map<string, string>();
    for (const h of holdings) {
      const fundId = this.requireSecurity(h.fundVendorId);
      let holdingId: string | null = null;
      if (h.holdingIsin) {
        const { rows } = await this.pool.query(
          `SELECT security_id FROM security_identifiers
            WHERE id_type = 'isin' AND value = $1 AND valid_to IS NULL`,
          [h.holdingIsin],
        );
        if (rows.length > 0) holdingId = rows[0].security_id as string;
      }
      if (!holdingId && h.holdingTicker && h.holdingExchange) {
        const { rows } = await this.pool.query(
          `SELECT security_id FROM listings
            WHERE exchange = $1 AND ticker = $2 AND valid_to IS NULL`,
          [h.holdingExchange, h.holdingTicker],
        );
        if (rows.length > 0) holdingId = rows[0].security_id as string;
      }
      if (!holdingId) {
        // Unresolvable constituent: it stays part of the fund's *unknown*
        // slice (D-006) rather than being force-created with guessed metadata.
        continue;
      }
      await this.pool.query(
        `INSERT INTO fund_holdings (fund_security_id, holding_security_id, weight, as_of, source)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (fund_security_id, holding_security_id, as_of) DO UPDATE
           SET weight = EXCLUDED.weight, source = EXCLUDED.source, ingested_at = now()`,
        [fundId, holdingId, h.weight, h.asOf, this.adapter.source],
      );
      stats.fundHoldings += 1;
      touchedFunds.set(fundId, h.asOf);
    }
    for (const [fundSecurityId, asOf] of touchedFunds) {
      this.sink.emit({
        type: 'fund.holdings.updated',
        eventId: randomUUID(),
        occurredAt: now(),
        fundSecurityId,
        asOf,
      });
    }
  }
}
