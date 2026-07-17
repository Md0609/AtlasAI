/**
 * @atlas/domain — pure domain logic shared across api/services (Design §B3).
 *
 * Rules enforced here:
 *  - P4 / §27.3.2: money and quantities are decimals carried as strings,
 *    never IEEE floats. All arithmetic goes through `dec`.
 *  - FR-5.6: determinism — fixed precision, fixed rounding, canonical
 *    serialization, and a stable input hash.
 */
import { createHash } from 'node:crypto';
import { Decimal as DecimalLib } from 'decimal.js';
import type { Currency, DecimalString, IsoDate } from '@atlas/contracts';

// A dedicated, frozen Decimal constructor so no other import can mutate
// global precision/rounding out from under the engine (FR-5.6).
export const Dec = DecimalLib.clone({
  precision: 34,
  rounding: DecimalLib.ROUND_HALF_EVEN,
  toExpNeg: -34,
  toExpPos: 34,
});
export type Dec = InstanceType<typeof Dec>;

export const dec = (v: DecimalString | number | Dec): Dec => new Dec(v as never);
export const ZERO = dec(0);
export const ONE = dec(1);

/** Render a Decimal to its canonical string form. */
export const str = (d: Dec): DecimalString => d.toString();

/** Fixed-scale render for user-facing values (never used for internal math). */
export const fixed = (d: Dec, dp: number): DecimalString => d.toFixed(dp);

// ---------------------------------------------------------------------------
// Money — §27.3.3: every monetary value carries a currency, no implicit base
// ---------------------------------------------------------------------------

export interface Money {
  amount: DecimalString;
  currency: Currency;
}

export function money(amount: DecimalString | number | Dec, currency: Currency): Money {
  if (!currency || currency.length !== 3) {
    throw new Error(`Money requires an ISO-4217 currency, got: ${JSON.stringify(currency)}`);
  }
  return { amount: str(dec(amount)), currency: currency.toUpperCase() };
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new Error(`Cannot add ${a.currency} to ${b.currency} without an explicit FX rate`);
  }
  return money(dec(a.amount).plus(b.amount), a.currency);
}

/**
 * Convert money using an explicit rate: 1 unit of `from` = `rate` units of `to`.
 * There is no implicit conversion path anywhere in the codebase.
 */
export function convert(m: Money, to: Currency, rate: DecimalString | Dec): Money {
  if (m.currency === to) return m;
  return money(dec(m.amount).times(dec(rate as never)), to);
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertIsoDate(d: string): IsoDate {
  if (!ISO_DATE_RE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) {
    throw new Error(`Invalid ISO date: ${d}`);
  }
  return d;
}

export function daysBetween(a: IsoDate, b: IsoDate): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

export function addDays(d: IsoDate, n: number): IsoDate {
  const t = new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000);
  return t.toISOString().slice(0, 10);
}

/** Monday–Friday trading calendar (naive; exchange calendars are a v1.1 refinement). */
export function isTradingDay(d: IsoDate): boolean {
  const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6;
}

export function tradingDaysBetween(from: IsoDate, to: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (isTradingDay(d)) out.push(d);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Canonical hashing (FR-5.6) — same inputs + same version ⇒ identical hash
// ---------------------------------------------------------------------------

/** Deterministic JSON: object keys sorted recursively, no whitespace variance. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v !== null && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, val]) => [k, sortValue(val)]));
  }
  return v;
}

export function inputHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
