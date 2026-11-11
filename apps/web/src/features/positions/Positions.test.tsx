// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockApi } from '../../test/mockApi';
import { Positions } from './Positions';

const portfolio = { id: 'p1', name: 'Long term', type: 'taxable', base_currency: 'EUR' };

describe('Positions', () => {
  it('renders positions and cash from the API without recomputing them', async () => {
    mockApi({
      'GET /v1/portfolios/p1/positions': {
        data: {
          positions: [
            { security_id: 's1', name: 'Apple Inc.', type: 'equity', pricing_currency: 'USD', quantity: '10.5', avg_cost: '180.25', cost_currency: 'USD' },
            { security_id: 's2', name: 'Mystery Co', type: 'equity', pricing_currency: 'EUR', quantity: '3', avg_cost: null, cost_currency: null },
          ],
          cash: [{ currency: 'EUR', amount: '1234.5' }],
        },
      },
    });
    const { container } = render(<Positions portfolio={portfolio} />);

    expect(await screen.findByText('Apple Inc.')).toBeTruthy();
    const rows = [...container.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.textContent),
    );
    expect(rows).toEqual([
      ['Apple Inc. USD', (10.5).toLocaleString(undefined, { maximumFractionDigits: 4 }), `${(180.25).toLocaleString(undefined, { maximumFractionDigits: 2 })} USD`],
      ['Mystery Co EUR', '3', '—'],
    ]);
    expect(screen.getByText(`${(1234.5).toLocaleString(undefined, { maximumFractionDigits: 2 })} EUR`)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Deposit EUR' })).toBeTruthy();
  });

  it('shows the empty states', async () => {
    mockApi({ 'GET /v1/portfolios/p1/positions': { data: { positions: [], cash: [] } } });
    render(<Positions portfolio={portfolio} />);

    expect(await screen.findByText('No positions. Import a CSV or add transactions.')).toBeTruthy();
    expect(screen.getByText('No cash recorded.')).toBeTruthy();
  });
});
