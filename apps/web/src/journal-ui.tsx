/**
 * Journal (§11.1 / F-27): your reasoning history is a first-class object, not a
 * settings page. A unified, immutable timeline over your decisions, theses and
 * rules — "a journal is authored by you; history happens to you" (§10.4).
 * Entries kept from a Copilot conversation are clearly marked as such (FR-11.6).
 */
import { api, type JournalEntry } from './api';
import { useResource } from './use-resource';
import { EmptyState, ErrorState, LoadingState } from './states';

/** Same format everywhere in the app, and never the machine's ISO string. */
const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

const KIND_LABEL: Record<string, string> = {
  decision: 'Decision',
  thesis_written: 'Thesis',
  thesis_falsified: 'Thesis falsified',
  thesis_retired: 'Thesis retired',
  thesis_superseded: 'Thesis superseded',
  rule_set: 'Rule set',
  rule_removed: 'Rule removed',
};

export function JournalView() {
  const { data, loading, error, reload } = useResource<JournalEntry[]>(
    () => api.get<{ data: JournalEntry[] }>('/v1/journal').then((r) => r.data),
    [],
  );
  const entries = data ?? [];

  return (
    <div className="card">
      <h3>Journal</h3>
      {loading && <LoadingState />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {!loading && !error && entries.length === 0 ? (
        <EmptyState title="Nothing recorded yet">
          Your reasoning history lives here — decisions (including “no change”), the theses you
          write, the rules you set — each with the reason you gave, unedited, forever. Entries
          appear as you make those choices; there is nothing to set up.
        </EmptyState>
      ) : (
        entries.map((e) => (
          <div key={e.id} className="thesis">
            <div className="rule-head">
              <strong>
                {KIND_LABEL[e.kind] ?? e.kind}
                {e.security_name ? ` · ${e.security_name}` : ''}{' '}
                <span className="muted small">{e.title}</span>
              </strong>
              <span className="muted">
                {e.source === 'copilot' && <span className="badge">from Copilot</span>}{' '}
                {day(e.occurred_at)}
              </span>
            </div>
            {e.detail && <blockquote>“{e.detail}”</blockquote>}
          </div>
        ))
      )}
    </div>
  );
}
