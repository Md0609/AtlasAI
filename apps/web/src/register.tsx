/**
 * Register adaptation and the inline glossary (US-AI-03, P8, §13.4).
 *
 * The profile already records `experienceLevel` and, until now, nothing used
 * it — a user who said "I'm new to this" got the same five undefined terms in
 * one sentence as a professional.
 *
 * Two rules, and they matter for keeping Priya (the primary persona) first:
 *
 *  1. The DEFAULT register is Priya's. Nothing is dumbed down or removed; the
 *     beginner register adds a plain-language gloss, it does not replace the
 *     precise term. "Effective diversification" stays "effective
 *     diversification" — it just becomes hoverable.
 *  2. Education is never a separate place (P8 — "teach through the work"). It
 *     is a dotted underline on the word, explained with the user's own numbers
 *     where we have them.
 */
import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export type Register = 'beginner' | 'standard';

const RegisterContext = createContext<Register>('standard');

export function RegisterProvider({
  experienceLevel,
  children,
}: {
  experienceLevel: string | null | undefined;
  children: ReactNode;
}) {
  // Only a self-declared beginner gets the expanded register. Everyone else —
  // including "a few years" — gets the precise one.
  const register: Register = experienceLevel === 'beginner' ? 'beginner' : 'standard';
  return <RegisterContext.Provider value={register}>{children}</RegisterContext.Provider>;
}

export function useRegister(): Register {
  return useContext(RegisterContext);
}

/** Pick copy for the current register without hiding anything from anyone. */
export function useCopy(): (standard: string, beginner?: string) => string {
  const register = useRegister();
  return (standard, beginner) => (register === 'beginner' && beginner ? beginner : standard);
}

// ---------------------------------------------------------------------------
// The glossary. Definitions are deliberately short, concrete, and free of
// further jargon — a definition that needs its own glossary is not one.
// ---------------------------------------------------------------------------

export const GLOSSARY: Record<string, string> = {
  'look-through':
    'Your real exposure to a company, counting what your funds hold as well as what you hold directly. A fund that owns Apple makes you an Apple owner too.',
  'effective diversification':
    'How many holdings you effectively have, once you account for size. Ten positions where one is 80% of the money behaves much more like one position than ten.',
  'effective n':
    'How many holdings you effectively have, once you account for size. Ten positions where one is 80% of the money behaves much more like one position than ten.',
  'correlation cluster':
    'A group of your holdings that tend to move together. They look like separate bets but behave like one.',
  concentration:
    'How much of your money sits in your largest positions. High concentration means one company’s bad quarter moves your whole portfolio.',
  thesis:
    'The reason you own something, written down in your own words — plus what would have to happen for you to conclude you were wrong.',
  radar:
    'A condition you asked Atlas to watch for. It waits patiently and tells you once when the condition is met.',
  brief:
    'A short note from Atlas about something that changed and why it matters to you specifically. Not an alert — there is nothing to react to immediately.',
  twr:
    'Time-weighted return: how your investments performed, ignoring the timing of money you added or withdrew. It measures the holdings.',
  mwr:
    'Money-weighted return: what you actually earned, including when you added or withdrew. The gap between this and time-weighted return is the cost of your timing.',
  hhi:
    'Herfindahl–Hirschman Index — the sum of the squared weights of your positions. 0 is perfectly spread, 1 is everything in one name. Effective holdings is the same figure said in names.',
  'base currency':
    'The currency Atlas converts everything into so the totals make sense — normally the one you think and spend in.',
  provenance:
    'Where a number came from: which source, which method, and as of when. Every figure Atlas shows can be traced.',
};

/**
 * Terms that get linked automatically inside prose Atlas generates server-side.
 *
 * Deliberately a subset of the glossary: a screen where every third word is
 * underlined is noise, not help. These are the terms that carry a *specific*
 * meaning a reader is likely to mistake for the everyday one. Longest first so
 * the alternation prefers the more specific phrase.
 */
const AUTO_TERMS = [
  'effective diversification',
  'correlation clusters',
  'correlation cluster',
  'base currency',
  'look-through',
  'concentration',
  'provenance',
];

function glossaryKeyFor(match: string): string | undefined {
  const m = match.toLowerCase();
  if (GLOSSARY[m]) return m;
  if (m.endsWith('s') && GLOSSARY[m.slice(0, -1)]) return m.slice(0, -1);
  return undefined;
}

/**
 * Server-generated prose with its jargon made hoverable.
 *
 * The Reality Check, briefs and narration are written by the backend, so their
 * vocabulary can't be wrapped at the call site. Only the FIRST occurrence of
 * each term is linked — the reader needs the definition once, not five times.
 */
export function Glossed({ text }: { text: string }) {
  const re = new RegExp(`\\b(${AUTO_TERMS.join('|')})\\b`, 'gi');
  const parts: ReactNode[] = [];
  const seen = new Set<string>();
  let last = 0;
  for (const m of text.matchAll(re)) {
    const key = glossaryKeyFor(m[0]);
    if (!key || seen.has(key) || m.index === undefined) continue;
    seen.add(key);
    parts.push(text.slice(last, m.index));
    parts.push(
      <Term key={`${key}-${m.index}`} k={key}>
        {m[0]}
      </Term>,
    );
    last = m.index + m[0].length;
  }
  if (parts.length === 0) return <>{text}</>;
  parts.push(text.slice(last));
  return <>{parts}</>;
}

/**
 * An inline explainer. Renders the precise term with a dotted underline; the
 * definition appears on hover, focus or tap — so it is reachable by keyboard
 * and on touch, not just with a mouse.
 */
export function Term({ k, children }: { k: string; children?: ReactNode }) {
  // Hover and click are tracked separately on purpose. If one boolean were
  // toggled by both, clicking a term you are already hovering would *close* the
  // definition — the single most confusing thing a tooltip can do.
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const popRef = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);
  const definition = GLOSSARY[k.toLowerCase()];
  const label = children ?? k;
  const open = (hovered || pinned) && Boolean(definition);

  // Nudge the popover back inside the viewport. Measured after paint, once per
  // open — the transform it sets is not a dependency, so this cannot loop.
  useLayoutEffect(() => {
    if (!open || !popRef.current) {
      setShift(0);
      return;
    }
    const margin = 12;
    const r = popRef.current.getBoundingClientRect();
    let dx = 0;
    if (r.right > window.innerWidth - margin) dx = window.innerWidth - margin - r.right;
    if (r.left + dx < margin) dx = margin - r.left;
    setShift(dx);
  }, [open]);

  if (!definition) return <>{label}</>;
  return (
    <span className="term-wrap">
      <button
        type="button"
        className="term"
        aria-expanded={open}
        aria-label={`${typeof label === 'string' ? label : k} — what this means`}
        onClick={() => setPinned((p) => !p)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => {
          setHovered(false);
          setPinned(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setPinned(false);
        }}
      >
        {label}
      </button>
      {open && (
        <span
          ref={popRef}
          className="term-pop"
          role="tooltip"
          style={{ '--term-shift': `${shift}px` } as React.CSSProperties}
        >
          {definition}
        </span>
      )}
    </span>
  );
}
