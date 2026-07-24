/**
 * The shared vocabulary of the interface.
 *
 * Before this, a percentage was formatted three different ways in three files
 * (`pct`, `pctNum`, `pctOrRaw`) and a date four (raw ISO slice, two different
 * toLocaleDateString option sets, toLocaleString). The same figure could read
 * "66.6%" on one screen and "66.57%" on the next, which quietly undermines the
 * one thing this product sells: that its numbers are trustworthy.
 *
 * Every money, percentage and date on screen goes through here.
 *
 * Values arrive as decimal STRINGS from the domain layer — never floats, so
 * arithmetic can't drift. These components format for display only; they never
 * compute.
 */
import type { ReactNode } from 'react';
import { useState } from 'react';

/** One locale for the whole app. Pinned so tests and screenshots are stable. */
const LOCALE = 'en-GB';

/** Missing is missing. Never 0, never blank — those are claims about data. */
export const MISSING = '—';

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export function formatNumber(v: string | number | null | undefined, dp = 2): string {
  if (v == null || v === '') return MISSING;
  const n = Number(v);
  if (!Number.isFinite(n)) return MISSING;
  return n.toLocaleString(LOCALE, { maximumFractionDigits: dp });
}

/** Weights arrive as decimals: '0.666' → '66.60%'. */
export function formatPct(v: string | number | null | undefined, dp = 2): string {
  if (v == null || v === '') return MISSING;
  const n = Number(v);
  if (!Number.isFinite(n)) return MISSING;
  return `${(n * 100).toFixed(dp)}%`;
}

export function formatMoney(
  v: string | number | null | undefined,
  currency: string,
  dp = 2,
): string {
  const n = formatNumber(v, dp);
  return n === MISSING ? MISSING : `${n} ${currency}`;
}

/**
 * An amount with its currency. The currency is muted because it repeats down a
 * column and the eye should land on the figure.
 */
export function Money({
  value,
  currency,
  dp = 2,
}: {
  value: string | number | null | undefined;
  currency: string;
  dp?: number;
}) {
  const n = formatNumber(value, dp);
  if (n === MISSING) return <span className="tnum">{MISSING}</span>;
  return (
    <span className="tnum">
      {n} <span className="muted">{currency}</span>
    </span>
  );
}

/**
 * A percentage. `signed` is for returns, where the sign carries the meaning —
 * and where it must NOT be coloured red/green: §18.5 forbids the urgency
 * palette, and colouring losses red is exactly the reflex Atlas refuses to
 * train. The sign does the work.
 */
export function Pct({
  value,
  dp = 2,
  signed = false,
}: {
  value: string | number | null | undefined;
  dp?: number;
  signed?: boolean;
}) {
  const text = formatPct(value, dp);
  if (text === MISSING || !signed) return <span className="tnum">{text}</span>;
  const n = Number(value);
  return <span className="tnum">{n > 0 ? `+${text}` : text}</span>;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * A calendar day. Dates from the API are date-only strings or timestamps; both
 * are read as UTC so a user just past midnight never sees yesterday's date on a
 * figure computed today.
 */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return MISSING;
  const stamp = iso.length === 10 ? `${iso}T00:00:00Z` : iso;
  const d = new Date(stamp);
  if (Number.isNaN(d.getTime())) return MISSING;
  return d.toLocaleDateString(LOCALE, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function formatWeekday(iso: string | null | undefined): string {
  if (!iso) return MISSING;
  const stamp = iso.length === 10 ? `${iso}T00:00:00Z` : iso;
  const d = new Date(stamp);
  if (Number.isNaN(d.getTime())) return MISSING;
  return d.toLocaleDateString(LOCALE, { weekday: 'long', timeZone: 'UTC' });
}

export function DateText({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <span className="muted">{MISSING}</span>;
  return <time dateTime={iso}>{formatDay(iso)}</time>;
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

/**
 * A titled block of the page. Optionally collapsible: the headline stays
 * visible and the detail arrives on request (progressive disclosure), so a
 * data-dense screen opens calm and deepens on demand.
 */
export function Section({
  title,
  summary,
  children,
  collapsible = false,
  defaultOpen = false,
  action,
}: {
  title: string;
  summary?: string;
  children: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  action?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const shown = collapsible ? open : true;
  return (
    <div className="section">
      <div className="section-head">
        <h3>{title}</h3>
        {collapsible ? (
          <button className="link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide detail' : 'Show detail'}
          </button>
        ) : (
          action
        )}
      </div>
      {summary && !shown && <p className="summary-line">{summary}</p>}
      {shown && children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------

/**
 * A placeholder shaped like the content that is coming.
 *
 * "Loading…" in a bare div collapses the layout and then shoves it down when
 * the data lands — the jump reads as instability on a screen whose whole job is
 * to feel steady. A skeleton holds the space.
 *
 * Always paired with a screen-reader status, since the shapes say nothing.
 */
export function Skeleton({ lines = 3, title = false }: { lines?: number; title?: boolean }) {
  return (
    <div className="skeleton" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading…</span>
      {title && <div className="sk-bar sk-title" />}
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="sk-bar" style={{ width: `${92 - i * 11}%` }} />
      ))}
    </div>
  );
}

export function SkeletonTable({ rows = 3, cols = 3 }: { rows?: number; cols?: number }) {
  return (
    <div className="skeleton" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="sk-row">
          {Array.from({ length: cols }, (_, c) => (
            <div key={c} className="sk-bar" style={{ flex: c === 0 ? 3 : 1 }} />
          ))}
        </div>
      ))}
    </div>
  );
}
