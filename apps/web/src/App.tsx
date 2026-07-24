import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type ExposureResponse,
  type Me,
  type PerformanceResponse,
  type Portfolio,
  type PositionRow,
  type Profile,
} from './api';
import { ImportCsv } from './import-csv';
import { Onboarding } from './onboarding';
import { RealityCheck } from './reality-ui';
import { RulesPanel } from './rules-ui';
import { TodayView } from './today-ui';
import { ThesisPanel } from './thesis-ui';
import { RadarPanel } from './radar-ui';
import { JournalView } from './journal-ui';
import { CopilotProvider, CopilotHistory, useCopilot, useCopilotSubject } from './copilot-ui';
import { SettingsPanel } from './settings-ui';
import { WeeklyReviewView } from './weekly-review-ui';

const pct = (w: string | null | undefined, dp = 2) =>
  w == null ? '—' : `${(Number(w) * 100).toFixed(dp)}%`;
const num = (v: string | null | undefined, dp = 2) =>
  v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: dp });

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<Me>('/v1/me')
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="shell">Loading…</div>;
  if (!me) return <Auth onAuthed={setMe} />;
  // Copilot is ambient (§11.2): the provider installs the global ⌘K listener
  // and the overlay across every authed surface.
  return (
    <CopilotProvider>
      <Home me={me} onLogout={() => api.post('/v1/auth/logout').then(() => setMe(null))} />
    </CopilotProvider>
  );
}

// ---------------------------------------------------------------------------

