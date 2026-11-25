// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ExposureResponse, PerformanceResponse } from '../../api';
import { mockApi } from '../../test/mockApi';
import { Summary } from './Summary';

const portfolio = { id: 'p1', name: 'Long term', type: 'taxable', base_currency: 'EUR' };

function exposure(over: Partial<ExposureResponse['data']> = {}, gaps: ExposureResponse['gaps'] = []): ExposureResponse {
  return {
    data: {
      dimension: 'sector',
      total_value_base: '123456789.125',
      base_currency: 'EUR',
      slices: [
        { key: 'Technology', weight: '0.55', marketValueBase: '1' },
        { key: 'UNKNOWN', weight: '0.30', marketValueBase: '1' },
      ],
      weights: [],
      look_through: [
        { securityId: 's1', label: 'Apple Inc.', weight: '0.4123456789012345678901234', viaDirect: '0.3', viaFunds: '0.1123456789012345678901234' },
        { securityId: null, label: 'Unknown (no holdings data)', weight: '0.25', viaDirect: '0', viaFunds: '0.25' },
      ],
      concentration: {
        topN: [{ securityId: 's1', label: 'Apple Inc.', weight: '0.4123456789012345678901234' }],
        hhi: '0.5',
        effectiveN: '2',
        nominalN: 2,
      },
      cash_weight: '0.15',
      ...over,
    },
    provenance: { engineVersion: '1.1.0', inputHash: 'abcdef0123456789', methodology: 'exposure.v1' },
    gaps,
    staleness: { prices_as_of: '2026-11-10', fx_as_of: null, holdings_as_of: '2026-09-30' },
  };
}

const performance = (over: Partial<NonNullable<PerformanceResponse['data']>> = {}, gaps: PerformanceResponse['gaps'] = []): PerformanceResponse => ({
  data: { window: { from: '2026-01-02', to: '2026-11-10' }, twr: '0.08765', mwr: '0.07', ...over },
  provenance: { engineVersion: '1.1.0', inputHash: '0123456789abcdef', methodology: 'performance.v1' },
  gaps,
  staleness: { prices_as_of: '2026-11-10' },
});

const kpi = (label: RegExp) => screen.getByRole('heading', { name: label }).closest('li')!;
const value = (label: RegExp) => kpi(label).querySelector('.kpi-value')!.textContent;

