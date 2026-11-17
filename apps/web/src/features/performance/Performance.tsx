import { useEffect, useState } from 'react';
import { api, type PerformanceResponse, type Portfolio } from '../../api';
import { Badge } from '../../components/Badge';
import { EmptyState } from '../../components/EmptyState';
import { Spinner } from '../../components/Spinner';
import { formatDate, formatPct } from '../../components/format';

export function Performance({ portfolio }: { portfolio: Portfolio }) {
  const [resp, setResp] = useState<PerformanceResponse | null>(null);
  useEffect(() => {
    api
      .get<PerformanceResponse>(`/v1/portfolios/${portfolio.id}/performance?method=both`)
      .then(setResp)
      .catch(() => setResp(null));
  }, [portfolio.id]);

  if (!resp) return <div className="card"><Spinner /></div>;
  if (!resp.data) {
    return (
      <div className="card">
        <EmptyState title="Not enough history yet." />
        {resp.gaps.map((g, i) => <div key={i} className="gaps"><Badge tone="warning">Data gap</Badge> {g.reason}</div>)}
      </div>
    );
  }
  const d = resp.data;
  return (
    <div className="card">
      <p className="muted">Window {formatDate(d.window?.from)} → {formatDate(d.window?.to)}</p>
      <table>
        <tbody>
          <tr><td>Time-weighted return (TWR)</td><td>{formatPct(d.twr, 3)}</td></tr>
          <tr><td>Money-weighted return (MWR / XIRR)</td><td>{formatPct(d.mwr, 3)}</td></tr>
          <tr><td>Max drawdown</td><td>{formatPct(d.max_drawdown)}</td></tr>
          <tr><td>Current drawdown</td><td>{formatPct(d.current_drawdown)}</td></tr>
        </tbody>
      </table>
      <h4>Local vs FX return (per pricing currency)</h4>
      <table>
        <thead><tr><th>Currency</th><th>Local return</th><th>FX return</th></tr></thead>
        <tbody>
          {(d.currency_decomposition ?? []).map((c) => (
            <tr key={c.currency}>
              <td>{c.currency}</td><td>{formatPct(c.localReturn, 3)}</td><td>{formatPct(c.fxReturn, 3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {resp.gaps.length > 0 && resp.gaps.map((g, i) => <div key={i} className="gaps"><Badge tone="warning">Data gap</Badge> {g.reason}</div>)}
    </div>
  );
}
