/**
 * Portfolio Reality Check surface (F-09, §14.3): top-3 surprises, the rest
 * one click away, honest warnings and gaps, provenance footer. Used in
 * onboarding (the aha, D-002) and as a portfolio tab.
 */
import { useEffect, useState } from 'react';
import { api, type Portfolio, type RealityCheckResponse } from './api';

const pctNum = (w: string) => `${(Number(w) * 100).toFixed(1)}%`;

export function RealityCheck({ portfolio }: { portfolio: Portfolio }) {
  const [resp, setResp] = useState<RealityCheckResponse | null>(null);
  const [showOthers, setShowOthers] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api
      .get<RealityCheckResponse>(`/v1/portfolios/${portfolio.id}/reality-check`)
      .then(setResp)
      .catch(() => setFailed(true));
  }, [portfolio.id]);

  if (failed) return <div className="card error">The Reality Check could not be computed.</div>;
  if (!resp) return <div className="card muted">Computing…</div>;
  const d = resp.data;

  if (d.top.length === 0) {
    return (
      <div className="card">
        <h3>Your portfolio is what you think it is.</h3>
        <p className="muted">
          Atlas checked look-through exposure, effective diversification, currency exposure,
          correlation clusters and strategy fit — and found nothing you probably didn't already know.
          That is a good result, not an empty one.
        </p>
        {resp.warnings.map((w, i) => <div key={i} className="gaps">⚠ {w}</div>)}
      </div>
    );
  }

  return (
    <div>
      <div className="card">
        <h3>Your portfolio isn't quite what you think it is.</h3>
        {d.top.map((s) => (
          <div key={s.kind} className="surprise">
            <h4>{s.headline}</h4>
            <p>{s.body}</p>
          </div>
        ))}
        {d.others.length > 0 && (
          <div>
            <button className="link" onClick={() => setShowOthers(!showOthers)}>
              {showOthers ? 'Hide' : `${d.others.length} more observation(s) →`}
            </button>
            {showOthers && (
              <ul className="plain">
                {d.others.map((o) => <li key={o.kind}>· {o.headline}</li>)}
              </ul>
            )}
          </div>
        )}
        {resp.warnings.map((w, i) => <div key={i} className="gaps">⚠ {w}</div>)}
        {resp.gaps.map((g, i) => <div key={i} className="gaps">⚠ {g.reason}</div>)}
        {d.correlation.clusters.length > 0 && (
          <>
            <h4>Correlation clusters</h4>
            <table>
              <thead><tr><th>Members</th><th>Weight</th><th>Min pair corr.</th></tr></thead>
              <tbody>
                {d.correlation.clusters.map((c, i) => (
                  <tr key={i}>
                    <td>{c.members.map((m) => m.label).join(', ')}</td>
                    <td>{pctNum(c.weight)}</td>
                    <td>{Number(c.minPairCorrelation).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <p className="provenance">
          engine {resp.provenance.engineVersion} · {resp.provenance.methodology} · inputs{' '}
          {resp.provenance.inputHash.slice(0, 12)}… · prices as of {resp.staleness.prices_as_of ?? '—'} ·
          holdings as of {resp.staleness.holdings_as_of ?? '—'}
        </p>
      </div>
    </div>
  );
}
