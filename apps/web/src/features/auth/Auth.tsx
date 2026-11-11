import { useState } from 'react';
import { api, ApiError, type Me } from '../../api';

export function Auth({ onAuthed }: { onAuthed: (me: Me) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [jurisdiction, setJurisdiction] = useState('ES');
  const [baseCurrency, setBaseCurrency] = useState('EUR');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      if (mode === 'register') {
        await api.post('/v1/auth/register', {
          email,
          password,
          jurisdiction,
          base_currency: baseCurrency,
        });
      } else {
        await api.post('/v1/auth/login', { email, password });
      }
      onAuthed(await api.get<Me>('/v1/me'));
    } catch (e) {
      setError(e instanceof ApiError ? `${e.problem.title}${e.problem.detail ? ` — ${e.problem.detail}` : ''}` : String(e));
    }
  };

  return (
    <div className="shell narrow">
      <h1>Atlas</h1>
      <p className="muted">Clarity about what you own.</p>
      <div className="card">
        <label>Email<input value={email} onChange={(e) => setEmail(e.target.value)} type="email" /></label>
        <label>Password<input value={password} onChange={(e) => setPassword(e.target.value)} type="password" /></label>
        {mode === 'register' && (
          <>
            <label>Jurisdiction
              <select value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)}>
                {['ES', 'DE', 'FR', 'IE', 'NL', 'IT', 'PT', 'AT', 'BE', 'US', 'GB'].map((j) => (
                  <option key={j}>{j}</option>
                ))}
              </select>
            </label>
            <label>Base currency
              <select value={baseCurrency} onChange={(e) => setBaseCurrency(e.target.value)}>
                {['EUR', 'USD', 'GBP', 'CHF'].map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
          </>
        )}
        {error && <div className="error">{error}</div>}
        <button onClick={submit}>{mode === 'login' ? 'Log in' : 'Create account'}</button>
        <button className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? 'Need an account? Register' : 'Have an account? Log in'}
        </button>
      </div>
    </div>
  );
}
