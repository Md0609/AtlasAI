/**
 * Settings — data portability + erasure (Phase 5, §6.6 / F-31).
 *
 * Export is a plain download of the same endpoint the API serves (JSON or a
 * readable HTML document). Deletion is deliberately friction-light (§6.6: no
 * dark patterns, no retention offer) but does require a typed confirmation, and
 * it shows the certificate the API returns.
 */
import { useState } from 'react';
import { api, ApiError } from './api';

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
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="DELETE" />
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
