/**
 * Add a holding by hand (F1).
 *
 * Until now the ONLY way to get holdings into Atlas was a CSV — which meant a
 * user who could not produce one could not use the product at all. This is a
 * thin client over the existing `POST /v1/portfolios/:id/transactions`; no
 * backend capability was added.
 *
 * Built for Priya, not simplified for a novice: type-ahead on the real
 * security master, exact quantity/price/date, explicit currency. It is fast to
 * repeat because she has 26 positions to enter, and it explains itself because
 * nobody should have to guess what "trade date" means.
 */
import { useEffect, useState } from 'react';
import { api, type Portfolio } from './api';
import { describeError } from './use-resource';

interface SecurityHit {
  id: string;
  name: string;
  ticker: string | null;
  exchange: string | null;
  currency: string;
  type: string;
}

const today = () => new Date().toISOString().slice(0, 10);

export function AddHolding({ portfolio, onAdded }: { portfolio: Portfolio; onAdded: () => void }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SecurityHit[]>([]);
  const [picked, setPicked] = useState<SecurityHit | null>(null);
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [tradeDate, setTradeDate] = useState(today());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Type-ahead against the real security master, debounced.
  useEffect(() => {
    if (picked || query.trim().length < 1) {
      setHits([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      api
        .get<{ data: SecurityHit[] }>(`/v1/securities?query=${encodeURIComponent(query.trim())}`)
        .then((r) => live && (setHits(r.data), setSearchError(null)))
        .catch((e) => live && setSearchError(describeError(e)));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, picked]);

  const reset = () => {
    setPicked(null);
    setQuery('');
    setQuantity('');
    setPrice('');
    setError(null);
  };

  const submit = async () => {
    if (!picked || !quantity.trim() || !price.trim()) return;
    setSaving(true);
    setError(null);
    try {
      // A holding you already own was not bought with cash Atlas tracks. Record
      // the matching funding first, exactly as the CSV import's "treat each buy
      // as funded" does — otherwise the buy invents negative cash and every
      // percentage Atlas shows is computed against a wrong denominator.
      const cost = (Number(quantity.trim()) * Number(price.trim())).toFixed(2);
      await api.post(`/v1/portfolios/${portfolio.id}/transactions`, {
        type: 'deposit',
        trade_date: tradeDate,
        amount: cost,
        currency: picked.currency,
      });
      await api.post(`/v1/portfolios/${portfolio.id}/transactions`, {
        type: 'buy',
        security_id: picked.id,
        trade_date: tradeDate,
        quantity: quantity.trim(),
        price: price.trim(),
        currency: picked.currency,
      });
      reset();
      onAdded();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSaving(false);
    }
  };

  const ready = Boolean(picked && quantity.trim() && price.trim());

  return (
    <div>
      <h4>Add a holding</h4>

      {!picked ? (
        <label>
          Company or ticker
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. Apple, or AAPL"
            aria-label="Search for a company or ticker"
            autoComplete="off"
          />
          <span className="field-note">Start typing — Atlas will find it.</span>
        </label>
      ) : (
        <p>
          <strong>{picked.name}</strong>{' '}
          <span className="muted">
            {picked.ticker ?? ''} {picked.exchange ? `· ${picked.exchange}` : ''} · {picked.currency}
          </span>{' '}
          <button className="link" onClick={reset}>
            change
          </button>
        </p>
      )}

      {searchError && <div className="state-error" role="alert">{searchError}</div>}

      {!picked && hits.length > 0 && (
        <ul className="plain" role="listbox" aria-label="Matching securities">
          {hits.map((h) => (
            <li key={h.id}>
              <button className="row" role="option" aria-selected="false" onClick={() => setPicked(h)}>
                <strong>{h.name}</strong>{' '}
                <span className="muted">
                  {h.ticker ?? ''} {h.exchange ? `· ${h.exchange}` : ''} · {h.currency}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {!picked && query.trim().length > 0 && hits.length === 0 && !searchError && (
        <p className="hint">No match yet. Try the ticker, or a shorter part of the name.</p>
      )}

      {picked && (
        <>
          <div className="inline">
            <label>
              How many shares
              <input
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                inputMode="decimal"
                placeholder="100"
                aria-label="Number of shares"
              />
            </label>
            <label>
              Price per share ({picked.currency})
              <input
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                inputMode="decimal"
                placeholder="210.50"
                aria-label={`Price per share in ${picked.currency}`}
              />
            </label>
            <label>
              Date you bought it
              <input
                type="date"
                value={tradeDate}
                max={today()}
                onChange={(e) => setTradeDate(e.target.value)}
                aria-label="Date you bought it"
              />
            </label>
          </div>
          <span className="field-note">
            Use what you actually paid — Atlas measures your return against it, not against today's
            price. Atlas assumes you funded this purchase yourself; record spare cash separately below.
          </span>
          {error && <div className="state-error" role="alert">{error}</div>}
          <div className="inline">
            <button onClick={submit} disabled={!ready || saving}>
              {saving ? 'Adding…' : 'Add holding'}
            </button>
            <button className="link" onClick={reset} disabled={saving}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
