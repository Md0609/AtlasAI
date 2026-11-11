import { useEffect, useState } from 'react';
import { api, type ExposureResponse, type Portfolio } from '../../api';
import { num, pct } from '../../components/format';

export function Exposure({ portfolio }: { portfolio: Portfolio }) {
  const [dimension, setDimension] = useState<'sector' | 'country' | 'currency'>('sector');
  const [resp, setResp] = useState<ExposureResponse | null>(null);

  useEffect(() => {
    api
      .get<ExposureResponse>(`/v1/portfolios/${portfolio.id}/exposure?dimension=${dimension}`)
      .then(setResp)
      .catch(() => setResp(null));
  }, [portfolio.id, dimension]);

  if (!resp) return <div className="card muted">Loading…</div>;
  const d = resp.data;
  return (
    <div className="card">
      <div className="inline">
        {(['sector', 'country', 'currency'] as const).map((x) => (
          <button key={x} className={dimension === x ? 'tab active' : 'tab'} onClick={() => setDimension(x)}>{x}</button>
        ))}
      </div>
      <p>Total value: <strong>{num(d.total_value_base)} {d.base_currency}</strong> · cash {pct(d.cash_weight)}</p>
      <table>
        <thead><tr><th>{d.dimension}</th><th>Weight</th></tr></thead>
        <tbody>
          {d.slices.map((s) => (
            <tr key={s.key} className={s.key === 'UNKNOWN' ? 'unknown' : ''}>
              <td>{s.key}</td><td>{pct(s.weight)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>Look-through (single names)</h4>
      <table>
        <thead><tr><th>Name</th><th>Total</th><th>Direct</th><th>Via funds</th></tr></thead>
        <tbody>
          {d.look_through.map((r) => (
            <tr key={r.securityId ?? 'unknown'} className={r.securityId === null ? 'unknown' : ''}>
              <td>{r.label}</td><td>{pct(r.weight)}</td><td>{pct(r.viaDirect)}</td><td>{pct(r.viaFunds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">
        Concentration: HHI {Number(d.concentration.hhi).toFixed(3)} · effective N{' '}
        {Number(d.concentration.effectiveN).toFixed(2)} of {d.concentration.nominalN} names
      </p>
      {resp.gaps.length > 0 && (
        <div className="gaps">
          {resp.gaps.map((g, i) => <div key={i}>⚠ {g.reason}</div>)}
        </div>
      )}
      <p className="provenance">
        engine {resp.provenance.engineVersion} · {resp.provenance.methodology} · inputs{' '}
        {resp.provenance.inputHash.slice(0, 12)}… · prices as of {resp.staleness.prices_as_of ?? '—'} · holdings as of{' '}
        {resp.staleness.holdings_as_of ?? '—'}
      </p>
    </div>
  );
}
