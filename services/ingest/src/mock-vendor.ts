/**
 * MockVendorAdapter — the §B8 "static snapshot dataset behind the ingestion
 * interface". Fully deterministic: prices are a seeded sinusoidal walk, so the
 * same code version always produces byte-identical output (FR-5.6 discipline
 * applied to test data too).
 *
 * The snapshot deliberately contains realistic mess (Design §B9.1 — "spike
 * with real messy cases"):
 *   - a 10-for-1 split (NVDA-like) mid-window
 *   - a cash dividend (MSFT-like)
 *   - a ticker change (TICK → TCKR)
 *   - a fund of funds (recursive look-through)
 *   - an ETF with a large *unknown* holdings remainder (D-006 unknown slice)
 *   - an un-flagged −30% outlier day (quality check must catch it)
 *   - missing bars for one security (completeness check must catch it)
 *   - one security whose feed goes stale weeks before window end
 */
import type {
  IsoDate,
  VendorBar,
  VendorCorporateAction,
  VendorFundamental,
  VendorFundHolding,
  VendorFxRate,
  VendorSecurity,
} from '@atlas/contracts';
import { Dec, dec, str, tradingDaysBetween } from '@atlas/domain';
import type { VendorAdapter } from './adapter.js';

export const SNAPSHOT_FROM: IsoDate = '2026-01-02';
export const SNAPSHOT_TO: IsoDate = '2026-06-30';

interface UniverseRow extends VendorSecurity {
  startPrice: string;
  drift: number; // per-day drift in basis points
  amp: number; // oscillation amplitude in basis points
  freq: number; // oscillation frequency
}

const UNIVERSE: UniverseRow[] = [
  { vendorId: 'MV-AAPL', name: 'Apple Inc', type: 'equity', isFund: false, isin: 'US0378331005', ticker: 'AAPL', exchange: 'XNAS', currency: 'USD', country: 'US', gicsSector: 'Information Technology', gicsIndustry: 'Technology Hardware', startPrice: '210', drift: 4, amp: 90, freq: 0.31 },
  { vendorId: 'MV-MSFT', name: 'Microsoft Corporation', type: 'equity', isFund: false, isin: 'US5949181045', ticker: 'MSFT', exchange: 'XNAS', currency: 'USD', country: 'US', gicsSector: 'Information Technology', gicsIndustry: 'Software', startPrice: '430', drift: 5, amp: 80, freq: 0.27 },
  { vendorId: 'MV-NVDA', name: 'NVIDIA Corporation', type: 'equity', isFund: false, isin: 'US67066G1040', ticker: 'NVDA', exchange: 'XNAS', currency: 'USD', country: 'US', gicsSector: 'Information Technology', gicsIndustry: 'Semiconductors', startPrice: '1180', drift: 9, amp: 160, freq: 0.41 },
  { vendorId: 'MV-ASML', name: 'ASML Holding NV', type: 'equity', isFund: false, isin: 'NL0010273215', ticker: 'ASML', exchange: 'XAMS', currency: 'EUR', country: 'NL', gicsSector: 'Information Technology', gicsIndustry: 'Semiconductor Equipment', startPrice: '820', drift: 3, amp: 110, freq: 0.23 },
  { vendorId: 'MV-SAP', name: 'SAP SE', type: 'equity', isFund: false, isin: 'DE0007164600', ticker: 'SAP', exchange: 'XETR', currency: 'EUR', country: 'DE', gicsSector: 'Information Technology', gicsIndustry: 'Software', startPrice: '195', drift: 2, amp: 70, freq: 0.19 },
  { vendorId: 'MV-SIE', name: 'Siemens AG', type: 'equity', isFund: false, isin: 'DE0007236101', ticker: 'SIE', exchange: 'XETR', currency: 'EUR', country: 'DE', gicsSector: 'Industrials', gicsIndustry: 'Industrial Conglomerates', startPrice: '178', drift: 3, amp: 60, freq: 0.29 },
  { vendorId: 'MV-MC', name: 'LVMH Moet Hennessy Louis Vuitton', type: 'equity', isFund: false, isin: 'FR0000121014', ticker: 'MC', exchange: 'XPAR', currency: 'EUR', country: 'FR', gicsSector: 'Consumer Discretionary', gicsIndustry: 'Luxury Goods', startPrice: '640', drift: 1, amp: 85, freq: 0.17 },
  { vendorId: 'MV-TCKR', name: 'Synthetic Renamed Corp', type: 'equity', isFund: false, isin: 'DE000SYN0001', ticker: 'TCKR', exchange: 'XETR', currency: 'EUR', country: 'DE', gicsSector: 'Industrials', gicsIndustry: 'Machinery', startPrice: '54', drift: 1, amp: 55, freq: 0.37 },
  { vendorId: 'MV-IWDA', name: 'iShares Core MSCI World UCITS ETF', type: 'etf', isFund: true, isin: 'IE00B4L5Y983', ticker: 'IWDA', exchange: 'XAMS', currency: 'EUR', country: 'IE', gicsSector: undefined, gicsIndustry: undefined, startPrice: '92', drift: 3, amp: 45, freq: 0.21 },
  { vendorId: 'MV-FOF', name: 'Atlas Synthetic Fund of Funds', type: 'fund', isFund: true, isin: 'IE000SYNFOF9', ticker: 'FOF', exchange: 'XAMS', currency: 'EUR', country: 'IE', gicsSector: undefined, gicsIndustry: undefined, startPrice: '31', drift: 2, amp: 35, freq: 0.13 },
];

