/**
 * Radar (§16): standing conditions, deterministically evaluated. Distance-
 * to-your-condition is the number that matters (§15.3) — shown per radar
 * from last_observed. Paused radars surface their auto-suppression reason
 * with one-click resume (§16.5).
 */
import { useEffect, useState } from 'react';
import { api, ApiError, type Radar, type RadarFire, type SecurityHit } from './api';
import { describeError } from './use-resource';
import {
  ConditionBuilder,
  buildAst,
  defaultBuilderValue,
  type BuilderValue,
} from './condition-builder';

export function RadarPanel() {
  const [radars, setRadars] = useState<Radar[]>([]);
  const [fires, setFires] = useState<RadarFire[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    Promise.all([
      api.get<{ data: Radar[] }>('/v1/radars').then((r) => setRadars(r.data)),
      api.get<{ data: RadarFire[] }>('/v1/radar-fires').then((r) => setFires(r.data)),
    ]).catch((e) => setError(describeError(e)));
  useEffect(() => {
    refresh();
  }, []);

  const resume = (id: string) =>
    api.post(`/v1/radars/${id}/resume`).then(refresh).catch((e) => setError(describeError(e)));
  const archive = (id: string) => api.del(`/v1/radars/${id}`).then(refresh).catch((e) => setError(describeError(e)));

  return (
    <div>
      <div className="card">
        <div className="rule-head">
          <h3>Radars</h3>
          <button className="link" onClick={() => setCreating(!creating)}>
            {creating ? 'Cancel' : '+ New radar'}
          </button>
        </div>
        <p className="muted">
          A radar is a condition Atlas watches for you. The firing decision is arithmetic, never a
          model — it runs even when everything else is down.
        </p>
        {creating && (
          <RadarForm
            onDone={() => {
              setCreating(false);
              refresh();
            }}
            onError={setError}
          />
        )}
        {radars.length === 0 && !creating && <p className="muted">No radars yet.</p>}
        {radars.map((r) => (
          <div key={r.id} className={`rule ${r.status === 'paused' ? 'breach' : ''}`}>
            <div className="rule-head">
              <strong>
                {r.name} {r.security_name && <span className="muted">· {r.security_name}</span>}
                {r.source === 'thesis' && <span className="muted"> · from your thesis</span>}
              </strong>
              <span className={r.status === 'paused' ? 'status-breach' : 'status-ok'}>{r.status}</span>
            </div>
            <div className="muted">
              “{r.condition_nl}” — {r.rendered}
              {r.last_observed?.value != null && r.last_observed?.target != null && (
                <> · now {Number(r.last_observed.value).toFixed(2)} vs {Number(r.last_observed.target).toFixed(2)}</>
              )}
              {r.last_observed?.gap && <> · ⚠ {r.last_observed.gap}</>}
              {r.fire_count > 0 && <> · fired {r.fire_count}×</>}
            </div>
            {r.status === 'paused' && (
              <div>
                <span className="muted">{r.paused_reason}</span>{' '}
                <button className="link" onClick={() => resume(r.id)}>Resume</button>
              </div>
            )}
            {r.source === 'manual' && r.status !== 'archived' && (
              <button className="link" onClick={() => archive(r.id)}>Archive</button>
            )}
          </div>
        ))}
        {error && <div className="error">{error}</div>}
      </div>

      <div className="card">
        <h3>Fired history</h3>
        {fires.length === 0 ? (
          <p className="muted">Nothing has fired. Silence is the normal state.</p>
        ) : (
          <table>
            <thead><tr><th>When</th><th>Radar</th><th>Observed</th></tr></thead>
            <tbody>
              {fires.map((f) => (
                <tr key={f.id}>
                  <td>{String(f.fired_at).slice(0, 10)}</td>
                  <td>{f.radar_name}</td>
                  <td>
                    {f.observed.value ?? '—'} vs {f.observed.target ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function RadarForm({ onDone, onError }: { onDone: () => void; onError: (e: string) => void }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SecurityHit[]>([]);
  const [security, setSecurity] = useState<SecurityHit | null>(null);
  const [name, setName] = useState('');
  const [conditionNl, setConditionNl] = useState('');
  const [builder, setBuilder] = useState<BuilderValue>(defaultBuilderValue);
  const [confirm, setConfirm] = useState<{ rendered: string; current: { value: string | null; met: boolean | null } } | null>(null);

  useEffect(() => {
    if (query.trim().length < 1 || security) return;
    const t = setTimeout(
      () =>
        api
          .get<{ data: SecurityHit[] }>(`/v1/securities?query=${encodeURIComponent(query)}`)
          .then((r) => setHits(r.data))
          .catch((e) => onError(describeError(e))),
      200,
    );
    return () => clearTimeout(t);
  }, [query, security]);

  const needsSecurity = builder.metricKind !== 'portfolio.cash_weight';

  const submit = async () => {
    const ast = buildAst(builder, security?.id ?? '');
    if (!ast || (needsSecurity && !security)) {
      onError('Pick a security and a numeric target.');
      return;
    }
    try {
      const res = await api.post<{ data: { rendered: string; current: { value: string | null; met: boolean | null } } }>(
        '/v1/radars',
        {
          name: name || conditionNl.slice(0, 60),
          ...(needsSecurity && security ? { security_id: security.id } : {}),
          condition_nl: conditionNl,
          condition: ast,
        },
      );
      setConfirm(res.data);
    } catch (e) {
      onError(e instanceof ApiError ? e.problem.detail ?? e.problem.title : String(e));
    }
  };

  if (confirm) {
    return (
      <div className="card inner">
        <h4>Radar armed.</h4>
        <p>
          Watching: {confirm.rendered} · currently {confirm.current.value ?? '—'}
          {confirm.current.met ? ' — note: the condition is already met today; it fires on the next crossing' : ''}
        </p>
        <button onClick={onDone}>Done</button>
      </div>
    );
  }

  return (
    <div className="card inner">
      {needsSecurity && (
        <label>
          Security
          {security ? (
            <div className="inline">
              <span>{security.name} ({security.ticker})</span>
              <button className="link" onClick={() => setSecurity(null)}>change</button>
            </div>
          ) : (
            <>
              <input placeholder="Search name or ticker" value={query} onChange={(e) => setQuery(e.target.value)} />
              {hits.length > 0 && (
                <ul className="plain">
                  {hits.slice(0, 6).map((h) => (
                    <li key={h.id}>
                      <button className="link" onClick={() => { setSecurity(h); setHits([]); }}>
                        {h.name} ({h.ticker} · {h.exchange})
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </label>
      )}
      <label>
        What are you watching for, in your words?
        <input
          placeholder='e.g. "Tell me if ASML gets below its own 1-year median"'
          value={conditionNl}
          onChange={(e) => setConditionNl(e.target.value)}
        />
      </label>
      <label>
        Name (optional)
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <ConditionBuilder value={builder} onChange={setBuilder} allowPortfolioMetrics />
      <button onClick={submit} disabled={conditionNl.trim().length === 0}>
        Arm radar
      </button>
    </div>
  );
}
