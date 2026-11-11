// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { mockApi } from '../../test/mockApi';
import { ImportCsv } from './ImportCsv';

const portfolio = { id: 'p1', name: 'Long term', type: 'taxable', base_currency: 'EUR' };
const CSV = 'symbol,date,qty,price,ccy,notes\nAAPL,2026-02-02,10,220.5,USD,x';

const mappingValues = (container: HTMLElement) =>
  Object.fromEntries(
    [...container.querySelectorAll('.mapping label')].map((l) => [
      l.firstChild?.textContent,
      (l.querySelector('select') as HTMLSelectElement).value,
    ]),
  );

describe('ImportCsv', () => {
  it('shows the column mapping once a header is present, auto-mapping obvious names', () => {
    mockApi({});
    const { container } = render(<ImportCsv portfolio={portfolio} onDone={vi.fn()} />);

    expect(screen.queryByText('Column mapping')).toBeNull();
    expect((screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(container.querySelector('textarea')!, { target: { value: CSV } });

    expect(screen.getByText('Column mapping')).toBeTruthy();
    expect(mappingValues(container)).toEqual({
      ticker: 'symbol',
      isin: '',
      date: 'date',
      type: '',
      quantity: 'qty',
      price: 'price',
      currency: 'ccy',
      fee: '',
    });
    const options = [...container.querySelectorAll('.mapping label')[0].querySelectorAll('option')].map((o) => o.textContent);
    expect(options).toEqual(['—', 'symbol', 'date', 'qty', 'price', 'ccy', 'notes']);
  });

  it('posts the csv with the edited mapping and shows imported and skipped rows', async () => {
    const calls = mockApi({
      'POST /v1/portfolios/p1/import': { imported: 1, skipped: [{ line: 3, reason: 'unknown ticker ZZZ' }] },
    });
    const onDone = vi.fn();
    const { container } = render(<ImportCsv portfolio={portfolio} onDone={onDone} />);
    fireEvent.change(container.querySelector('textarea')!, { target: { value: CSV } });
    const feeSelect = container.querySelectorAll('.mapping select')[7] as HTMLSelectElement;
    fireEvent.change(feeSelect, { target: { value: 'notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    expect(await screen.findByText('Imported 1 transaction(s).')).toBeTruthy();
    expect(screen.getByText('line 3: unknown ticker ZZZ')).toBeTruthy();
    expect(calls[0].body).toEqual({
      csv: CSV,
      mapping: { ticker: 'symbol', date: 'date', quantity: 'qty', price: 'price', currency: 'ccy', fee: 'notes' },
      defaults: { type: 'buy' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'View positions →' }));
    expect(onDone).toHaveBeenCalled();
  });
});
