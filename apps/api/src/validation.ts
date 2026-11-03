/**
 * Input rules for ledger writes (issue #6). Kept pure so the API, manual
 * position entry and CSV import share one definition and it can be unit
 * tested without a database.
 */
import { dec } from '@atlas/domain';

type Dec = ReturnType<typeof dec>;

/** Plain decimal: optional minus sign, digits, optional fraction. No exponent, no blanks. */
export const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export const isDecimalString = (value: string): boolean => DECIMAL_PATTERN.test(value);

/** YYYY-MM-DD that exists in the calendar (rejects 2026-02-30, 2026-13-01…). */
export function isCalendarDate(value: string): boolean {
  const m = DATE_PATTERN.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

export type TradeAmounts = { quantity?: string; price?: string; fee?: string };

/**
 * Sign rules for buy/sell legs: quantity > 0, price ≥ 0, fee ≥ 0. Returns the
 * first violation. Values that are not decimal strings are left to the format
 * check (zod runs object refinements even after a field has failed).
 */
export function tradeAmountsError({ quantity, price, fee }: TradeAmounts): string | null {
  const num = (v: string | undefined) => (v !== undefined && isDecimalString(v) ? dec(v) : null);
  const q = num(quantity);
  const p = num(price);
  const f = num(fee);
  if (q && !q.gt(0)) return 'quantity must be greater than 0';
  if (p && p.lt(0)) return 'price must not be negative';
  if (f && f.lt(0)) return 'fee must not be negative';
  return null;
}

/**
 * Quantity held per trade date for one security: the net change of each day.
 * A holding is judged at the end of each date, so a same-day buy recorded
 * after a sell still covers it.
 */
export class HoldingLedger {
  private readonly deltas = new Map<string, Dec>();

  add(tradeDate: string, delta: Dec | string): void {
    this.deltas.set(tradeDate, (this.deltas.get(tradeDate) ?? dec(0)).plus(dec(delta as never)));
  }

  /** First date (≥ `from`, if given) whose end-of-day holding is negative. */
  firstNegativeDate(from?: string): string | null {
    let running = dec(0);
    for (const date of [...this.deltas.keys()].sort()) {
      running = running.plus(this.deltas.get(date)!);
      if (running.lt(0) && (from === undefined || date >= from)) return date;
    }
    return null;
  }

  /**
   * Applies a reduction of `quantity` on `tradeDate` only if no end-of-day
   * holding from that date on goes below zero. Returns the offending date
   * when it is refused.
   */
  tryReduce(tradeDate: string, quantity: Dec | string): { ok: true } | { ok: false; date: string } {
    const amount = dec(quantity as never);
    this.add(tradeDate, amount.negated());
    const date = this.firstNegativeDate(tradeDate);
    if (date === null) return { ok: true };
    this.add(tradeDate, amount);
    return { ok: false, date };
  }
}
