/**
 * Settings — data portability + erasure (Phase 5, §6.6 / F-31).
 *
 * Export is a plain download of the same endpoint the API serves (JSON or a
 * readable HTML document). Deletion is deliberately friction-light (§6.6: no
 * dark patterns, no retention offer) but does require a typed confirmation, and
 * it shows the certificate the API returns.
 */
import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { describeError } from './use-resource';
import { ErrorState } from './states';
import { DateText, Skeleton } from './primitives';
import { applyTheme, getTheme, type Theme } from './theme';

interface MemoryItem {
  id: string;
  kind: string;
  content: string;
  source: string;
  security_name: string | null;
  occurred_at: string;
}

/**
 * §30.6 — "What Atlas knows about you". An AI with an invisible model of you is
 * creepy; a visible, editable one is a tool. Every item shows what it is, where
 * it came from and when, and is individually deletable.
 */
function WhatAtlasKnows() {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [state, setState] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });
  const load = () => {
    setState({ loading: true, error: null });
    return api
      .get<{ data: MemoryItem[] }>('/v1/memory')
      .then((r) => {
        setItems(r.data);
        setState({ loading: false, error: null });
      })
      .catch((e) => setState({ loading: false, error: describeError(e) }));
  };
  useEffect(() => {
    load();
  }, []);

  const forget = async (id: string) => {
    await api.del(`/v1/memory/${id}`);
    load();
  };

  return (
    <>
      <h3 style={{ marginTop: 28 }}>What Atlas knows about you</h3>
      {state.loading && <Skeleton lines={3} />}
      {state.error && <ErrorState message={state.error} onRetry={load} />}
      {!state.loading && !state.error && items.length === 0 ? (
        <p className="muted">
          Nothing remembered yet. As you talk to Atlas, the exchanges worth keeping appear here — and you can
          delete any of them.
        </p>
      ) : (
        <ul className="plain">
          {items.map((m) => (
            <li key={m.id} style={{ marginBottom: 10 }}>
              <div>{m.content}</div>
              <div className="muted small">
                {m.security_name ? `${m.security_name} · ` : ''}from {m.source} · <DateText iso={m.occurred_at} />{' '}
                <button className="link small" onClick={() => forget(m.id)}>
                  Forget this
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

const THEMES: Array<[Theme, string]> = [
  ['system', 'Match my system'],
  ['light', 'Light'],
  ['dark', 'Dark'],
];

function Appearance() {
  const [theme, setTheme] = useState<Theme>(getTheme);
  const choose = (t: Theme) => {
    applyTheme(t);
    setTheme(t);
  };
  return (
    <>
      <h3 style={{ marginTop: 28 }}>Appearance</h3>
      <div className="theme-choice" role="group" aria-label="Appearance">
        {THEMES.map(([key, label]) => (
          <button
            key={key}
            className={theme === key ? 'tab active' : 'tab'}
            aria-pressed={theme === key}
            onClick={() => choose(key)}
          >
            {label}
          </button>
        ))}
      </div>
    </>
  );
}

export function SettingsPanel() {
  const [confirm, setConfirm] = useState('');
  const [cert, setCert] = useState<{ certificate: string; scheduled_for: string; note?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const requestDeletion = async () => {
    setError(null);
    try {
      const res = await api.del<{ data: { certificate: string; scheduled_for: string; note?: string } }>('/v1/account');
      setCert(res.data);
    } catch (e) {
      setError(e instanceof ApiError ? e.problem.title : String(e));
    }
  };

  return (
    <div className="card">
      <h3>Your data</h3>
      <p className="muted">
        Everything Atlas holds about you — your portfolios, theses, decisions and the reasons you gave — is yours.
      </p>
      <div className="inline">
        <a className="tab" href="/v1/account/export?format=json" download>
          Download JSON
        </a>
        <a className="tab" href="/v1/account/export?format=html" download>
          Download readable document
        </a>
      </div>

      <Appearance />

      <WhatAtlasKnows />

      <h3 style={{ marginTop: 28 }}>Delete your account</h3>
      {cert ? (
        <div className="card">
          <p>Your erasure is scheduled. {cert.note}</p>
          <p className="muted small">Certificate: <code>{cert.certificate}</code></p>
        </div>
      ) : (
        <>
          <p className="muted">
            This permanently erases your data (your audit trail is pseudonymized and retained as required by law). No
            questions, no retention offers. Type <strong>DELETE</strong> to confirm.
          </p>
          <div className="inline">
            <input
              aria-label="Type DELETE to confirm erasing your account"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="DELETE"
            />
            <button onClick={requestDeletion} disabled={confirm !== 'DELETE'}>
              Erase my account
            </button>
          </div>
          {error && <div className="error">{error}</div>}
        </>
      )}
    </div>
  );
}
