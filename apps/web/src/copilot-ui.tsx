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
  api,
  copilot,
  type CopilotContextType,
  type CopilotMessage,
  type CopilotThread,
} from './api';
import { DateText } from './primitives';

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

/**
 * Opening questions per context (§11.2 — the Copilot is bound to what you are
 * looking at). Deliberately all questions Atlas can answer from the user's own
 * data: none of them invites a recommendation, because a starter chip that
 * prompts "should I sell?" teaches the wrong expectation and then gets refused
 * by the Guard, which reads as the product being broken rather than principled.
 */
const STARTERS: Record<CopilotContextType, string[]> = {
  portfolio: [
    'Why is my effective diversification lower than my number of holdings?',
    'Where is my biggest single-name exposure coming from?',
    'How much of my return was currency rather than the investments?',
  ],
  security: [
    'Why do I own this?',
    'How much of my portfolio is this, counting funds?',
    'What did I say would make me wrong about this?',
  ],
  notification: [
    'Why did you tell me this?',
    'What changed since the last time?',
    'Does this touch any rule I set?',
  ],
  global: [
    'What changed in my portfolio this week?',
    'Which of my rules are closest to breaching?',
    'What have I written down and then not acted on?',
  ],
};
/** What a past thread was about, in the product's own words rather than the
 *  context enum ("security", "global") the API stores it under. */
const THREAD_CONTEXT: Record<CopilotContextType, string> = {
  portfolio: 'About a portfolio',
  security: 'About a holding',
  notification: 'About a brief',
  global: 'General',
};

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

/**
 * Where a turn's words came from (P1-10).
 *
 * `degraded` and `generative` answer different questions and must not be
 * collapsed into one label:
 *
 *   generative && !degraded   a model wrote it, normally      -> say nothing
 *   !generative && degraded   the provider failed              -> say so
 *   !generative && !degraded  fixture/demo or kept template    -> say so
 *   generative && degraded    impossible by construction
 *
 * The healthy case is silent on purpose. A badge on every normal answer trains
 * people to stop reading badges, and the one that matters would go with it.
 */
function Provenance({ degraded, generative }: { degraded: boolean; generative: boolean }) {
  if (generative) return null;
  return (
    <div className="muted small">
      {degraded
        ? 'Written by Atlas, not by a model — the model was unavailable for this answer.'
        : 'Written by Atlas from your own figures, not by a model.'}
    </div>
  );
}

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

  /** `preset` lets a starter chip send without round-tripping through the input. */
  const send = async (preset?: string) => {
    const text = (preset ?? draft).trim();
    if (!text || !threadId || busy) return;
    setDraft('');
    setMessages((m) => [
      ...m,
      {
        id: `u-${Date.now()}`,
        role: 'user',
        content: text,
        degraded: false,
        generative: false, // the user wrote it
        guard_approved: true,
        created_at: '',
      },
      {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: '',
        // Optimistic placeholder. The real provenance arrives with `done`;
        // until then claim nothing.
        degraded: false,
        generative: false,
        guard_approved: true,
        created_at: '',
      },
    ]);
    setBusy(true);
    try {
      const done = await copilot.stream(threadId, text, (delta) => {
        setMessages((m) => {
          const next = [...m];
          next[next.length - 1] = { ...next[next.length - 1]!, content: next[next.length - 1]!.content + delta };
          return next;
        });
      });
      // Provenance is only known once the turn completes; without this the
      // streamed answer keeps its optimistic placeholder values forever.
      setMessages((m) => {
        const next = [...m];
        next[next.length - 1] = {
          ...next[next.length - 1]!,
          degraded: done.degraded,
          generative: done.generative,
          guard_approved: done.guard_approved,
        };
        return next;
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cmdk-backdrop" onClick={onClose}>
      <div
        className="cmdk"
        role="dialog"
        aria-modal="true"
        aria-label={subject.type === 'global' ? 'Atlas Copilot' : `Copilot — ${subject.label}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cmdk-head">
          <span className="cmdk-subject">
            {subject.type === 'global' ? 'Atlas Copilot' : `Copilot · ${subject.label}`}
          </span>
          <button className="link" aria-label="Close Copilot" onClick={onClose}>
            Esc
          </button>
        </div>
        {/* The answer streams in token by token; without a live region a screen
            reader never hears it arrive. */}
        <div className="cmdk-body" role="log" aria-live="polite" aria-busy={busy}>
          {error && <div className="error">{error}</div>}
          {messages.map((m, i) => (
            <div key={m.id} className={`cmdk-msg ${m.role}`}>
              <div className="cmdk-role">{m.role === 'user' ? 'You' : 'Atlas'}</div>
              <div className="cmdk-content">{m.content || (busy ? '…' : '')}</div>
              {m.guard_approved === false && (
                <div className="muted small">(withheld — could not answer without advice)</div>
              )}
              {m.role === 'assistant' && m.content && m.guard_approved !== false && (
                <Provenance degraded={m.degraded} generative={m.generative} />
              )}
              {/* FR-11.6 offers to keep a material CONCLUSION. The thread opens
                  with a canned greeting, which is not one — only answers that
                  followed a question of the user's are worth journaling. */}
              {m.role === 'assistant' &&
                m.content &&
                threadId &&
                !busy &&
                messages.slice(0, i).some((p) => p.role === 'user') && (
                  <SaveToJournal threadId={threadId} subject={subject} content={m.content} />
                )}
            </div>
          ))}
          {/* An empty prompt box asks the user to invent a question about a
              screen they are still reading. These show what Atlas can be asked
              — and, by omission, what it will not answer. */}
          {!messages.some((m) => m.role === 'user') && !busy && (
            <>
              <p className="muted small">
                Atlas answers questions about your own portfolio. It won't tell you what to buy or
                sell.
              </p>
              <div className="chips">
                {STARTERS[subject.type].map((q) => (
                  <button key={q} className="chip" disabled={!threadId} onClick={() => send(q)}>
                    {q}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="cmdk-input">
          <input
            ref={inputRef}
            value={draft}
            aria-label={`Ask Atlas about ${subject.label}`}
            placeholder={busy ? 'Loading context…' : `Ask about ${subject.label}…`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            disabled={!threadId}
          />
          {/* Called with no argument on purpose: onClick would otherwise hand
              the MouseEvent to `preset` and send it as the question. */}
          <button onClick={() => send()} disabled={busy || !draft.trim()}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * FR-11.6: the Copilot must OFFER to persist a material conclusion as a journal
 * record. One click keeps the assistant's turn as a decision attributed to this
 * conversation (source = copilot, linked to the thread).
 */
function SaveToJournal({ threadId, subject, content }: { threadId: string; subject: Subject; content: string }) {
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (saved) return <div className="muted small">✓ kept in your journal</div>;
  const save = async () => {
    try {
      await api.post('/v1/decisions', {
        action: 'other',
        reason: content.slice(0, 2000),
        source: 'copilot',
        source_thread_id: threadId,
        security_id: subject.type === 'security' ? subject.ref ?? undefined : undefined,
      });
      setSaved(true);
    } catch {
      setError('could not save');
    }
  };
  return (
    <button className="link small" onClick={save} title="Keep this in your journal (attributed to this chat)">
      {error ?? 'Save to journal →'}
    </button>
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
                {THREAD_CONTEXT[t.context_type] ?? t.context_type} · <DateText iso={t.last_message_at} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