const NVDA_SPLIT_EX: IsoDate = '2026-04-15';
const NVDA_SPLIT_RATIO = '10';
const MSFT_DIV_EX: IsoDate = '2026-03-12';
const TICKER_CHANGE_EX: IsoDate = '2026-03-02';
const SAP_OUTLIER_DAY: IsoDate = '2026-05-14';
const MC_MISSING_DAYS: IsoDate[] = ['2026-02-10', '2026-02-11', '2026-02-12'];
const TCKR_STALE_AFTER: IsoDate = '2026-06-10';

/** Deterministic per-day return in fraction, from a sinusoidal pseudo-walk. */
function dayReturn(row: UniverseRow, t: number, date: IsoDate): Dec {
  if (row.ticker === 'SAP' && date === SAP_OUTLIER_DAY) return dec('-0.30');
  const wave = Math.sin(row.freq * t) + 0.5 * Math.sin(row.freq * 2.7 * t + 1.3);
  // basis points → fraction; round the wave to 6dp so float noise cannot
  // change output across platforms.
  const bp = row.drift + row.amp * Number(wave.toFixed(6));
  return dec(bp.toFixed(6)).div(10_000);
}

export class MockVendorAdapter implements VendorAdapter {
  readonly source = 'mock-vendor-v1';

  async fetchSecurities(): Promise<VendorSecurity[]> {
    return UNIVERSE.map(({ startPrice, drift, amp, freq, ...sec }) => ({ ...sec }));
  }

  async fetchEodBars(from: IsoDate, to: IsoDate): Promise<VendorBar[]> {
    const days = tradingDaysBetween(from, to);
    const bars: VendorBar[] = [];
    for (const row of UNIVERSE) {
      let price = dec(row.startPrice);
      let t = 0;
      for (const date of days) {
        t += 1;
        let ret = dayReturn(row, t, date);
        // Raw (unadjusted) prices: the split divides the walking price by 10.
        if (row.ticker === 'NVDA' && date === NVDA_SPLIT_EX) {
          price = price.div(NVDA_SPLIT_RATIO);
        }
        price = price.times(dec(1).plus(ret)).toDecimalPlaces(4);
        if (row.ticker === 'MC' && MC_MISSING_DAYS.includes(date)) continue;
        if (row.ticker === 'TCKR' && date > TCKR_STALE_AFTER) continue;
        const open = price.times('0.997').toDecimalPlaces(4);
        const high = price.times('1.006').toDecimalPlaces(4);
        const low = price.times('0.992').toDecimalPlaces(4);
        bars.push({
          vendorId: row.vendorId,
          date,
          open: str(open),
          high: str(high),
          low: str(low),
          close: str(price),
          volume: str(dec(1_000_000 + ((t * 7919) % 500_000))),
          currency: row.currency,
        });
      }
    }
    return bars;
  }

