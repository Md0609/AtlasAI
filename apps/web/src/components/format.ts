/**
 * The single set of display formatters for the web (objective.md AT-2). Every amount, percentage
 * and date on screen goes through here so the same figure reads the same way in every view.
 *
 * They only *format* the decimal strings the API returns — they never compute metrics
 * (objective.md §6). To honour that, numbers are formatted by manipulating the decimal string
 * itself, never by converting it to a binary float: a value such as "1234567890.125" is rounded
 * exactly, and nothing a formatter prints can disagree with the engine's own decimal.
 *
 * Policy (tested in format.test.ts):
 * - Locale: fixed, English (the current interface language), British style — `,` groups thousands,
 *   `.` is the decimal point, dates read "2 Jan 2026". It does not depend on the browser's locale,
 *   so tests and screenshots are stable and no view can drift from another.
 * - Rounding: half away from zero at the requested number of decimals ("0.125" → "0.13",
 *   "-0.125" → "-0.13"). A value that rounds to zero is printed without a sign ("-0.001" → "0.00").
 * - Absence: `null`, `undefined`, `''` or a non-decimal string is shown as `—` (MISSING). Absence
 *   is never printed as zero — that would be a claim about the data.
 * - Calendar dates ("YYYY-MM-DD") are read from their digits, never through `Date`, so the day shown
 *   cannot shift with the viewer's time zone. Full timestamps are shown as their UTC calendar day.
 */

/** Missing is missing: never 0, never blank. */
export const MISSING = '—';

type Value = string | null | undefined;

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?$/;

interface Parsed {
  negative: boolean;
  int: string;
  frac: string;
}

function parse(v: Value): Parsed | null {
  if (v == null) return null;
  const s = String(v).trim();
  const m = DECIMAL.exec(s);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return null;
  return { negative: m[1] === '-', int: m[2] || '0', frac: m[3] ?? '' };
}

/** Moves the decimal point `places` to the right (×10^places) on the string, exactly. */
function shift(p: Parsed, places: number): Parsed {
  const frac = p.frac.padEnd(places, '0');
  return { negative: p.negative, int: p.int + frac.slice(0, places), frac: frac.slice(places) };
}

/** Adds one unit to the last digit of a string of digits ("199" → "200", "99" → "100"). */
function increment(digits: string): string {
  const out = digits.split('');
  let i = out.length - 1;
  while (i >= 0) {
    if (out[i] === '9') {
      out[i] = '0';
      i--;
    } else {
      out[i] = String(Number(out[i]) + 1);
      return out.join('');
    }
  }
  return `1${out.join('')}`;
}

/**
 * Rounds half away from zero to `dp` decimals and returns sign, integer and fraction digits.
 * With `trim`, trailing fractional zeros are dropped (used for quantities, as before AT-2).
 */
function round(p: Parsed, dp: number, trim: boolean): Parsed {
  const frac = p.frac.padEnd(dp + 1, '0');
  let digits = (p.int + frac.slice(0, dp)).replace(/^0+(?=\d)/, '');
  if (Number(frac[dp]) >= 5) digits = increment(digits);
  digits = digits.padStart(dp + 1, '0');
  const int = digits.slice(0, digits.length - dp).replace(/^0+(?=\d)/, '');
  let fr = digits.slice(digits.length - dp);
  if (trim) fr = fr.replace(/0+$/, '');
  const isZero = /^0*$/.test(int + fr);
  return { negative: p.negative && !isZero, int, frac: fr };
}

function group(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function render(p: Parsed): string {
  return `${p.negative ? '-' : ''}${group(p.int)}${p.frac ? `.${p.frac}` : ''}`;
}

/**
 * A plain number with at most `dp` decimals, trailing zeros dropped: quantities, counts.
 * `formatNumber('10.5000', 4)` → "10.5"; `formatNumber('1234567.891')` → "1,234,567.89".
 */
export function formatNumber(v: Value, dp = 2): string {
  const p = parse(v);
  return p ? render(round(p, dp, true)) : MISSING;
}

/** A number with exactly `dp` decimals: index-like figures such as HHI. */
export function formatFixed(v: Value, dp = 2): string {
  const p = parse(v);
  return p ? render(round(p, dp, false)) : MISSING;
}

/**
 * A weight or return the API sends as a fraction: `formatPct('0.08765', 3)` → "8.765%".
 * Always `dp` decimals, so a column of percentages lines up.
 */
export function formatPct(v: Value, dp = 2): string {
  const p = parse(v);
  return p ? `${render(round(shift(p, 2), dp, false))}%` : MISSING;
}

/** Decimals of a currency's minor unit (EUR 2, JPY 0); 2 when the code is unknown. */
export function currencyDecimals(currency: string): number {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/**
 * An amount with its ISO currency code after it: `formatMoney('1234.5', 'EUR')` → "1,234.50 EUR".
 * Uses the currency's minor unit unless `dp` is given. A missing amount is "—" with no currency.
 */
export function formatMoney(v: Value, currency: string | null | undefined, dp?: number): string {
  const p = parse(v);
  if (!p) return MISSING;
  const amount = render(round(p, dp ?? (currency ? currencyDecimals(currency) : 2), false));
  return currency ? `${amount} ${currency}` : amount;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A calendar day: `formatDate('2026-01-02')` → "2 Jan 2026". Date-only strings are read from their
 * digits (no time zone involved); timestamps such as "2026-01-02T23:30:00-05:00" are shown as their
 * UTC calendar day ("3 Jan 2026"). Anything unparsable is "—".
 */
export function formatDate(v: Value): string {
  if (!v) return MISSING;
  const s = String(v).trim();
  let y: number, m: number, d: number;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dateOnly) {
    [y, m, d] = [Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])];
    const check = new Date(Date.UTC(y, m - 1, d));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return MISSING;
  } else {
    if (!/^\d{4}-\d{2}-\d{2}T/.test(s)) return MISSING;
    const t = new Date(s);
    if (Number.isNaN(t.getTime())) return MISSING;
    [y, m, d] = [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
  }
  return `${d} ${MONTHS[m - 1]} ${y}`;
}


/**
 * Whether a decimal string is exactly zero ("0", "-0.000", "0e0" is not a decimal → null). Reads the
 * digits only — no conversion to Number — so "0.0000000000000000000001" is not zero. Used to tell
 * a real zero from a value, never to compute one. `null` when the value is missing or malformed.
 */
export function isZeroDecimal(v: Value): boolean | null {
  const p = parse(v);
  return p ? /^0*$/.test(p.int + p.frac) : null;
}
