// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { mockApi } from '../../test/mockApi';
import { Home } from './Home';

const me = { id: 'u1', email: 'ana@example.com', jurisdiction: 'ES', base_currency: 'EUR' };
const portfolios = [
  { id: 'p1', name: 'Long term', type: 'taxable', base_currency: 'EUR' },
  { id: 'p2', name: 'Pension', type: 'pension', base_currency: 'USD' },
];

describe('Home (portfolios list)', () => {
  it('lists the portfolios returned by the API', async () => {
    mockApi({ 'GET /v1/portfolios': { data: portfolios } });
    render(<Home me={me} onLogout={vi.fn()} />);

    expect(await screen.findByText('Long term')).toBeTruthy();
    expect(screen.getByText('Pension')).toBeTruthy();
    expect(screen.getByText('pension · USD')).toBeTruthy();
    expect(screen.queryByText('No portfolios yet.')).toBeNull();
  });

  it('shows the empty state and creates a portfolio in the user base currency', async () => {
    let list: typeof portfolios = [];
    const calls = mockApi({
      'GET /v1/portfolios': () => ({ body: { data: list } }),
      'POST /v1/portfolios': () => {
        list = [portfolios[0]];
        return { status: 201, body: portfolios[0] };
      },
    });
    render(<Home me={me} onLogout={vi.fn()} />);

    expect(await screen.findByText('No portfolios yet.')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('New portfolio name'), { target: { value: 'Long term' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('Long term')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'Long term',
      type: 'taxable',
      base_currency: 'EUR',
    });
  });

  it('opens a portfolio on its summary tab and keeps the other views reachable', async () => {
    mockApi({
      'GET /v1/portfolios': { data: portfolios },
      'GET /v1/portfolios/p1/exposure': {
        data: {
          dimension: 'sector', total_value_base: '0', base_currency: 'EUR', slices: [], weights: [], look_through: [],
          concentration: { topN: [], hhi: '0', effectiveN: '0', nominalN: 0 }, cash_weight: '0',
        },
        provenance: { engineVersion: '1', inputHash: 'h', methodology: 'm' },
        gaps: [],
        staleness: { prices_as_of: null, fx_as_of: null, holdings_as_of: null },
      },
      'GET /v1/portfolios/p1/performance': { data: null, gaps: [], staleness: { prices_as_of: null } },
      'GET /v1/portfolios/p1/positions': { data: { positions: [], cash: [] } },
    });
    const { container } = render(<Home me={me} onLogout={vi.fn()} />);
    fireEvent.click(await screen.findByText('Long term'));

    expect(await screen.findByRole('heading', { name: 'Summary' })).toBeTruthy();
    const tabs = () => [...container.querySelectorAll('nav.tabs button')].map((b) => [b.textContent, b.className]);
    expect(tabs()).toEqual([
      ['summary', 'tab active'],
      ['positions', 'tab'],
      ['exposure', 'tab'],
      ['performance', 'tab'],
      ['import', 'tab'],
    ]);

    // Positions is still one click away and renders as before.
    fireEvent.click(screen.getByRole('button', { name: 'positions' }));
    await waitFor(() => expect(screen.getByText('No positions. Import a CSV or add transactions.')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'positions' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('heading', { name: 'Summary' })).toBeNull();
  });

  it('returns to the summary after an import', async () => {
    mockApi({
      'GET /v1/portfolios': { data: portfolios },
      'GET /v1/portfolios/p1/exposure': () => ({ status: 500, body: { type: 'x', title: 'boom', status: 500, trace_id: 't' } }),
      'GET /v1/portfolios/p1/performance': { data: null, gaps: [], staleness: { prices_as_of: null } },
      'POST /v1/portfolios/p1/import': { imported: 1, skipped: [] },
    });
    const { container } = render(<Home me={me} onLogout={vi.fn()} />);
    fireEvent.click(await screen.findByText('Long term'));
    fireEvent.click(screen.getByRole('button', { name: 'import' }));
    fireEvent.change(container.querySelector('textarea')!, { target: { value: 'ticker,date,quantity,price,currency\nAAPL,2026-02-02,1,1,USD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    fireEvent.click(await screen.findByRole('button', { name: 'View summary →' }));

    expect(await screen.findByRole('heading', { name: 'Summary' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'summary' }).className).toBe('tab active');
  });
});
