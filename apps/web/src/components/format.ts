/**
 * Display formatters shared by the feature views. They only format the decimal strings the API
 * returns — they never compute metrics (objective.md §6).
 */
export const pct = (w: string | null | undefined, dp = 2) =>
  w == null ? '—' : `${(Number(w) * 100).toFixed(dp)}%`;
export const num = (v: string | null | undefined, dp = 2) =>
  v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: dp });
