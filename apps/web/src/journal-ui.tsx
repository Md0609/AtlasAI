/**
 * Journal (§11.1): your reasoning history is a first-class object. At
 * Phase 3 it lists decisions — each with the reason you gave, immutable.
 * "History happens to you; a journal is authored by you" (§10.4).
 */
import { useEffect, useState } from 'react';
import { api, type Decision } from './api';

const ACTION_LABELS: Record<string, string> = {
  buy: 'Bought',
  sell: 'Sold',
  hold: 'Held',
  update_thesis: 'Updated thesis',
  mark_thesis_broken: 'Marked thesis broken',
  no_change: 'Decided: no change',
  snooze: 'Snoozed',
  other: 'Decision',
};

export function JournalView() {
  const [decisions, setDecisions] = useState<Decision[]>([]);

  useEffect(() => {
    api
      .get<{ data: Decision[] }>('/v1/decisions')
      .then((r) => setDecisions(r.data))
      .catch(() => {});
  }, []);

  return (
    <div className="card">
      <h3>Journal</h3>
      {decisions.length === 0 ? (
        <p className="muted">
          No decisions recorded yet. When a brief arrives you'll decide something — including,
          often, "no change" — and the reason you give lives here, unedited, forever.
        </p>
      ) : (
        decisions.map((d) => (
          <div key={d.id} className="thesis">
            <div className="rule-head">
              <strong>
                {ACTION_LABELS[d.action] ?? d.action}
                {d.security_name ? ` · ${d.security_name}` : ''}
              </strong>
              <span className="muted">{String(d.decided_at).slice(0, 10)}</span>
            </div>
            <blockquote>“{d.reason_free_text}”</blockquote>
          </div>
        ))
      )}
    </div>
  );
}
