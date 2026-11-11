import { useEffect, useState } from 'react';
import { api, ApiError, type Me, type Portfolio } from '../../api';
import { PortfolioView } from './PortfolioView';

export function Home({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [selected, setSelected] = useState<Portfolio | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    api.get<{ data: Portfolio[] }>('/v1/portfolios').then((r) => setPortfolios(r.data));
  useEffect(() => {
    refresh();
  }, []);

  const create = async () => {
    setError(null);
    try {
      await api.post('/v1/portfolios', { name: name || 'My portfolio', type: 'taxable', base_currency: me.base_currency });
      setName('');
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.problem.title : String(e));
    }
  };

  if (selected) {
    return <PortfolioView portfolio={selected} onBack={() => { setSelected(null); refresh(); }} />;
  }

  return (
    <div className="shell">
      <header>
        <h1>Atlas</h1>
        <div className="muted">{me.email} · {me.jurisdiction} <button className="link" onClick={onLogout}>Log out</button></div>
      </header>
      <h2>Portfolios</h2>
      <div className="card">
        {portfolios.length === 0 && <p className="muted">No portfolios yet.</p>}
        <ul className="plain">
          {portfolios.map((p) => (
            <li key={p.id}>
              <button className="row" onClick={() => setSelected(p)}>
                <strong>{p.name}</strong> <span className="muted">{p.type} · {p.base_currency}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="inline">
          <input placeholder="New portfolio name" value={name} onChange={(e) => setName(e.target.value)} />
          <button onClick={create}>Create</button>
        </div>
        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}
