import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  inputHash,
  dec,
  str,
  money,
  convert,
  tradingDayOnOrAfter,
  tradingDaysBetween,
  isTradingDay,
} from '@atlas/domain';

describe('canonicalJson', () => {
  it('is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
  it('hashes stably', () => {
    expect(inputHash({ x: [1, 2, 3] })).toBe(inputHash({ x: [1, 2, 3] }));
    expect(inputHash({ x: 1 })).not.toBe(inputHash({ x: 2 }));
  });
});

describe('decimal money', () => {
  it('avoids float artifacts: 0.1 + 0.2 = 0.3 exactly', () => {
    expect(str(dec('0.1').plus('0.2'))).toBe('0.3');
  });
  it('convert requires an explicit rate and multiplies exactly', () => {
    const out = convert(money('100', 'USD'), 'EUR', '0.8');
    expect(out.currency).toBe('EUR');
    expect(out.amount).toBe('80');
  });
});

describe('trading days', () => {
  it('skips weekends', () => {
    // Fri 2026-01-02 → Mon 2026-01-05
    const days = tradingDaysBetween('2026-01-02', '2026-01-05');
    expect(days).toEqual(['2026-01-02', '2026-01-05']);
    expect(isTradingDay('2026-01-03')).toBe(false); // Saturday
  });

  it('books a weekend date on the next trading day and keeps trading days as they are', () => {
    expect(tradingDayOnOrAfter('2026-02-06')).toBe('2026-02-06'); // Friday
    expect(tradingDayOnOrAfter('2026-02-07')).toBe('2026-02-09'); // Saturday → Monday
    expect(tradingDayOnOrAfter('2026-02-08')).toBe('2026-02-09'); // Sunday → Monday
    expect(tradingDayOnOrAfter('2026-02-09')).toBe('2026-02-09'); // Monday
    expect(tradingDayOnOrAfter('2026-02-28')).toBe('2026-03-02'); // Saturday across a month end
  });
});
