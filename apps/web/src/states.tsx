/**
 * The three states every data surface must be able to render.
 *
 * Shared so that "loading", "failed" and "nothing here yet" look and behave
 * the same everywhere — and so that a failure is never rendered as emptiness.
 */
import type { ReactNode } from 'react';

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="state-loading" role="status" aria-live="polite">
      {label}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state-error" role="alert">
      {message}
      {onRetry && (
        <button className="secondary" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * An empty surface always says what it means and what to do next — never a
 * bare blank, and never a claim about data that does not exist.
 */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="setup">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div className="cta">{action}</div>}
    </div>
  );
}
