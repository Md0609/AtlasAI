/**
 * Thesis Ledger UI (§61.2): write what you believe and what would prove you
 * wrong; Atlas builds the radar silently and says so (§16.4). Editing is
 * impossible — superseding shows both versions, forever.
 */
import { useEffect, useState } from 'react';
import { api, ApiError, type PositionRow, type Portfolio, type Thesis } from './api';
import { describeError } from './use-resource';
import { DateText } from './primitives';
import {
  ConditionBuilder,
  buildAst,
  defaultBuilderValue,
  type BuilderValue,
} from './condition-builder';

export function ThesisPanel({ portfolio }: { portfolio: Portfolio }) {
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [theses, setTheses] = useState<Thesis[]>([]);
  const [showClosed, setShowClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createFor, setCreateFor] = useState<{ securityId: string; name: string; supersedes?: string } | null>(null);

  const refresh = () =>
    Promise.all([
      api
        .get<{ data: { positions: PositionRow[] } }>(`/v1/portfolios/${portfolio.id}/positions`)
        .then((r) => setPositions(r.data.positions)),
      api
        .get<{ data: Thesis[] }>(`/v1/theses?include_closed=${showClosed}`)
        .then((r) => setTheses(r.data)),
    ]).catch((e) => setError(describeError(e)));
  useEffect(() => {
    refresh();
  }, [portfolio.id, showClosed]);

  const byTicker = new Map(theses.map((t) => [t.security_id, t]));
  const withoutThesis = positions.filter(
    (p) => !theses.some((t) => t.security_id === p.security_id && t.status === 'active'),
  );

  return (
    <div>
      <div className="card">
        <div className="rule-head">
          <h3>Thesis Ledger</h3>
          <button className="link" onClick={() => setShowClosed(!showClosed)}>
            {showClosed ? 'Active only' : 'Show closed versions'}
          </button>
        </div>
        {theses.length === 0 && (
          <p className="muted">
            No theses yet. A thesis is one sentence about why you own something — plus, if you're
            willing, the condition that would prove you wrong. Atlas watches that condition forever,
            for free.
          </p>
        )}
        {theses.map((t) => (
          <div key={t.id} className={`thesis status-${t.status}`}>
            <div className="rule-head">
              <strong>
                {t.security_name} <span className="muted">v{t.version} · {t.status}</span>
              </strong>
              <span className="muted"><DateText iso={t.created_at} />{t.stale ? ' · ⚠ over 12 months old' : ''}</span>
            </div>
            <blockquote>“{t.statement}”</blockquote>
            {t.status_reason && <div className="muted">Closed: {t.status_reason}</div>}
            <ul className="plain">
              {t.conditions.map((c) => (
                <li key={c.id}>
                  {c.status === 'met' ? '⚑' : '👁'} “{c.condition_nl}”{' '}
                  <span className="muted">
                    ({c.rendered})
                    {c.status === 'met' ? <> — met <DateText iso={c.met_at} /></> : ''}
                  </span>
                </li>
              ))}
            </ul>
            {t.status === 'active' && (
              <button
                className="link"
                onClick={() => setCreateFor({ securityId: t.security_id, name: t.security_name, supersedes: t.id })}
              >
                Supersede (record what changed) →
              </button>
            )}
          </div>
        ))}
      </div>

      {withoutThesis.length > 0 && !createFor && (
        <div className="card">
          <h3>Positions without a thesis</h3>
          <p className="muted">Asked once, never nagged (FR-4.5).</p>
          <ul className="plain">
            {withoutThesis.map((p) => (
              <li key={p.security_id}>
                {p.name}{' '}
                <button
                  className="link"
                  onClick={() => setCreateFor({ securityId: p.security_id, name: p.name })}
                >
                  Write a thesis →
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {createFor && (
        <ThesisForm
          securityId={createFor.securityId}
          securityName={createFor.name}
          supersedes={createFor.supersedes}
          onDone={() => {
            setCreateFor(null);
            refresh();
          }}
          onCancel={() => setCreateFor(null)}
          onError={setError}
        />
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function ThesisForm({
  securityId,
  securityName,
  supersedes,
  onDone,
  onCancel,
  onError,
}: {
  securityId: string;
  securityName: string;
  supersedes?: string;
  onDone: () => void;
  onCancel: () => void;
  onError: (e: string) => void;
}) {
  const [statement, setStatement] = useState('');
  const [changeReason, setChangeReason] = useState('');
  const [withCondition, setWithCondition] = useState(true);
  const [conditionNl, setConditionNl] = useState('');
  const [builder, setBuilder] = useState<BuilderValue>(defaultBuilderValue);
  const [created, setCreated] = useState<{ message: string; radars: Array<{ rendered: string; current: { value: string | null; met: boolean | null } }> } | null>(null);

  const submit = async () => {
    const ast = withCondition ? buildAst(builder, securityId) : null;
    if (withCondition && !ast) {
      onError('The condition needs a numeric value.');
      return;
    }
    try {
      const res = await api.post<{
        data: { message: string; radars_created: Array<{ rendered: string; current: { value: string | null; met: boolean | null } }> };
      }>('/v1/theses', {
        security_id: securityId,
        statement,
        ...(supersedes ? { supersedes_id: supersedes, change_reason: changeReason || 'superseded' } : {}),
        conditions:
          withCondition && ast ? [{ condition_nl: conditionNl, condition: ast }] : [],
      });
      setCreated({ message: res.data.message, radars: res.data.radars_created });
    } catch (e) {
      onError(e instanceof ApiError ? e.problem.detail ?? e.problem.title : String(e));
    }
  };

  if (created) {
    return (
      <div className="card">
        <h3>Thesis saved.</h3>
        <p>{created.message}</p>
        {created.radars.map((r, i) => (
          <p key={i} className="muted">
            Watching: {r.rendered} · currently {r.current.value ?? '—'}
            {r.current.met ? ' — heads up: this condition is already met today' : ''}
          </p>
        ))}
        <button onClick={onDone}>Done</button>
      </div>
    );
  }

  return (
    <div className="card">
      <h3>{supersedes ? `New version of your ${securityName} thesis` : `Why do you own ${securityName}?`}</h3>
      <label>
        Your thesis, in your own words
        <textarea
          rows={3}
          placeholder="e.g. Services revenue makes this a compounder; the moat is the install base."
          value={statement}
          onChange={(e) => setStatement(e.target.value)}
        />
      </label>
      {supersedes && (
        <label>
          What changed since the last version?
          <input value={changeReason} onChange={(e) => setChangeReason(e.target.value)} />
        </label>
      )}
      <label className="option">
        <input type="checkbox" checked={withCondition} onChange={(e) => setWithCondition(e.target.checked)} />{' '}
        Add the condition that would prove you wrong (Atlas watches it forever, for free)
      </label>
      {withCondition && (
        <>
          <label>
            The condition, in your words
            <input
              placeholder='e.g. "Wrong if the price closes below 150"'
              value={conditionNl}
              onChange={(e) => setConditionNl(e.target.value)}
            />
          </label>
          <ConditionBuilder value={builder} onChange={setBuilder} allowPortfolioMetrics={false} />
        </>
      )}
      <div className="inline">
        <button
          onClick={submit}
          disabled={statement.trim().length === 0 || (withCondition && conditionNl.trim().length === 0)}
        >
          Save thesis
        </button>
        <button className="link" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
