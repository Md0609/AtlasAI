import { afterEach, describe, expect, it } from 'vitest';
import { formatDate, formatFixed, formatMoney, formatNumber, formatPct, isZeroDecimal, MISSING } from './format';

describe('formatNumber (quantities: at most dp decimals, trailing zeros dropped)', () => {
  it('formats zero, negatives, grouping and decimals', () => {
    expect(formatNumber('0')).toBe('0');
    expect(formatNumber('0.000')).toBe('0');
    expect(formatNumber('-1234.5')).toBe('-1,234.5');
    expect(formatNumber('1234567.891')).toBe('1,234,567.89');
    expect(formatNumber('10.5000', 4)).toBe('10.5');
    expect(formatNumber('3')).toBe('3');
    expect(formatNumber('.5')).toBe('0.5');
    expect(formatNumber('+7')).toBe('7');
  });

  it('rounds half away from zero on the decimal string, exactly', () => {
    expect(formatNumber('0.125')).toBe('0.13');
    expect(formatNumber('-0.125')).toBe('-0.13');
    expect(formatNumber('1.005')).toBe('1.01'); // a float would give 1.00 (1.00499999…)
    expect(formatNumber('9.995')).toBe('10');
    expect(formatNumber('999999.999')).toBe('1,000,000');
    expect(formatNumber('12345678901234567890.123')).toBe('12,345,678,901,234,567,890.12');
  });

  it('never prints a negative zero', () => {
    expect(formatNumber('-0.001')).toBe('0');
    expect(formatNumber('-0')).toBe('0');
  });

  it('treats absence and garbage as missing, never as zero', () => {
    for (const v of [null, undefined, '', '   ', 'abc', '1e5', '1.2.3', '-', '.']) expect(formatNumber(v)).toBe(MISSING);
  });
});

describe('formatFixed', () => {
  it('keeps exactly dp decimals', () => {
    expect(formatFixed('0.4225', 3)).toBe('0.423');
    expect(formatFixed('2', 2)).toBe('2.00');
    expect(formatFixed('-0.0004', 3)).toBe('0.000');
    expect(formatFixed(null, 2)).toBe(MISSING);
  });
});

describe('formatPct (fractions → percent)', () => {
  it('formats zero, negatives and decimals', () => {
    expect(formatPct('0')).toBe('0.00%');
    expect(formatPct('0.6')).toBe('60.00%');
    expect(formatPct('1')).toBe('100.00%');
    expect(formatPct('12.5')).toBe('1,250.00%');
    expect(formatPct('0.08765', 3)).toBe('8.765%');
    expect(formatPct('-0.1234')).toBe('-12.34%');
    expect(formatPct('-0.034', 3)).toBe('-3.400%');
    expect(formatPct('0.000125')).toBe('0.01%');
    expect(formatPct('0.5', 0)).toBe('50%');
  });

  it('does not print a negative zero and keeps absence as missing', () => {
    expect(formatPct('-0.00001')).toBe('0.00%');
    expect(formatPct(null)).toBe(MISSING);
    expect(formatPct(undefined)).toBe(MISSING);
  });
});

describe('formatMoney', () => {
  it("uses the currency's minor unit and appends the ISO code", () => {
    expect(formatMoney('1234.5', 'EUR')).toBe('1,234.50 EUR');
    expect(formatMoney('0', 'USD')).toBe('0.00 USD');
    expect(formatMoney('-15.239', 'GBP')).toBe('-15.24 GBP');
    expect(formatMoney('1234.5', 'JPY')).toBe('1,235 JPY');
    expect(formatMoney('180.25', 'USD')).toBe('180.25 USD');
    expect(formatMoney('1.23456', 'EUR', 4)).toBe('1.2346 EUR');
  });

  it('falls back to 2 decimals for an unknown/invalid currency code', () => {
    expect(formatMoney('1', 'XX1')).toBe('1.00 XX1');
    expect(formatMoney('1', null)).toBe('1.00');
  });

  it('shows a missing amount as missing, without a currency', () => {
    expect(formatMoney(null, 'EUR')).toBe(MISSING);
    expect(formatMoney(undefined, 'EUR')).toBe(MISSING);
    expect(formatMoney('', 'EUR')).toBe(MISSING);
  });
});

describe('formatDate (calendar day, independent of the viewer time zone)', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it.each(['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Tokyo', 'Europe/Madrid'])(
    'shows the same day in %s',
    (tz) => {
      process.env.TZ = tz;
      expect(formatDate('2026-01-02')).toBe('2 Jan 2026');
      expect(formatDate('2026-12-31')).toBe('31 Dec 2026');
      expect(formatDate('2024-02-29')).toBe('29 Feb 2024');
      // Timestamps are shown as their UTC calendar day.
      expect(formatDate('2026-01-02T23:30:00-05:00')).toBe('3 Jan 2026');
      expect(formatDate('2026-01-02T00:30:00Z')).toBe('2 Jan 2026');
    },
  );

  it('the time-zone switch above is effective (a naive Date formatter would shift the day)', () => {
    process.env.TZ = 'America/Los_Angeles';
    expect(new Date('2026-01-02').getDate()).toBe(1);
  });

  it('treats absence and invalid dates as missing', () => {
    for (const v of [null, undefined, '', 'yesterday', '2026-02-30', '2026-13-01', '02/01/2026']) {
      expect(formatDate(v)).toBe(MISSING);
    }
  });
});

describe('isZeroDecimal (real zero vs value vs missing, on the string)', () => {
  it('recognises zero in any decimal spelling', () => {
    expect(isZeroDecimal('0')).toBe(true);
    expect(isZeroDecimal('-0.000')).toBe(true);
    expect(isZeroDecimal('.0')).toBe(true);
  });
  it('does not round tiny values to zero', () => {
    expect(isZeroDecimal('0.0000000000000000000000000000001')).toBe(false);
    expect(isZeroDecimal('-0.5')).toBe(false);
  });
  it('returns null for missing or malformed values instead of claiming zero', () => {
    expect(isZeroDecimal(null)).toBeNull();
    expect(isZeroDecimal(undefined)).toBeNull();
    expect(isZeroDecimal('')).toBeNull();
    expect(isZeroDecimal('NaN')).toBeNull();
  });
});
