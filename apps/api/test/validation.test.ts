import { describe, expect, it } from 'vitest';
import { dec } from '@atlas/domain';
import { HoldingLedger, isCalendarDate, isDecimalString, tradeAmountsError } from '../src/validation.js';

describe('isCalendarDate', () => {
  it.each(['2026-01-05', '2024-02-29', '2026-12-31'])('accepts %s', (d) => expect(isCalendarDate(d)).toBe(true));
  it.each(['2026-02-30', '2025-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-1-5', 'bad-date', ''])(
    'rejects %s',
    (d) => expect(isCalendarDate(d)).toBe(false),
  );
});

describe('isDecimalString', () => {
  it.each(['0', '12', '-3', '12.5', '0.0001'])('accepts %s', (v) => expect(isDecimalString(v)).toBe(true));
  it.each(['abc', '', ' 1', '1e3', '1,5', '.5', '1.', 'NaN', 'Infinity', '--1'])('rejects %j', (v) =>
    expect(isDecimalString(v)).toBe(false),
  );
});

describe('tradeAmountsError', () => {
  it('accepts a positive quantity, zero price and zero fee', () => {
    expect(tradeAmountsError({ quantity: '3', price: '0', fee: '0' })).toBeNull();
  });
  it.each([
    [{ quantity: '-3' }, /quantity/],
    [{ quantity: '0' }, /quantity/],
    [{ quantity: '1', price: '-0.01' }, /price/],
    [{ quantity: '1', price: '1', fee: '-1' }, /fee/],
  ])('rejects %j', (input, message) => expect(tradeAmountsError(input)).toMatch(message));
});

describe('HoldingLedger', () => {
  it('refuses a sell with no holding and leaves the ledger unchanged', () => {
    const l = new HoldingLedger();
    expect(l.tryReduce('2026-01-05', '1')).toEqual({ ok: false, date: '2026-01-05' });
    expect(l.firstNegativeDate()).toBeNull();
  });

  it('allows selling exactly the holding', () => {
    const l = new HoldingLedger();
    l.add('2026-01-05', '10');
    expect(l.tryReduce('2026-02-01', dec(10))).toEqual({ ok: true });
    expect(l.tryReduce('2026-02-02', '0.0001').ok).toBe(false);
  });

  it('judges the holding at the end of the trade date', () => {
    const l = new HoldingLedger();
    l.add('2026-01-05', '10');
    expect(l.tryReduce('2026-01-05', '10').ok).toBe(true);
  });

  it('refuses a backdated sell before the buy', () => {
    const l = new HoldingLedger();
    l.add('2026-02-02', '10');
    expect(l.tryReduce('2026-01-15', '5')).toEqual({ ok: false, date: '2026-01-15' });
  });

  it('refuses a sell that a later sell already relies on', () => {
    const l = new HoldingLedger();
    l.add('2026-01-05', '10');
    expect(l.tryReduce('2026-03-01', '8').ok).toBe(true);
    // Selling 5 in February would leave −3 after the March sell.
    expect(l.tryReduce('2026-02-01', '5')).toEqual({ ok: false, date: '2026-03-01' });
  });
});

describe('tradeAmountsError with malformed input', () => {
  it('does not throw on non-decimal values (left to the format check)', () => {
    expect(tradeAmountsError({ quantity: 'abc', price: 'x', fee: '1e3' })).toBeNull();
  });
});
