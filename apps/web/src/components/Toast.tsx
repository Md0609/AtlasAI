import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export type ToastTone = 'info' | 'success' | 'error';

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ToastApi {
  notify: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** How long a toast stays on screen, unless dismissed earlier. */
export const TOAST_DURATION_MS = 5000;

/**
 * Transient notifications. A single, always-mounted live region holds every toast, so a message is
 * announced once; notifying the same message while it is still visible restarts its timer instead
 * of stacking a duplicate. Errors go to a separate `role="alert"` (assertive) region; the rest to `role="status"` (polite).
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  // Mirror of `items` so notify/dismiss can decide synchronously, without side effects inside a
  // state updater (StrictMode runs updaters twice).
  const itemsRef = useRef<ToastItem[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const nextId = useRef(1);

  const commit = useCallback((xs: ToastItem[]) => {
    itemsRef.current = xs;
    setItems(xs);
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      const t = timers.current.get(id);
      if (t) clearTimeout(t);
      timers.current.delete(id);
      commit(itemsRef.current.filter((x) => x.id !== id));
    },
    [commit],
  );

  const schedule = useCallback(
    (id: number) => {
      const old = timers.current.get(id);
      if (old) clearTimeout(old);
      timers.current.set(id, setTimeout(() => dismiss(id), TOAST_DURATION_MS));
    },
    [dismiss],
  );

  const notify = useCallback(
    (message: string, tone: ToastTone = 'info') => {
      const existing = itemsRef.current.find((x) => x.message === message && x.tone === tone);
      if (existing) {
        schedule(existing.id);
        return;
      }
      const id = nextId.current++;
      schedule(id);
      commit([...itemsRef.current, { id, message, tone }]);
    },
    [schedule, commit],
  );

  useEffect(() => {
    const map = timers.current;
    return () => map.forEach((t) => clearTimeout(t));
  }, []);

  const polite = items.filter((x) => x.tone !== 'error');
  const assertive = items.filter((x) => x.tone === 'error');
  return (
    <ToastContext.Provider value={{ notify }}>
      {children}
      <div className="toasts">
        <div role="status">
          {polite.map((t) => <Toast key={t.id} item={t} onDismiss={dismiss} />)}
        </div>
        <div role="alert">
          {assertive.map((t) => <Toast key={t.id} item={t} onDismiss={dismiss} />)}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  return (
    <div className={`toast toast-${item.tone}`}>
      <span>{item.message}</span>
      <button type="button" className="toast-close" aria-label="Dismiss notification" onClick={() => onDismiss(item.id)}>
        ×
      </button>
    </div>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
