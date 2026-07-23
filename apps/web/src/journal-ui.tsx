/**
 * Journal (§11.1 / F-27): your reasoning history is a first-class object, not a
 * settings page. A unified, immutable timeline over your decisions, theses and
 * rules — "a journal is authored by you; history happens to you" (§10.4).
 * Entries kept from a Copilot conversation are clearly marked as such (FR-11.6).
 */
import { useEffect, useState } from 'react';
import { api, type JournalEntry } from './api';

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
  const [entries, setEntries] = useState<JournalEntry[]>([]);

  useEffect(() => {
    api.get<{ data: JournalEntry[] }>('/v1/journal').then((r) => setEntries(r.data)).catch(() => {});
  }, []);

  return (
    <div className="card">
      <h3>Journal</h3>
      {entries.length === 0 ? (
        <p className="muted">
          Your reasoning history lives here — decisions (including "no change"), the theses you write,
          the rules you set — each with the reason you gave, unedited, forever.
        </p>
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
                {String(e.occurred_at).slice(0, 10)}
              </span>
            </div>
            {e.detail && <blockquote>“{e.detail}”</blockquote>}
          </div>
        ))
      )}
    </div>
  );
}