function Auth({ onAuthed }: { onAuthed: (me: Me) => void }) {
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

// ---------------------------------------------------------------------------

function Home({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [selected, setSelected] = useState<Portfolio | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Onboarding gate (D-002): no profile yet → the adaptive flow, portfolio
  // first, Reality Check before any question.
  const [profileState, setProfileState] = useState<'loading' | 'missing' | 'present'>('loading');

  const refresh = () =>
    api.get<{ data: Portfolio[] }>('/v1/portfolios').then((r) => setPortfolios(r.data));
  useEffect(() => {
    refresh();
    api
      .get<{ data: Profile | null }>('/v1/profile')
      .then((r) => setProfileState(r.data ? 'present' : 'missing'))
      .catch(() => setProfileState('missing'));
  }, []);

  // §11.1 primary destinations available at Phase 3: Today, Portfolio,
  // Radar, Journal. Copilot arrives with the intelligence plane (Phase 4b).
  const [section, setSection] = useState<'today' | 'portfolios' | 'radar' | 'review' | 'journal' | 'copilot' | 'settings'>('today');

  if (profileState === 'loading') return <div className="shell">Loading…</div>;
  if (profileState === 'missing') {
    return <Onboarding me={me} onComplete={() => { setProfileState('present'); refresh(); }} />;
  }

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
      <nav className="tabs">
        {(['today', 'portfolios', 'radar', 'review', 'journal', 'copilot', 'settings'] as const).map((s) => (
          <button key={s} className={section === s ? 'tab active' : 'tab'} onClick={() => setSection(s)}>
            {s}
          </button>
        ))}
        <CopilotHint />
      </nav>

      {section === 'today' && <TodayView />}
      {section === 'radar' && <RadarPanel />}
      {section === 'review' && <WeeklyReviewView />}
      {section === 'journal' && <JournalView />}
      {section === 'copilot' && <CopilotHistory />}
      {section === 'settings' && <SettingsPanel />}
      {section === 'portfolios' && (
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
      )}
    </div>
  );
}

// A persistent, always-available Copilot affordance (§11.2). ⌘K works anywhere;
// this button is the visible handle for it.
function CopilotHint() {
  const { open } = useCopilot();
  return (
    <button className="tab cmdk-hint" onClick={open} title="Ask Atlas about what you're viewing (⌘K)">
      Ask Atlas <kbd>⌘K</kbd>
    </button>
  );
}

// ---------------------------------------------------------------------------

type Tab = 'reality' | 'positions' | 'theses' | 'exposure' | 'performance' | 'rules' | 'import';

function PortfolioView({ portfolio, onBack }: { portfolio: Portfolio; onBack: () => void }) {
  const [tab, setTab] = useState<Tab>('reality');
  // ⌘K here opens the Copilot already bound to THIS portfolio (§11.2).
  useCopilotSubject('portfolio', portfolio.id, portfolio.name);
  return (
    <div className="shell">
      <header>
        <button className="link" onClick={onBack}>← Portfolios</button>
        <h1>{portfolio.name} <span className="muted">{portfolio.base_currency}</span></h1>
      </header>
      <nav className="tabs">
        {(['reality', 'positions', 'theses', 'exposure', 'performance', 'rules', 'import'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
            {t === 'reality' ? 'reality check' : t}
          </button>
        ))}
      </nav>
      {tab === 'reality' && <RealityCheck portfolio={portfolio} />}
      {tab === 'positions' && <Positions portfolio={portfolio} />}
      {tab === 'theses' && <ThesisPanel portfolio={portfolio} />}
      {tab === 'exposure' && <Exposure portfolio={portfolio} />}
      {tab === 'performance' && <Performance portfolio={portfolio} />}
      {tab === 'rules' && <RulesPanel />}
      {tab === 'import' && <ImportCsv portfolio={portfolio} onDone={() => setTab('positions')} />}
    </div>
  );
}

function Positions({ portfolio }: { portfolio: Portfolio }) {
  const [rows, setRows] = useState<PositionRow[]>([]);
  const [cash, setCash] = useState<Array<{ currency: string; amount: string }>>([]);
  const [amount, setAmount] = useState('10000');

  const refresh = () =>
    api
      .get<{ data: { positions: PositionRow[]; cash: Array<{ currency: string; amount: string }> } }>(
        `/v1/portfolios/${portfolio.id}/positions`,
      )
      .then((r) => {
        setRows(r.data.positions);
        setCash(r.data.cash);
      });
  useEffect(() => {
    refresh();
  }, [portfolio.id]);

  const deposit = async () => {
    await api.post(`/v1/portfolios/${portfolio.id}/transactions`, {
      type: 'deposit',
      trade_date: new Date().toISOString().slice(0, 10),
      amount,
      currency: portfolio.base_currency,
    });
    await refresh();
  };

  return (
    <div className="card">
      <h3>Positions</h3>
      {rows.length === 0 ? (
        <p className="muted">No positions. Import a CSV or add transactions.</p>
      ) : (
        <table>
          <thead><tr><th>Security</th><th>Qty</th><th>Avg cost</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.security_id}>
                <td>{r.name} <span className="muted">{r.pricing_currency}</span></td>
                <td>{num(r.quantity, 4)}</td>
                <td>{r.avg_cost ? `${num(r.avg_cost)} ${r.cost_currency}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>Cash</h3>
      {cash.length === 0 ? <p className="muted">No cash recorded.</p> : (
        <ul className="plain">
          {cash.map((c) => <li key={c.currency}>{num(c.amount)} {c.currency}</li>)}
        </ul>
      )}
      <div className="inline">
        <input value={amount} onChange={(e) => setAmount(e.target.value)} />
        <button onClick={deposit}>Deposit {portfolio.base_currency}</button>
      </div>
    </div>
  );
}

function Exposure({ portfolio }: { portfolio: Portfolio }) {
  const [dimension, setDimension] = useState<'sector' | 'country' | 'currency'>('sector');
  const [resp, setResp] = useState<ExposureResponse | null>(null);

  useEffect(() => {
    api
      .get<ExposureResponse>(`/v1/portfolios/${portfolio.id}/exposure?dimension=${dimension}`)
      .then(setResp)
      .catch(() => setResp(null));
  }, [portfolio.id, dimension]);

  if (!resp) return <div className="card muted">Loading…</div>;
  const d = resp.data;
  return (
    <div className="card">
      <div className="inline">
        {(['sector', 'country', 'currency'] as const).map((x) => (
          <button key={x} className={dimension === x ? 'tab active' : 'tab'} onClick={() => setDimension(x)}>{x}</button>
        ))}
      </div>
      <p>Total value: <strong>{num(d.total_value_base)} {d.base_currency}</strong> · cash {pct(d.cash_weight)}</p>
      <table>
        <thead><tr><th>{d.dimension}</th><th>Weight</th></tr></thead>
        <tbody>
          {d.slices.map((s) => (
            <tr key={s.key} className={s.key === 'UNKNOWN' ? 'unknown' : ''}>
              <td>{s.key}</td><td>{pct(s.weight)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>Look-through (single names)</h4>
      <table>
        <thead><tr><th>Name</th><th>Total</th><th>Direct</th><th>Via funds</th></tr></thead>
        <tbody>
          {d.look_through.map((r) => (
            <tr key={r.securityId ?? 'unknown'} className={r.securityId === null ? 'unknown' : ''}>
              <td>{r.label}</td><td>{pct(r.weight)}</td><td>{pct(r.viaDirect)}</td><td>{pct(r.viaFunds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">
        Concentration: HHI {Number(d.concentration.hhi).toFixed(3)} · effective N{' '}
        {Number(d.concentration.effectiveN).toFixed(2)} of {d.concentration.nominalN} names
      </p>
      {resp.gaps.length > 0 && (
        <div className="gaps">
          {resp.gaps.map((g, i) => <div key={i}>⚠ {g.reason}</div>)}
        </div>
      )}
      <p className="provenance">
        engine {resp.provenance.engineVersion} · {resp.provenance.methodology} · inputs{' '}
        {resp.provenance.inputHash.slice(0, 12)}… · prices as of {resp.staleness.prices_as_of ?? '—'} · holdings as of{' '}
        {resp.staleness.holdings_as_of ?? '—'}
      </p>
    </div>
  );
}

function Performance({ portfolio }: { portfolio: Portfolio }) {
  const [resp, setResp] = useState<PerformanceResponse | null>(null);
  useEffect(() => {
    api
      .get<PerformanceResponse>(`/v1/portfolios/${portfolio.id}/performance?method=both`)
      .then(setResp)
      .catch(() => setResp(null));
  }, [portfolio.id]);

  if (!resp) return <div className="card muted">Loading…</div>;
  if (!resp.data) {
    return (
      <div className="card">
        <p className="muted">Not enough history yet.</p>
        {resp.gaps.map((g, i) => <div key={i} className="gaps">⚠ {g.reason}</div>)}
      </div>
    );
  }
  const d = resp.data;
  return (
    <div className="card">
      <p className="muted">Window {d.window?.from} → {d.window?.to}</p>
      <table>
        <tbody>
          <tr><td>Time-weighted return (TWR)</td><td>{pct(d.twr, 3)}</td></tr>
          <tr><td>Money-weighted return (MWR / XIRR)</td><td>{pct(d.mwr, 3)}</td></tr>
          <tr><td>Max drawdown</td><td>{pct(d.max_drawdown)}</td></tr>
          <tr><td>Current drawdown</td><td>{pct(d.current_drawdown)}</td></tr>
        </tbody>
      </table>
      <h4>Local vs FX return (per pricing currency)</h4>
      <table>
        <thead><tr><th>Currency</th><th>Local return</th><th>FX return</th></tr></thead>
        <tbody>
          {(d.currency_decomposition ?? []).map((c) => (
            <tr key={c.currency}>
              <td>{c.currency}</td><td>{pct(c.localReturn, 3)}</td><td>{pct(c.fxReturn, 3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {resp.gaps.length > 0 && resp.gaps.map((g, i) => <div key={i} className="gaps">⚠ {g.reason}</div>)}
    </div>
  );
}

// CSV import UI lives in import-csv.tsx (shared with onboarding).
