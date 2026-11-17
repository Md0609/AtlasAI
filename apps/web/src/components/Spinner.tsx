/**
 * Loading indicator. One polite live region with visible text, so assistive technology announces
 * the label exactly once (no duplicated aria-label). The animated mark is decorative and stops
 * under `prefers-reduced-motion: reduce` (styles.css).
 */
export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="spinner" role="status" aria-live="polite">
      <span className="spinner-mark" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
