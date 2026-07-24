/**
 * Today (§13): "Do I need to think about anything?" — the one thing, the
 * brief list, and a quiet state that is a designed positive assertion, not
 * an empty page. Decision buttons on a C0 brief are the §6.2 four buttons;
 * every choice records a decision with a reason (inaction included, §6.3).
 */
import { useState } from 'react';
import { api, ApiError, type Brief, type Suppression, type Today } from './api';
import { useResource } from './use-resource';
import { EmptyState, ErrorState, LoadingState } from './states';

interface TodayBundle {
  briefs: Brief[];
  suppressions: Suppression[];
  today: Today;
}

export function TodayView({ onAddHoldings }: { onAddHoldings?: () => void }) {
  const [showSuppressed, setShowSuppressed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, loading, error: loadError, reload } = useResource<TodayBundle>(
    async () => {
      const [b, s, t] = await Promise.all([
        api.get<{ data: Brief[] }>('/v1/briefs'),
        api.get<{ data: Suppression[] }>('/v1/suppressions'),
        api.get<{ data: Today }>('/v1/today'),
      ]);
      return { briefs: b.data, suppressions: s.data, today: t.data };
    },
    [],
  );

  if (loading) return <div className="card"><LoadingState /></div>;
  if (loadError) return <div className="card"><ErrorState message={loadError} onRetry={reload} /></div>;
  if (!data) return null;

  const { briefs, suppressions, today } = data;
  const refresh = reload;
  const unread = briefs.filter((b) => !b.read_at);
  const theOne = unread[0] ?? null;
  const rest = briefs.filter((b) => b.id !== theOne?.id);

  // Nothing to watch yet: this is a setup state, not a quiet day. Atlas has no
  // basis to say anything reassuring, so it says what to do instead.
  if (today.reviewed.holdings === 0) {
    return (
      <div className="card">
        <EmptyState
          title="Let's start with what you own"
          action={onAddHoldings && <button onClick={onAddHoldings}>Add your holdings</button>}
        >
          Atlas can't tell you anything true until it knows what you hold. Add your positions and
          the Reality Check runs immediately.
        </EmptyState>
      </div>
    );
  }

  return (
    <div>
      {!today.needs_attention && <QuietDay today={today} />}

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

/**
 * The quiet-day dashboard (§13.3). A positive assertion of work done: what Atlas
 * reviewed, that nothing was material, the receipt, and the streak that says the
 * silence is normal — not a broken system.
 */
function QuietDay({ today }: { today: Today }) {
  const [showReceipt, setShowReceipt] = useState(false);
  const { reviewed, receipt, quiet_days, open_questions, weekly_review } = today;
  const reviewedLine =
    reviewed.updates > 0
      ? `Atlas reviewed ${reviewed.updates} update${reviewed.updates === 1 ? '' : 's'} across your ${reviewed.holdings} holding${reviewed.holdings === 1 ? '' : 's'}. None of them changed anything material to you.`
      : `Atlas is watching your ${reviewed.holdings} holding${reviewed.holdings === 1 ? '' : 's'}, your rules and your thesis conditions. Nothing has changed that should change what you do.`;

  return (
    <div className="card quiet">
      <h3>Nothing needs your attention today.</h3>
      <p className="muted">{reviewedLine}</p>

      {receipt.length > 0 && (
        <>
          <button className="link" onClick={() => setShowReceipt(!showReceipt)}>
            {showReceipt ? 'Hide' : 'Show me what you looked at →'}
          </button>
          {showReceipt && (
            <ul className="plain small">
              {receipt.map((r) => (
                <li key={r.security_id}>
                  · {r.name} <span className="muted">— {r.updates} update{r.updates === 1 ? '' : 's'} reviewed</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {/* Only claim a streak once there is enough history to claim one. */}
      {quiet_days.of >= 7 && (
        <p className="muted small" style={{ marginTop: 12 }}>
          You've had {quiet_days.quiet} quiet day{quiet_days.quiet === 1 ? '' : 's'} of your last {quiet_days.of}. That's
          healthy — most days, nothing should change what a long-term investor does.
        </p>
      )}

      {open_questions.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h4>Open questions ({open_questions.length})</h4>
          <ul className="plain">
            {open_questions.map((q, i) => (
              <li key={i}>
                {q.kind === 'thesis_condition' ? (
                  <>
                    {q.security ? <strong>{q.security}: </strong> : null}
                    <span>a falsification condition you set is met — “{q.text}”</span>
                  </>
                ) : (
                  <span className="muted">Rule outside its limit: {q.text}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="muted small" style={{ marginTop: 16, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
        Your weekly review is ready {new Date(`${weekly_review.next}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })}.
      </p>
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
