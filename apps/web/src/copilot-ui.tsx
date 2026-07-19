/**
 * Copilot UI (§11.2) — the ambient assistant.
 *
 * The Copilot is NOT a screen you visit to start typing context. It is a global
 * ⌘K input available on every surface, and it always knows what you are looking
 * at: each view registers its subject via `useCopilotSubject`, and opening ⌘K
 * starts a thread bound to that subject — the server preloads the context and
 * the first turn already speaks to it. The dedicated Copilot page is only
 * conversation history.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  copilot,
  type CopilotContextType,
  type CopilotMessage,
  type CopilotThread,
} from './api';

interface Subject {
  type: CopilotContextType;
  ref: string | null;
  label: string;
}

interface CopilotCtx {
  subject: Subject;
  setSubject: (s: Subject) => void;
  clearSubject: (ref: string | null) => void;
  open: () => void;
}

const GLOBAL_SUBJECT: Subject = { type: 'global', ref: null, label: 'Atlas' };
const Ctx = createContext<CopilotCtx | null>(null);

export function CopilotProvider({ children }: { children: ReactNode }) {
  const [subject, setSubject] = useState<Subject>(GLOBAL_SUBJECT);
  const [isOpen, setOpen] = useState(false);

  // A view clears context on unmount by passing its own ref; if the subject has
  // already moved on we leave it, otherwise we fall back to global.
  const clearSubject = useCallback((ref: string | null) => {
    setSubject((cur) => (cur.ref === ref ? GLOBAL_SUBJECT : cur));
  }, []);

  // ⌘K / Ctrl-K anywhere opens the Copilot on the current subject.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const value = useMemo<CopilotCtx>(
    () => ({ subject, setSubject, clearSubject, open: () => setOpen(true) }),
    [subject, clearSubject],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {isOpen && <CommandK subject={subject} onClose={() => setOpen(false)} />}
    </Ctx.Provider>
  );
}

export function useCopilot(): CopilotCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useCopilot outside CopilotProvider');
  return c;
}

/** Register the current view's subject so ⌘K opens with it preloaded. */
export function useCopilotSubject(type: CopilotContextType, ref: string | null, label: string): void {
  const { setSubject, clearSubject } = useCopilot();
  useEffect(() => {
    setSubject({ type, ref, label });
    return () => clearSubject(ref);
  }, [type, ref, label, setSubject, clearSubject]);
}

// ---------------------------------------------------------------------------
// The global ⌘K panel — opens a context-bound thread and streams the answer.
// ---------------------------------------------------------------------------

function CommandK({ subject, onClose }: { subject: Subject; onClose: () => void }) {
  const [messages, setMessages] = useState<CopilotMessage[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // On open, start a thread FROM the current subject — the opener arrives with
  // the context already loaded (§11.2).
  useEffect(() => {
    let live = true;
    copilot
      .open(subject.type, subject.ref)
      .then((r) => {
        if (!live) return;
        setThreadId(r.data.thread.id);
        setMessages(r.data.messages);
      })
      .catch((e) => setError(String(e)))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [subject.type, subject.ref]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [busy]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !threadId || busy) return;
    setDraft('');
    setMessages((m) => [
      ...m,
      { id: `u-${Date.now()}`, role: 'user', content: text, created_at: '' },
      { id: `a-${Date.now()}`, role: 'assistant', content: '', created_at: '' },
    ]);
    setBusy(true);
    try {
      await copilot.stream(threadId, text, (delta) => {
        setMessages((m) => {
          const next = [...m];
          next[next.length - 1] = { ...next[next.length - 1], content: next[next.length - 1].content + delta };
          return next;
        });
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cmdk-backdrop" onClick={onClose}>
      <div className="cmdk" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-head">
          <span className="cmdk-subject">
            {subject.type === 'global' ? 'Atlas Copilot' : `Copilot · ${subject.label}`}
          </span>
          <button className="link" onClick={onClose}>
            Esc
          </button>
        </div>
        <div className="cmdk-body">
          {error && <div className="error">{error}</div>}
          {messages.map((m) => (
            <div key={m.id} className={`cmdk-msg ${m.role}`}>
              <div className="cmdk-role">{m.role === 'user' ? 'You' : 'Atlas'}</div>
              <div className="cmdk-content">{m.content || (busy ? '…' : '')}</div>
              {m.guard_approved === false && <div className="muted small">(withheld — could not answer without advice)</div>}
            </div>
          ))}
        </div>
        <div className="cmdk-input">
          <input
            ref={inputRef}
            value={draft}
            placeholder={busy ? 'Loading context…' : `Ask about ${subject.label}…`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            disabled={!threadId}
          />
          <button onClick={send} disabled={busy || !draft.trim()}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The dedicated Copilot page — conversation history only (§11.2).
// ---------------------------------------------------------------------------

export function CopilotHistory() {
  const [threads, setThreads] = useState<CopilotThread[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [messages, setMessages] = useState<CopilotMessage[]>([]);

  useEffect(() => {
    copilot.listThreads().then((r) => setThreads(r.data));
  }, []);
  useEffect(() => {
    if (openId) copilot.getThread(openId).then((r) => setMessages(r.data.messages));
  }, [openId]);

  if (openId) {
    const t = threads.find((x) => x.id === openId);
    return (
      <div className="card">
        <button className="link" onClick={() => setOpenId(null)}>
          ← all conversations
        </button>
        <h3>{t?.title ?? 'Conversation'}</h3>
        <div className="muted small">context: {t?.context_type}</div>
        {messages.map((m) => (
          <div key={m.id} className={`cmdk-msg ${m.role}`}>
            <div className="cmdk-role">{m.role === 'user' ? 'You' : 'Atlas'}</div>
            <div className="cmdk-content">{m.content}</div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="card">
      <p className="muted">
        Conversation history. Press <kbd>⌘K</kbd> anywhere to ask Atlas about whatever you are looking at —
        it starts already knowing the context.
      </p>
      {threads.length === 0 && <p className="muted">No conversations yet.</p>}
      <ul className="plain">
        {threads.map((t) => (
          <li key={t.id}>
            <button className="row" onClick={() => setOpenId(t.id)}>
              <strong>{t.title}</strong>{' '}
              <span className="muted">
                {t.context_type} · {new Date(t.last_message_at).toLocaleString()}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
