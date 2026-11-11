import { useEffect, useState } from 'react';
import { api, type PerformanceResponse, type Portfolio } from '../../api';
import { pct } from '../../components/format';

export function Performance({ portfolio }: { portfolio: Portfolio }) {
  const [resp, setResp] = useState<PerformanceResponse | null>(null);
  useEffect(() => {
    api
      .get<PerformanceResponse>(`/v1/portfolios/${portfolio.id}/performance?method=both`)
      .then(setResp)
      .catch(() => setResp(null));
  }, [portfolio.id]);

  if (!resp) return <div className="card muted">Loading…</div>;
  if (!resp.data) {
    return (
      <div className="card">
        <p className="muted">Not enough history yet.</p>
        {resp.gaps.map((g, i) => <div key={i} className="gaps">⚠ {g.reason}</div>)}
      </div>
    );
  }
  const d = resp.data;
  return (
    <div className="card">
      <p className="muted">Window {d.window?.from} → {d.window?.to}</p>
      <table>
        <tbody>
          <tr><td>Time-weighted return (TWR)</td><td>{pct(d.twr, 3)}</td></tr>
          <tr><td>Money-weighted return (MWR / XIRR)</td><td>{pct(d.mwr, 3)}</td></tr>
          <tr><td>Max drawdown</td><td>{pct(d.max_drawdown)}</td></tr>
          <tr><td>Current drawdown</td><td>{pct(d.current_drawdown)}</td></tr>
        </tbody>
      </table>
      <h4>Local vs FX return (per pricing currency)</h4>
      <table>
        <thead><tr><th>Currency</th><th>Local return</th><th>FX return</th></tr></thead>
        <tbody>
          {(d.currency_decomposition ?? []).map((c) => (
            <tr key={c.currency}>
              <td>{c.currency}</td><td>{pct(c.localReturn, 3)}</td><td>{pct(c.fxReturn, 3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {resp.gaps.length > 0 && resp.gaps.map((g, i) => <div key={i} className="gaps">⚠ {g.reason}</div>)}
    </div>
  );
}
