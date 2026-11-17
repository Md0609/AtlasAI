import type { ReactNode } from 'react';

/** What a view shows when there is nothing yet: a sentence and, optionally, the next step. */
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <p className="empty-state-title">{title}</p>
      {children && <div className="empty-state-body">{children}</div>}
    </div>
  );
}
