/**
 * One way to load data, so a failure can never look like an empty account.
 *
 * Before this, ten call sites did `.catch(() => {})`: if the API failed the
 * screen simply stayed blank, which is indistinguishable from "you own
 * nothing". For a product whose core promise is that silence is meaningful,
 * silence that actually means "broken" is the most expensive bug in the UI.
 *
 * Every consumer gets the same four states — loading, error (with retry),
 * empty, ready — and renders them explicitly.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './api';

export interface Resource<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** Human-readable message for anything a fetch can throw. */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) return e.problem.detail ?? e.problem.title;
  if (e instanceof TypeError) return "Atlas couldn't reach the server.";
  return 'Something went wrong.';
}

export function useResource<T>(load: () => Promise<T>, deps: unknown[] = []): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // `load` is redefined on every render by callers; deps are the real trigger.
  const run = useCallback(load, deps);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    run()
      .then((d) => {
        if (live) setData(d);
      })
      .catch((e) => {
        if (live) setError(describeError(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [run, nonce]);

  return { data, loading, error, reload: () => setNonce((n) => n + 1) };
}
