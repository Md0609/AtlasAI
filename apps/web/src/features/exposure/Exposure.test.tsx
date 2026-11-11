// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ExposureResponse } from '../../api';
import { mockApi } from '../../test/mockApi';
import { Exposure } from './Exposure';

const portfolio = { id: 'p1', name: 'Long term', type: 'taxable', base_currency: 'EUR' };

const response = (dimension: string): ExposureResponse => ({
  data: {
    dimension,
    total_value_base: '1000',
    base_currency: 'EUR',
    slices: [
      { key: 'Technology', weight: '0.6', marketValueBase: '600' },
      { key: 'UNKNOWN', weight: '0.25', marketValueBase: '250' },
    ],
    weights: [],
    look_through: [
      { securityId: 's1', label: 'Apple Inc.', weight: '0.6', viaDirect: '0.5', viaFunds: '0.1' },
      { securityId: null, label: 'Unknown', weight: '0.25', viaDirect: '0', viaFunds: '0.25' },
    ],
    concentration: { topN: [], hhi: '0.4225', effectiveN: '2.3669', nominalN: 2 },
    cash_weight: '0.15',
  },
  provenance: { engineVersion: '1.2.3', inputHash: 'abcdef0123456789', methodology: 'look-through-v1' },
  gaps: [{ component: 'holdings', reason: 'Fund XYZ has no holdings breakdown' }],
  staleness: { prices_as_of: '2026-11-10', fx_as_of: null, holdings_as_of: null },
});

describe('Exposure', () => {
  it('keeps the unknown portion visible as its own row in slices and look-through', async () => {
    mockApi({ 'GET /v1/portfolios/p1/exposure': ({ path }) => ({ body: response(new URL(path, 'http://x').searchParams.get('dimension')!) }) });
    const { container } = render(<Exposure portfolio={portfolio} />);

    const unknownSlice = (await screen.findByText('UNKNOWN')).closest('tr')!;
    expect(unknownSlice.className).toBe('unknown');
    expect(unknownSlice.textContent).toBe('UNKNOWN25.00%');
    const unknownLook = screen.getByText('Unknown').closest('tr')!;
    expect(unknownLook.className).toBe('unknown');
    expect(unknownLook.textContent).toBe('Unknown25.00%0.00%25.00%');
    expect(screen.getByText('Technology').closest('tr')!.className).toBe('');

    expect(container.textContent).toContain('cash 15.00%');
    expect(screen.getByText('⚠ Fund XYZ has no holdings breakdown')).toBeTruthy();
    expect(container.querySelector('.provenance')?.textContent).toContain('engine 1.2.3 · look-through-v1 · inputs abcdef012345…');
  });

  it('requests the chosen dimension', async () => {
    const calls = mockApi({ 'GET /v1/portfolios/p1/exposure': ({ path }) => ({ body: response(new URL(path, 'http://x').searchParams.get('dimension')!) }) });
    render(<Exposure portfolio={portfolio} />);

    await screen.findByText('UNKNOWN');
    fireEvent.click(screen.getByRole('button', { name: 'country' }));
    await waitFor(() => expect(screen.getByRole('columnheader', { name: 'country' })).toBeTruthy());
    expect(calls.map((c) => c.path)).toEqual([
      '/v1/portfolios/p1/exposure?dimension=sector',
      '/v1/portfolios/p1/exposure?dimension=country',
    ]);
  });
});
