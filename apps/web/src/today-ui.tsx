/**
 * Today (§13): "Do I need to think about anything?" — the one thing, the
 * brief list, and a quiet state that is a designed positive assertion, not
 * an empty page. Decision buttons on a C0 brief are the §6.2 four buttons;
 * every choice records a decision with a reason (inaction included, §6.3).
 */
import { useEffect, useState } from 'react';
import { api, ApiError, type Brief, type Suppression } from './api';

export function TodayView() {
  const [briefs, setBriefs] = useState<Brief[]>([]);
  const [suppressions, setSuppressions] = useState<Suppression[]>([]);
  const [showSuppressed, setShowSuppressed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    Promise.all([
      api.get<{ data: Brief[] }>('/v1/briefs').then((r) => setBriefs(r.data)),
      api.get<{ data: Suppression[] }>('/v1/suppressions').then((r) => setSuppressions(r.data)),
    ]).catch(() => {});
  useEffect(() => {
    refresh();
  }, []);

  const unread = briefs.filter((b) => !b.read_at);
  const theOne = unread[0] ?? null;
  const rest = briefs.filter((b) => b.id !== theOne?.id);

  return (
    <div>
      {briefs.length === 0 && (
        <div className="card quiet">
          <h3>Nothing needs your attention today.</h3>
          <p className="muted">
            Atlas is watching your rules, your radars and your thesis conditions. When one of the
            conditions you set is met, it will tell you — once, plainly, with the numbers.
          </p>
        </div>
      )}

      {theOne && (
        <BriefCard
          brief={theOne}
          hero
          onDone={refresh}
          onError={(e) => setError(e)}
        />
      )}

      {rest.length > 0 && (
        <div className="card">
          <h3>Briefs</h3>
          {rest.map((b) => (
            <BriefCard key={b.id} brief={b} onDone={refresh} onError={(e) => setError(e)} />
          ))}
        </div>
      )}

      {error && <div className="error">{error}</div>}

      {suppressions.length > 0 && (
        <div className="card">
          <button className="link" onClick={() => setShowSuppressed(!showSuppressed)}>
            {showSuppressed ? 'Hide' : `What Atlas didn't send (${suppressions.length}) →`}
          </button>
          {showSuppressed && (
            <ul className="plain">
              {suppressions.map((s) => (
                <li key={s.id}>
                  · {s.headline ?? s.class} <span className="muted">— {s.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function BriefCard({
  brief,
  hero,
  onDone,
  onError,
}: {
  brief: Brief;
  hero?: boolean;
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const [deciding, setDeciding] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const markRead = () => api.patch(`/v1/briefs/${brief.id}`, {}).then(onDone);

  const decide = async (action: string) => {
    try {
      await api.post('/v1/decisions', {
        action,
        brief_id: brief.id,
        thesis_id: brief.thesis_id ?? undefined,
        security_id: brief.security_id ?? undefined,
        reason,
      });
      if (action === 'mark_thesis_broken' && brief.thesis_id) {
        await api.post(`/v1/theses/${brief.thesis_id}/status`, { status: 'falsified', reason });
      }
      await api.patch(`/v1/briefs/${brief.id}`, {});
      setDeciding(null);
      setReason('');
      onDone();
    } catch (e) {
      onError(e instanceof ApiError ? e.problem.detail ?? e.problem.title : String(e));
    }
  };

  const isThesisBrief = brief.class === 'C0' && brief.thesis_id;

  return (
    <div className={`brief tone-${brief.tone} ${hero ? 'hero' : ''} ${brief.read_at ? 'read' : ''}`}>
      <div className="rule-head">
        <h4>{brief.headline}</h4>
        <span className="muted">{brief.class}</span>
      </div>
      <p className="brief-body">{brief.body}</p>
      {isThesisBrief && !brief.read_at ? (
        deciding ? (
          <div>
            <input
              placeholder={
                deciding === 'no_change'
                  ? 'Why does nothing change? Your future self will read this.'
                  : 'One line for the record — your future self will read it.'
              }
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <div className="inline">
              <button disabled={reason.trim().length === 0} onClick={() => decide(deciding)}>
                Record decision
              </button>
              <button className="link" onClick={() => setDeciding(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="inline brief-actions">
            <button className="tab" onClick={() => setDeciding('update_thesis')}>Update thesis</button>
            <button className="tab" onClick={() => setDeciding('mark_thesis_broken')}>Mark thesis broken</button>
            <button className="tab" onClick={() => setDeciding('no_change')}>No change — here's why</button>
            <button className="tab" onClick={() => setDeciding('snooze')}>Snooze</button>
          </div>
        )
      ) : (
        !brief.read_at && (
          <button className="link" onClick={markRead}>Mark read</button>
        )
      )}
    </div>
  );
}
