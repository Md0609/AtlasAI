/**
 * Vendor-agnostic ingestion interface (Design §B5.2, §B8).
 *
 * The mock vendor implements this today; the real EOD vendor chosen in the
 * Phase-0 bake-off implements the same interface and nothing downstream
 * changes. Everything downstream of this seam consumes canonical records
 * from @atlas/contracts, never vendor payloads.
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

export interface VendorAdapter {
  /** Stable vendor identifier recorded as `source` on every row. */
  readonly source: string;

  fetchSecurities(): Promise<VendorSecurity[]>;
  fetchEodBars(from: IsoDate, to: IsoDate): Promise<VendorBar[]>;
  fetchFxRates(from: IsoDate, to: IsoDate): Promise<VendorFxRate[]>;
  fetchCorporateActions(from: IsoDate, to: IsoDate): Promise<VendorCorporateAction[]>;
  fetchFundamentals(): Promise<VendorFundamental[]>;
  fetchFundHoldings(): Promise<VendorFundHolding[]>;
}