  async fetchFxRates(from: IsoDate, to: IsoDate): Promise<VendorFxRate[]> {
    const days = tradingDaysBetween(from, to);
    const out: VendorFxRate[] = [];
    let t = 0;
    for (const date of days) {
      t += 1;
      // EURUSD oscillating deterministically around 1.09
      const wobble = Number((0.03 * Math.sin(0.11 * t)).toFixed(6));
      const rate = dec((1.09 + wobble).toFixed(6));
      out.push({ base: 'EUR', quote: 'USD', date, rate: str(rate) });
    }
    return out;
  }

  async fetchCorporateActions(from: IsoDate, to: IsoDate): Promise<VendorCorporateAction[]> {
    const all: VendorCorporateAction[] = [
      { vendorId: 'MV-NVDA', type: 'split', exDate: NVDA_SPLIT_EX, ratio: NVDA_SPLIT_RATIO },
      { vendorId: 'MV-MSFT', type: 'dividend', exDate: MSFT_DIV_EX, cashAmount: '0.75', currency: 'USD' },
      {
        vendorId: 'MV-TCKR',
        type: 'ticker_change',
        exDate: TICKER_CHANGE_EX,
        newTicker: 'TCKR',
        details: { previousTicker: 'TICK' },
      },
    ];
    return all.filter((a) => a.exDate >= from && a.exDate <= to);
  }

  async fetchFundamentals(): Promise<VendorFundamental[]> {
    const rows: Array<[string, string, string]> = [
      ['MV-AAPL', 'revenue_ttm', '391000000000'],
      ['MV-AAPL', 'eps_diluted_ttm', '6.41'],
      ['MV-MSFT', 'revenue_ttm', '261000000000'],
      ['MV-MSFT', 'eps_diluted_ttm', '12.05'],
      ['MV-NVDA', 'revenue_ttm', '130000000000'],
      ['MV-SAP', 'revenue_ttm', '34500000000'],
      ['MV-SIE', 'revenue_ttm', '78200000000'],
      ['MV-ASML', 'revenue_ttm', '28900000000'],
      ['MV-MC', 'revenue_ttm', '84600000000'],
    ];
    return rows.map(([vendorId, metric, value]) => ({
      vendorId,
      metric,
      value,
      asOf: '2026-03-31',
      period: 'ttm' as const,
      currency: vendorId === 'MV-SAP' || vendorId === 'MV-SIE' || vendorId === 'MV-ASML' || vendorId === 'MV-MC' ? 'EUR' : 'USD',
    }));
  }

  async fetchFundHoldings(): Promise<VendorFundHolding[]> {
    const asOf: IsoDate = '2026-06-30';
    return [
      // IWDA: top holdings only — 15.3% known, 84.7% deliberately unknown.
      // D-006: the unknown remainder is rendered, never silently zeroed.
      { fundVendorId: 'MV-IWDA', holdingIsin: 'US0378331005', holdingName: 'Apple Inc', weight: '0.050', asOf },
      { fundVendorId: 'MV-IWDA', holdingIsin: 'US5949181045', holdingName: 'Microsoft Corporation', weight: '0.045', asOf },
      { fundVendorId: 'MV-IWDA', holdingIsin: 'US67066G1040', holdingName: 'NVIDIA Corporation', weight: '0.040', asOf },
      { fundVendorId: 'MV-IWDA', holdingIsin: 'NL0010273215', holdingName: 'ASML Holding NV', weight: '0.010', asOf },
      { fundVendorId: 'MV-IWDA', holdingIsin: 'DE0007164600', holdingName: 'SAP SE', weight: '0.008', asOf },
      // FOF: fund of funds — 60% IWDA, 10% Siemens, 30% unknown. Recursive.
      { fundVendorId: 'MV-FOF', holdingIsin: 'IE00B4L5Y983', holdingName: 'iShares Core MSCI World UCITS ETF', weight: '0.60', asOf },
      { fundVendorId: 'MV-FOF', holdingIsin: 'DE0007236101', holdingName: 'Siemens AG', weight: '0.10', asOf },
    ];
  }
}
