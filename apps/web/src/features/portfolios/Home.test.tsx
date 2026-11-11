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

  it('opens a portfolio on its positions tab', async () => {
    mockApi({
      'GET /v1/portfolios': { data: portfolios },
      'GET /v1/portfolios/p1/positions': { data: { positions: [], cash: [] } },
    });
    const { container } = render(<Home me={me} onLogout={vi.fn()} />);
    fireEvent.click(await screen.findByText('Long term'));

    await waitFor(() => expect(screen.getByText('No positions. Import a CSV or add transactions.')).toBeTruthy());
    const tabs = [...container.querySelectorAll('nav.tabs button')].map((b) => [b.textContent, b.className]);
    expect(tabs).toEqual([
      ['positions', 'tab active'],
      ['exposure', 'tab'],
      ['performance', 'tab'],
      ['import', 'tab'],
    ]);
  });
});
