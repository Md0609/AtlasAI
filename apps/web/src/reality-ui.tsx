/**
 * Portfolio Reality Check surface (F-09, §14.3): top-3 surprises, the rest
 * one click away, honest warnings and gaps, provenance footer. Used in
 * onboarding (the aha, D-002) and as a portfolio tab.
 *
 * The caveats are rendered OUTSIDE the branches on purpose (P0-3). Before this,
 * only the surprises branch showed warnings, gaps and provenance; the
 * no-surprise branch showed warnings alone, and the empty branch showed none —
 * while telling the user "Atlas checked your look-through exposure, your
 * concentration, your currency mix… and found nothing that should surprise
 * you." The branch that makes the strongest claim was the one hiding the
 * reasons to doubt it.
 *
 * Each branch now contributes only its own body. A future branch cannot omit
 * the caveats, because it never gets to decide.
 */
import { useState } from 'react';
import { api, type Portfolio, type RealityCheckResponse } from './api';
import { useResource } from './use-resource';
import { EmptyState, ErrorState } from './states';
import { Glossed, Term } from './register';
import { DateText, Skeleton, formatPct } from './primitives';

const pctNum = (w: string) => formatPct(w, 1);

/**
 * Everything that qualifies the answer: what could not be computed, what is
 * missing from the inputs, and where the numbers came from. Rendered on every
 * outcome, including the ones with nothing to report.
 */
function Caveats({ resp }: { resp: RealityCheckResponse }) {
  const narration = resp.provenance.narration;
  return (
    <>
      {resp.warnings.map((w, i) => (
        <div key={`w-${i}`} className="gaps">⚠ {w}</div>
      ))}
      {resp.gaps.map((g, i) => (
        <div key={`g-${i}`} className="gaps">⚠ {g.reason}</div>
      ))}
      {/* P1-10: the surprise bodies are narrated prose. Whether a model wrote
          them is a separate fact from whether the numbers are sound — every
          figure is engine-computed either way — and the user is entitled to
          both. Silent on the healthy path, for the reason given in
          copilot-ui's Provenance. */}
      {narration && !narration.generative && (
        <div className="muted small">
          {narration.degraded
            ? 'These observations are Atlas\u2019s own wording — the model was unavailable.'
            : 'These observations are Atlas\u2019s own wording, not a model\u2019s.'}
        </div>
      )}
      <p className="provenance">
        engine {resp.provenance.engineVersion} · {resp.provenance.methodology} · inputs{' '}
        {resp.provenance.inputHash.slice(0, 12)}… · prices as of{' '}
        <DateText iso={resp.staleness.prices_as_of} /> · holdings as of{' '}
        <DateText iso={resp.staleness.holdings_as_of} />
      </p>
    </>
  );
}

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

  if (loading) return <div className="card"><Skeleton title lines={4} /></div>;
  if (error) return <div className="card"><ErrorState message={error} onRetry={reload} /></div>;
  if (!resp) return null;
  const d = resp.data;

  // Nothing to analyse. Atlas must NOT claim to have checked anything — it
  // hasn't. Say what is missing and what to do about it.
  const body =
    Number(d.total_value_base) <= 0 ? (
      <EmptyState
        title="Not enough to work with yet"
        action={onAddHoldings && <button onClick={onAddHoldings}>Add your holdings</button>}
      >
        The Reality Check compares what you think you own against what you actually own. It needs
        holdings with a current value before it can tell you anything true.
      </EmptyState>
    ) : d.top.length === 0 ? (
      // Real holdings, nothing surprising. This claim is only true alongside
      // the caveats below it — which is why they are no longer optional.
      <>
        <h3>Your portfolio is what you think it is.</h3>
        <p className="muted">
          Atlas checked your <Term k="look-through">look-through</Term> exposure, your{' '}
          <Term k="concentration">concentration</Term>, your currency mix and any{' '}
          <Term k="correlation cluster">correlation clusters</Term> — and found nothing that should
          surprise you. That is a result, not an empty page.
        </p>
      </>
    ) : (
      <>
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
      </>
    );

  return (
    <div className="card">
      {body}
      <Caveats resp={resp} />
    </div>
  );
}