describe('Summary', () => {
  it('shows the four figures from the engine response, formatted only, and two plain sentences', async () => {
    const calls = mockApi({
      'GET /v1/portfolios/p1/exposure': exposure({}, [{ component: 'lookthrough', reason: 'Fund XYZ has no holdings breakdown' }]),
      'GET /v1/portfolios/p1/performance': performance(),
    });
    render(<Summary portfolio={portfolio} />);

    await waitFor(() => expect(value(/Total value/)).toBe('123,456,789.13 EUR'));
    expect(screen.getByRole('heading', { name: 'Total value (EUR)' })).toBeTruthy();
    await waitFor(() => expect(value(/Period return/)).toBe('8.77%'));
    expect(kpi(/Period return/).textContent).toContain('2 Jan 2026 → 10 Nov 2026');
    // High-precision weight: rounded on the string, not through a float.
    expect(value(/Largest holding/)).toBe('41.23%');
    expect(kpi(/Largest holding/).textContent).toContain('Apple Inc.');
    // Unknown = the engine's explicit look-through row, not the sector UNKNOWN bucket (30 %).
    expect(value(/Unknown/)).toBe('25.00%');
    expect(kpi(/Unknown/).textContent).toContain('Held in funds without holdings data.');
    expect(kpi(/Unknown/).textContent).toContain('Sector not classified: 30.00%');
    expect(kpi(/Unknown/).textContent).toContain('Fund holdings as of 30 Sep 2026');

    expect(screen.getByTestId('summary-text').textContent).toBe(
      'Apple Inc. is the largest underlying holding at 41.23% of the portfolio; 25.00% sits in funds without ' +
        'holdings data and is shown as unknown, not spread across other names. ' +
        'From 2 Jan 2026 to 10 Nov 2026 the time-weighted return was 8.77%.',
    );
    expect(screen.getByLabelText('Data gaps').textContent).toBe('Data gap Fund XYZ has no holdings breakdown');
    // Provenance reachable from each figure.
    expect(within(kpi(/Unknown/)).getByText('look_through[securityId = null].weight')).toBeTruthy();
    expect(kpi(/Total value/).querySelector('.provenance')!.textContent).toBe(
      'field total_value_base · engine 1.1.0 · exposure.v1 · inputs abcdef012345… · prices as of 10 Nov 2026 · holdings as of 30 Sep 2026',
    );
    expect(kpi(/Period return/).querySelector('.provenance')!.textContent).toContain('performance.v1 · inputs 0123456789ab…');
    // Each "Source" disclosure has its own accessible name.
    expect([...document.querySelectorAll('summary')].map((el) => el.textContent)).toEqual([
      'Source of Total value (EUR)',
      'Source of Period return (TWR)',
      'Source of Largest holding (% of total)',
      'Source of Unknown (% of total)',
    ]);
    expect(calls.map((c) => c.path).sort()).toEqual([
      '/v1/portfolios/p1/exposure?dimension=sector',
      '/v1/portfolios/p1/performance?method=both',
    ]);
  });

  it('keeps a real zero as zero and an empty top-N as no claim', async () => {
    mockApi({
      'GET /v1/portfolios/p1/exposure': exposure({
        total_value_base: '0',
        slices: [],
        look_through: [],
        concentration: { topN: [], hhi: '0', effectiveN: '0', nominalN: 0 },
        cash_weight: '0',
      }),
      'GET /v1/portfolios/p1/performance': performance({ twr: '0' }),
    });
    render(<Summary portfolio={portfolio} />);

    await waitFor(() => expect(value(/Total value/)).toBe('0.00 EUR'));
    await waitFor(() => expect(value(/Period return/)).toBe('0.00%'));
    expect(value(/Largest holding/)).toBe('—');
    expect(kpi(/Largest holding/).textContent).toContain('No single names valued yet.');
    // Nothing valued: no unknown share to report, not a claimed 0 %.
    expect(value(/Unknown/)).toBe('—');
    expect(kpi(/Unknown/).textContent).toContain('Nothing valued yet.');
    expect(screen.getByTestId('summary-text').textContent).toContain('Nothing is valued yet');
  });

  it('reports zero unknown when the engine emits no unknown row in a valued portfolio', async () => {
    mockApi({
      'GET /v1/portfolios/p1/exposure': exposure({
        look_through: [{ securityId: 's1', label: 'Apple Inc.', weight: '0.85', viaDirect: '0.85', viaFunds: '0' }],
        slices: [{ key: 'Technology', weight: '0.85', marketValueBase: '1' }],
      }),
      'GET /v1/portfolios/p1/performance': performance(),
    });
    render(<Summary portfolio={portfolio} />);

    await waitFor(() => expect(value(/Unknown/)).toBe('0.00%'));
    expect(kpi(/Unknown/).textContent).toContain('Every fund’s holdings are known.');
    expect(kpi(/Unknown/).textContent).not.toContain('Sector not classified');
    expect(screen.getByTestId('summary-text').textContent).toContain('no share is unknown');
  });

  it('keeps a null TWR missing with its ADR-001 gap (unfunded purchases), never 0 %', async () => {
    const reason =
      'TWR and drawdown undefined: positions were held with negative cash (purchases without recorded deposits); ' +
      'record the deposits that funded them (ADR-001)';
    mockApi({
      'GET /v1/portfolios/p1/exposure': exposure(),
      'GET /v1/portfolios/p1/performance': performance({ twr: null, max_drawdown: null }, [
        { component: 'performance', reason: 'cash went negative while holding positions' },
        { component: 'performance', reason },
      ]),
    });
    render(<Summary portfolio={portfolio} />);

    await waitFor(() => expect(kpi(/Period return/).textContent).toContain(reason));
    expect(value(/Period return/)).toBe('—');
    expect(kpi(/Period return/).textContent).toContain('Data gap');
    expect(screen.getByTestId('summary-text').textContent).toContain(
      'No time-weighted return is shown for 2 Jan 2026 to 10 Nov 2026 because of a data gap (see below).',
    );
    expect(screen.getByLabelText('Data gaps').textContent).toContain(reason);
  });

  it('shows the no-history state of performance with its gap', async () => {
    mockApi({
      'GET /v1/portfolios/p1/exposure': exposure(),
      'GET /v1/portfolios/p1/performance': {
        data: null,
        gaps: [{ component: 'performance', reason: 'insufficient history: need transactions and at least 2 daily valuations' }],
        staleness: { prices_as_of: null },
      },
    });
    render(<Summary portfolio={portfolio} />);

    await waitFor(() => expect(kpi(/Period return/).textContent).toContain('Not enough history yet.'));
    expect(value(/Period return/)).toBe('—');
    expect(screen.getByTestId('summary-text').textContent).toContain('There is not enough history yet to measure a return.');
    expect(screen.getByLabelText('Data gaps').textContent).toContain('insufficient history');
  });

  it('still shows exposure when performance fails, and recovers on retry', async () => {
    let fail = true;
    mockApi({
      'GET /v1/portfolios/p1/exposure': exposure(),
      'GET /v1/portfolios/p1/performance': () =>
        fail
          ? { status: 500, body: { type: 'about:blank', title: 'Internal error', status: 500, trace_id: 'tr-42' } }
          : { body: performance() },
    });
    render(<Summary portfolio={portfolio} />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not load performance: Internal error');
    expect(alert.textContent).toContain('trace tr-42');
    await waitFor(() => expect(value(/Total value/)).toBe('123,456,789.13 EUR'));
    expect(value(/Period return/)).toBe('—');

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry performance' }));
    await waitFor(() => expect(value(/Period return/)).toBe('8.77%'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows loading, then the error with retry when exposure fails', async () => {
    let fail = true;
    mockApi({
      'GET /v1/portfolios/p1/exposure': () =>
        fail ? { status: 503, body: { type: 'x', title: 'Service unavailable', status: 503, trace_id: 't1' } } : { body: exposure() },
      'GET /v1/portfolios/p1/performance': performance(),
    });
    render(<Summary portfolio={portfolio} />);
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);

    expect((await screen.findByRole('alert')).textContent).toContain('Could not load exposure: Service unavailable');
    await waitFor(() => expect(value(/Period return/)).toBe('8.77%'));
    expect(value(/Total value/)).toBe('—');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry exposure' }));
    await waitFor(() => expect(value(/Total value/)).toBe('123,456,789.13 EUR'));
  });

  it('never shows a late response of the previous portfolio after switching', async () => {
    const pending: Record<string, (r: Response) => void> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (input: string) =>
          new Promise<Response>((resolve) => {
            pending[input] = resolve;
          }),
      ),
    );
    const other = { id: 'p2', name: 'Pension', type: 'pension', base_currency: 'USD' };
    const { rerender } = render(<Summary portfolio={portfolio} />);
    rerender(<Summary portfolio={other} />);

    const respond = async (path: string, body: unknown) =>
      act(async () => {
        pending[path](new Response(JSON.stringify(body), { status: 200 }));
      });
    // p2 answers first, then the stale p1 answers arrive.
    await respond('/v1/portfolios/p2/exposure?dimension=sector', exposure({ total_value_base: '200', base_currency: 'USD' }));
    await respond('/v1/portfolios/p2/performance?method=both', performance({ twr: '0.02' }));
    await respond('/v1/portfolios/p1/exposure?dimension=sector', exposure());
    await respond('/v1/portfolios/p1/performance?method=both', performance());

    expect(value(/Total value/)).toBe('200.00 USD');
    expect(value(/Period return/)).toBe('2.00%');
  });
});
