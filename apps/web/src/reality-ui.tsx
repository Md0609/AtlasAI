/**
 * Portfolio Reality Check surface (F-09, §14.3): top-3 surprises, the rest
 * one click away, honest warnings and gaps, provenance footer. Used in
 * onboarding (the aha, D-002) and as a portfolio tab.
 */
import { useState } from 'react';
import { api, type Portfolio, type RealityCheckResponse } from './api';
import { useResource } from './use-resource';
import { EmptyState, ErrorState, LoadingState } from './states';
import { Glossed, Term } from './register';

const pctNum = (w: string) => `${(Number(w) * 100).toFixed(1)}%`;

export function RealityCheck({
  portfolio,
  onAddHoldings,
}: {
  portfolio: Portfolio;
  onAddHoldings?: () => void;
}) {
  const [showOthers, setShowOthers] = useState(false);
  const { data: resp, loading, error, reload } = useResource<RealityCheckResponse>(
    () => api.get<RealityCheckResponse>(`/v1/portfolios/${portfolio.id}/reality-check`),
    [portfolio.id],
  );

  if (loading) return <div className="card"><LoadingState label="Computing your Reality Check…" /></div>;
  if (error) return <div className="card"><ErrorState message={error} onRetry={reload} /></div>;
  if (!resp) return null;
  const d = resp.data;

  // Nothing to analyse. Atlas must NOT claim to have checked anything — it
  // hasn't. Say what is missing and what to do about it.
  if (Number(d.total_value_base) <= 0) {
    return (
      <div className="card">
        <EmptyState
          title="Not enough to work with yet"
          action={
            onAddHoldings && (
              <button onClick={onAddHoldings}>Add your holdings</button>
            )
          }
        >
          The Reality Check compares what you think you own against what you actually own. It needs
          holdings with a current value before it can tell you anything true.
        </EmptyState>
      </div>
    );
  }

  // Real holdings, nothing surprising. This claim is now true, and it names
  // only the checks that actually ran.
  if (d.top.length === 0) {
    return (
      <div className="card">
        <h3>Your portfolio is what you think it is.</h3>
        <p className="muted">
          Atlas checked your <Term k="look-through">look-through</Term> exposure, your{' '}
          <Term k="concentration">concentration</Term>, your currency mix and any{' '}
          <Term k="correlation cluster">correlation clusters</Term> — and found nothing that should
          surprise you. That is a result, not an empty page.
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
            <p><Glossed text={s.body} /></p>
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
            <h4><Term k="correlation cluster">Correlation clusters</Term></h4>
            <table className="responsive">
              <thead><tr><th>Members</th><th>Weight</th><th>Min pair corr.</th></tr></thead>
              <tbody>
                {d.correlation.clusters.map((c, i) => (
                  <tr key={i}>
                    <td data-label="Members">{c.members.map((m) => m.label).join(', ')}</td>
                    <td data-label="Weight">{pctNum(c.weight)}</td>
                    <td data-label="Min pair corr.">{Number(c.minPairCorrelation).toFixed(2)}</td>
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
