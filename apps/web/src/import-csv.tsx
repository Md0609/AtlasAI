/**
 * CSV import + mapping UI. Extracted from
 * App.tsx so onboarding (Phase 2) can reuse the exact same component.
 */
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type Portfolio } from './api';

const FIELDS = ['ticker', 'isin', 'date', 'type', 'quantity', 'price', 'currency', 'fee'] as const;
type Field = (typeof FIELDS)[number];

export function ImportCsv({ portfolio, onDone }: { portfolio: Portfolio; onDone: () => void }) {
  const [csv, setCsv] = useState('');
  const [mapping, setMapping] = useState<Partial<Record<Field, string>>>({});
  const [result, setResult] = useState<{ imported: number; skipped: Array<{ line: number; reason: string }> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assumeFunded, setAssumeFunded] = useState(true);

  const header = useMemo(() => {
    const firstLine = csv.split(/\r?\n/)[0] ?? '';
    return firstLine ? firstLine.split(',').map((h) => h.trim()) : [];
  }, [csv]);

  useEffect(() => {
    // auto-map obvious column names
    const auto: Partial<Record<Field, string>> = {};
    for (const h of header) {
      const l = h.toLowerCase();
      if (['ticker', 'symbol'].includes(l)) auto.ticker = h;
      if (l === 'isin') auto.isin = h;
      if (['date', 'trade_date', 'tradedate'].includes(l)) auto.date = h;
      if (['type', 'side', 'action'].includes(l)) auto.type = h;
      if (['quantity', 'qty', 'shares'].includes(l)) auto.quantity = h;
      if (['price', 'unit_price'].includes(l)) auto.price = h;
      if (['currency', 'ccy'].includes(l)) auto.currency = h;
      if (['fee', 'fees', 'commission'].includes(l)) auto.fee = h;
    }
    setMapping(auto);
  }, [header.join('|')]);

  const onFile = (f: File | null) => {
    if (!f) return;
    f.text().then(setCsv);
  };

  const submit = async () => {
    setError(null);
    setResult(null);
    try {
      const res = await api.post<{ imported: number; skipped: Array<{ line: number; reason: string }> }>(
        `/v1/portfolios/${portfolio.id}/import`,
        { csv, mapping, defaults: { type: 'buy', assume_funded: assumeFunded } },
      );
      setResult(res);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.problem.title}${e.problem.detail ? ` — ${e.problem.detail}` : ''}` : String(e));
    }
  };

  return (
    <div className="card">
      <h3>Import from a file</h3>
      <p className="muted">
        Most brokers can export your transactions as a CSV. Include a header row, dates as
        YYYY-MM-DD, and one row per buy or sell.
      </p>
      <label>
        Choose a file
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
          aria-label="Choose a CSV file to import"
        />
      </label>
      <p className="field-note">…or paste the rows directly below.</p>
      <textarea
        rows={6}
        placeholder={'ticker,date,quantity,price,currency\nAAPL,2026-02-02,10,220.5,USD'}
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
      />
      {header.length > 0 && (
        <>
          <h4>Column mapping</h4>
          <div className="mapping">
            {FIELDS.map((f) => (
              <label key={f}>
                {f}
                <select
                  value={mapping[f] ?? ''}
                  onChange={(e) => setMapping({ ...mapping, [f]: e.target.value || undefined })}
                >
                  <option value="">—</option>
                  {header.map((h) => <option key={h}>{h}</option>)}
                </select>
              </label>
            ))}
          </div>
        </>
      )}
      <label className="option">
        <input type="checkbox" checked={assumeFunded} onChange={(e) => setAssumeFunded(e.target.checked)} />{' '}
        My deposits aren't in this file — treat each buy as funded (recommended when importing
        holdings from a broker)
      </label>
      <button onClick={submit} disabled={!csv}>Import</button>
      {error && <div className="error">{error}</div>}
      {result && (
        <div>
          <p>Imported {result.imported} transaction(s).</p>
          {result.skipped.length > 0 && (
            <ul className="plain">
              {result.skipped.map((s) => (
                <li key={s.line} className="error">line {s.line}: {s.reason}</li>
              ))}
            </ul>
          )}
          <button className="link" onClick={onDone}>Continue →</button>
        </div>
      )}
    </div>
  );
}
