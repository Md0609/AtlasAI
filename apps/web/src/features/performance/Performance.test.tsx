// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockApi } from '../../test/mockApi';
import { Performance } from './Performance';

const portfolio = { id: 'p1', name: 'Long term', type: 'taxable', base_currency: 'EUR' };

describe('Performance', () => {
  it('shows the metrics the API returns, formatted only', async () => {
    const calls = mockApi({
      'GET /v1/portfolios/p1/performance': {
        data: {
          window: { from: '2026-01-02', to: '2026-11-10' },
          twr: '0.08765',
          mwr: null,
          max_drawdown: '-0.1234',
          current_drawdown: '-0.02',
          currency_decomposition: [{ currency: 'USD', localReturn: '0.12', fxReturn: '-0.034' }],
        },
        gaps: [{ component: 'prices', reason: 'Missing price for Mystery Co' }],
        staleness: { prices_as_of: '2026-11-10' },
      },
    });
    const { container } = render(<Performance portfolio={portfolio} />);

    expect(await screen.findByText('Window 2026-01-02 → 2026-11-10')).toBeTruthy();
    const cell = (label: string) => screen.getByText(label).nextElementSibling?.textContent;
    expect(cell('Time-weighted return (TWR)')).toBe('8.765%');
    expect(cell('Money-weighted return (MWR / XIRR)')).toBe('—');
    expect(cell('Max drawdown')).toBe('-12.34%');
    expect(cell('Current drawdown')).toBe('-2.00%');
    expect(screen.getByText('USD').closest('tr')!.textContent).toBe('USD12.000%-3.400%');
    expect(container.querySelector('.gaps')?.textContent).toBe('⚠ Missing price for Mystery Co');
    expect(calls[0].path).toBe('/v1/portfolios/p1/performance?method=both');
  });

  it('shows the not-enough-history state with its gaps', async () => {
    mockApi({
      'GET /v1/portfolios/p1/performance': {
        data: null,
        gaps: [{ component: 'history', reason: 'Need at least two valuation dates' }],
        staleness: { prices_as_of: null },
      },
    });
    render(<Performance portfolio={portfolio} />);

    expect(await screen.findByText('Not enough history yet.')).toBeTruthy();
    expect(screen.getByText('⚠ Need at least two valuation dates')).toBeTruthy();
  });
});
