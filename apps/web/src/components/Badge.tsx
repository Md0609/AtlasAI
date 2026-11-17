import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'warning' | 'danger' | 'success';

/**
 * A short text label. Meaning is always carried by the text itself; the tone colour only
 * reinforces it (never colour alone — WCAG 1.4.1).
 */
export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
