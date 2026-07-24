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
import { WeeklyReviewView } from './weekly-review-ui';
import { Glossed, Term } from './register';
import { ruleLabel } from './rules-ui';

/**
 * The §18.4 brief classes, said out loud. "C1" is an internal taxonomy code; a
 * reader has no way to decode it, and printing it next to a headline makes the
 * product sound like a log file. Each label answers the only question the code
 * was ever standing in for: why am I being told this?
 */
const BRIEF_KIND: Record<Brief['class'], string> = {
  C0: 'A condition you set was met',
  C1: 'A rule you set was breached',
  C2: 'Something you put on your radar',
};

/**
 * Suppression reasons, translated at render time.
 *
 * The stored reason is an audit record and cites its own spec section — right
 * for the log, wrong for the person reading "what Atlas didn't send". These
 * are rewritten here rather than at write time so the audit trail keeps its
 * precision and the reader still gets a sentence.
 */
function suppressionReason(raw: string): string {
  if (raw.startsWith('duplicate:')) return 'you had already been told about this the same day';
  if (raw.startsWith('daily cap:')) return 'you had already had two interruptions that day';
  const weekly = /allows (\d+) /.exec(raw);
  if (raw.startsWith('weekly budget:') && weekly) {
    return `you had already used all ${weekly[1]} of that week's interruptions`;
  }
  return raw;
}

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

      <ThisWeek />

      {suppressions.length > 0 && (
        <div className="card">
          <button className="link" onClick={() => setShowSuppressed(!showSuppressed)}>
            {showSuppressed ? 'Hide' : `What Atlas didn't send (${suppressions.length}) →`}
          </button>
          {showSuppressed && (
            <>
              <p className="summary-line">
                These were held back on purpose. Nothing was deleted — they are still here.
              </p>
              <ul className="plain">
                {suppressions.map((s) => (
                  <li key={s.id}>
                    · {s.headline ?? BRIEF_KIND[s.class as Brief['class']] ?? 'A brief'}{' '}
                    <span className="muted">— held back because {suppressionReason(s.reason)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The Weekly Review, folded into Today rather than owning a nav slot. */
function ThisWeek() {
  const [open, setOpen] = useState(false);
  return (
    <div className="card">
      <div className="section-head">
        <h3>Your week</h3>
        <button className="link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : 'Read the review →'}
        </button>
      </div>
      {!open && (
        <p className="summary-line">
          What changed, what Atlas reviewed and chose not to send, how your rules held.
        </p>
      )}
      {open && <WeeklyReviewView />}
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
  const plural = (n: number) => (n === 1 ? '' : 's');
  // JSX, not a template string — the glossary term has to be a real element.
  const reviewedLine =
    reviewed.updates > 0 ? (
      <>
        Atlas reviewed {reviewed.updates} update{plural(reviewed.updates)} across your{' '}
        {reviewed.holdings} holding{plural(reviewed.holdings)}. None of them changed anything
        material to you.
      </>
    ) : (
      <>
        Atlas is watching your {reviewed.holdings} holding{plural(reviewed.holdings)}, your rules
        and your <Term k="thesis">thesis</Term> conditions. Nothing has changed that should change
        what you do.
      </>
    );

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
                  <span>
                    <strong>{ruleLabel(q.text, q.params)}</strong> — this rule is currently outside
                    its limit.
                  </span>
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
      {/* The reason you are being told sits above the headline, small — it is
          context for the headline, not a second one competing with it. */}
      <div className="eyebrow">{BRIEF_KIND[brief.class]}</div>
      <h4>{brief.headline}</h4>
      <p className="brief-body"><Glossed text={brief.body} /></p>
      {isThesisBrief && !brief.read_at ? (
        deciding ? (
          <div>
            <input
              autoFocus
              aria-label="Your reason for this decision"
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
