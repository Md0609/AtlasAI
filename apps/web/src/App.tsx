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
import { AddHolding } from './add-holding';
import { RegisterProvider, Term, useCopy } from './register';

const pct = (w: string | null | undefined, dp = 2) =>
  w == null ? '—' : `${(Number(w) * 100).toFixed(dp)}%`;
const num = (v: string | null | undefined, dp = 2) =>
  v == null ? '—' : Number(v).toLocaleString('en-GB', { maximumFractionDigits: dp });

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

/** Jurisdiction drives lawful behaviour (FR-1.3) — but the user should be
 *  asked a question, not shown a legal term and a list of country codes. */
const COUNTRIES: Array<[string, string]> = [
  ['ES', 'Spain'], ['DE', 'Germany'], ['FR', 'France'], ['IE', 'Ireland'],
  ['NL', 'Netherlands'], ['IT', 'Italy'], ['PT', 'Portugal'], ['AT', 'Austria'],
  ['BE', 'Belgium'], ['US', 'United States'], ['GB', 'United Kingdom'],
];

function Auth({ onAuthed }: { onAuthed: (me: Me) => void }) {
  // A first-time visitor is here to sign up; make that the primary path.
  const [mode, setMode] = useState<'login' | 'register'>('register');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [jurisdiction, setJurisdiction] = useState('ES');
  const [baseCurrency, setBaseCurrency] = useState('EUR');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setBusy(true);
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
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shell narrow">
      <h1>Atlas</h1>
      {/* What this is, and — just as important — what it will not do. */}
      <p className="muted">
        Atlas tells you what you actually own, and what it means for you. It never tells you what to
        buy or sell.
      </p>

      <div className="card">
        <label>
          Email
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="email" />
        </label>
        <label>
          Password
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            aria-describedby={mode === 'register' ? 'pw-req' : undefined}
          />
          {mode === 'register' && (
            <span className="field-note" id="pw-req">At least 10 characters.</span>
          )}
        </label>
        {mode === 'register' && (
          <>
            <label>
              Where do you pay tax?
              <select value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)}>
                {COUNTRIES.map(([code, name]) => (
                  <option key={code} value={code}>{name}</option>
                ))}
              </select>
              <span className="field-note">
                It decides which features Atlas may lawfully show you, and where your data lives.
              </span>
            </label>
            <label>
              Which currency do you think in?
              <select value={baseCurrency} onChange={(e) => setBaseCurrency(e.target.value)}>
                {['EUR', 'USD', 'GBP', 'CHF'].map((c) => <option key={c}>{c}</option>)}
              </select>
              <span className="field-note">Everything is converted into this so the totals make sense.</span>
            </label>
          </>
        )}
        {error && <div className="state-error" role="alert">{error}</div>}
        <button onClick={submit} disabled={busy || !email || !password}>
          {busy ? 'One moment…' : mode === 'login' ? 'Log in' : 'Create account'}
        </button>
        <button className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? 'Need an account? Register' : 'Already have an account? Log in'}
        </button>
        {mode === 'register' && (
          <p className="field-note" style={{ marginTop: 12 }}>
            Your data is yours — you can export or delete all of it at any time.
          </p>
        )}
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
  const [profile, setProfile] = useState<Profile | null>(null);

  const refresh = () =>
    api.get<{ data: Portfolio[] }>('/v1/portfolios').then((r) => setPortfolios(r.data));
  useEffect(() => {
    refresh();
    api
      .get<{ data: Profile | null }>('/v1/profile')
      .then((r) => {
        setProfile(r.data);
        setProfileState(r.data ? 'present' : 'missing');
      })
      .catch(() => setProfileState('missing'));
  }, []);

  // D-004: five primary destinations, no more. Settings is an account concern,
  // not a mode of use, so it lives in the account menu; the Weekly Review is
  // part of Today ("your week"), not a sixth tab.
  const [section, setSection] = useState<Section>('today');

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

  const openPortfolio = () => {
    // One portfolio is the common case — do not make her pick from a list of one.
    if (portfolios.length === 1) setSelected(portfolios[0]!);
    else setSection('portfolio');
  };

  return (
    <RegisterProvider experienceLevel={profile?.experienceLevel}>
    <div className="shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <header>
        <h1>Atlas</h1>
        <div className="account">
          <button className="link" aria-label="Account settings" onClick={() => setSection('settings')}>
            {me.email}
          </button>
          <button className="link" onClick={onLogout}>Log out</button>
        </div>
      </header>
      <nav className="tabs primary" aria-label="Primary">
        {PRIMARY.map(([key, label]) => (
          <button
            key={key}
            className={section === key ? 'tab active' : 'tab'}
            aria-current={section === key ? 'page' : undefined}
            onClick={() => (key === 'portfolio' ? openPortfolio() : setSection(key))}
          >
            {label}
          </button>
        ))}
        <CopilotHint />
      </nav>

      <main id="main">
      {section === 'today' && <TodayView onAddHoldings={openPortfolio} />}
      {section === 'radar' && <RadarPanel />}
      {section === 'journal' && <JournalView />}
      {section === 'copilot' && <CopilotHistory />}
      {section === 'settings' && <SettingsPanel />}
      {section === 'portfolio' && (
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
            <input
              aria-label="New portfolio name"
              placeholder="New portfolio name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button onClick={create}>Create</button>
          </div>
          {error && <div className="error">{error}</div>}
        </div>
      )}
      </main>
    </div>
    </RegisterProvider>
  );
}

type Section = 'today' | 'portfolio' | 'radar' | 'journal' | 'copilot' | 'settings';

/** D-004 — five destinations. Names are the PRD's deliberate vocabulary (§10.4). */
const PRIMARY: Array<[Section, string]> = [
  ['today', 'Today'],
  ['portfolio', 'Portfolio'],
  ['radar', 'Radar'],
  ['journal', 'Journal'],
  ['copilot', 'Copilot'],
];

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

/**
 * Four destinations instead of seven. Nothing was removed: Exposure and
 * Performance became sections of Overview (collapsed, with their headline
 * number always visible), and Import became an action inside Holdings rather
 * than a tab of its own. Fewer places to look, same depth once you are there.
 */
type Tab = 'overview' | 'holdings' | 'reasons' | 'rules';

const PORTFOLIO_TABS: Array<[Tab, string]> = [
  ['overview', 'Overview'],
  ['holdings', 'Holdings'],
  ['reasons', 'Reasons'],
  ['rules', 'Rules'],
];

function PortfolioView({ portfolio, onBack }: { portfolio: Portfolio; onBack: () => void }) {
  const [tab, setTab] = useState<Tab>('overview');
  // ⌘K here opens the Copilot already bound to THIS portfolio (§11.2).
  useCopilotSubject('portfolio', portfolio.id, portfolio.name);
  return (
    <div className="shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <header>
        <button className="link" onClick={onBack}>← Back</button>
        <h1>{portfolio.name} <span className="muted">{portfolio.base_currency}</span></h1>
      </header>
      <nav className="tabs primary" aria-label="Portfolio sections">
        {PORTFOLIO_TABS.map(([key, label]) => (
          <button
            key={key}
            className={tab === key ? 'tab active' : 'tab'}
            aria-current={tab === key ? 'page' : undefined}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
        <CopilotHint />
      </nav>

      <main id="main">
        {tab === 'overview' && <Overview portfolio={portfolio} onAddHoldings={() => setTab('holdings')} />}
        {tab === 'holdings' && <Holdings portfolio={portfolio} />}
        {tab === 'reasons' && <ThesisPanel portfolio={portfolio} />}
        {tab === 'rules' && <RulesPanel />}
      </main>
    </div>
  );
}

/** A section that shows its headline immediately and its detail on request. */
function Disclosure({ title, summary, children }: { title: string; summary?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="section">
      <div className="section-head">
        <h3>{title}</h3>
        <button className="link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide detail' : 'Show detail'}
        </button>
      </div>
      {summary && !open && <p className="summary-line">{summary}</p>}
      {open && children}
    </div>
  );
}

function Overview({ portfolio, onAddHoldings }: { portfolio: Portfolio; onAddHoldings: () => void }) {
  return (
    <div>
      <RealityCheck portfolio={portfolio} onAddHoldings={onAddHoldings} />
      <div className="card">
        <Disclosure
          title="Exposure"
          summary="Where your money actually sits — by sector, country and currency, looked through your funds."
        >
          <Exposure portfolio={portfolio} />
        </Disclosure>
        <Disclosure
          title="Performance"
          summary="What you earned, and what your timing cost you."
        >
          <Performance portfolio={portfolio} />
        </Disclosure>
      </div>
    </div>
  );
}

function Holdings({ portfolio }: { portfolio: Portfolio }) {
  const [importing, setImporting] = useState(false);
  const [nonce, setNonce] = useState(0);
  return (
    <div>
      <Positions key={nonce} portfolio={portfolio} />
      <div className="card">
        <div className="section-head">
          <h3>Import from a file</h3>
          <button className="link" aria-expanded={importing} onClick={() => setImporting((o) => !o)}>
            {importing ? 'Hide' : 'Import instead'}
          </button>
        </div>
        {!importing && (
          <p className="summary-line">Have a lot of positions? Import them from a broker export.</p>
        )}
        {importing && (
          <ImportCsv
            portfolio={portfolio}
            onDone={() => {
              setImporting(false);
              setNonce((n) => n + 1);
            }}
          />
        )}
      </div>
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
        <p className="muted">
          Nothing here yet. Add your holdings one at a time below, or import a file.
        </p>
      ) : (
        <table className="responsive">
          <thead><tr><th>Security</th><th>Qty</th><th>Avg cost</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.security_id}>
                {/* One element, not two loose nodes: stacked on mobile the cell
                    is a flex row, and loose nodes would spread apart. */}
                <td data-label="Security">
                  <span>{r.name} <span className="muted">{r.pricing_currency}</span></span>
                </td>
                <td data-label="Qty">{num(r.quantity, 4)}</td>
                <td data-label="Avg cost">{r.avg_cost ? `${num(r.avg_cost)} ${r.cost_currency}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '20px 0' }} />
      <AddHolding portfolio={portfolio} onAdded={refresh} />

      <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '20px 0' }} />
      <h3>Cash</h3>
      {cash.length === 0 ? (
        <p className="muted">
          No cash recorded. Add it only if you hold uninvested cash — it changes the percentages
          Atlas shows you.
        </p>
      ) : (
        <ul className="plain">
          {cash.map((c) => <li key={c.currency}>{num(c.amount)} {c.currency}</li>)}
        </ul>
      )}
      <div className="inline">
        <label>
          Cash held ({portfolio.base_currency})
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            aria-label={`Cash held in ${portfolio.base_currency}`}
          />
        </label>
        <button className="secondary" onClick={deposit}>Record cash</button>
      </div>
    </div>
  );
}

const DIMENSIONS: Array<['sector' | 'country' | 'currency', string]> = [
  ['sector', 'Sector'],
  ['country', 'Country'],
  ['currency', 'Currency'],
];

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
  const dimensionLabel = DIMENSIONS.find(([k]) => k === d.dimension)?.[1] ?? d.dimension;
  return (
    <div className="card">
      <div className="inline" role="group" aria-label="Break exposure down by">
        {DIMENSIONS.map(([key, label]) => (
          <button
            key={key}
            className={dimension === key ? 'tab active' : 'tab'}
            aria-pressed={dimension === key}
            onClick={() => setDimension(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <p>Total value: <strong>{num(d.total_value_base)} {d.base_currency}</strong> · cash {pct(d.cash_weight)}</p>
      <table className="responsive">
        <thead><tr><th>{dimensionLabel}</th><th>Weight</th></tr></thead>
        <tbody>
          {d.slices.map((s) => (
            <tr key={s.key} className={s.key === 'UNKNOWN' ? 'unknown' : ''}>
              {/* "UNKNOWN" is what the data pipeline calls a gap. Say what it
                  means to the reader instead: Atlas cannot classify it, so the
                  percentage above it is not the whole picture. */}
              <td data-label={dimensionLabel}>
                {s.key === 'UNKNOWN' ? 'Not classified yet' : s.key}
              </td>
              <td data-label="Weight">{pct(s.weight)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4><Term k="look-through">Look-through</Term> (single names)</h4>
      <table className="responsive">
        <thead><tr><th>Name</th><th>Total</th><th>Direct</th><th>Via funds</th></tr></thead>
        <tbody>
          {d.look_through.map((r) => (
            <tr key={r.securityId ?? 'unknown'} className={r.securityId === null ? 'unknown' : ''}>
              <td data-label="Name">{r.label}</td><td data-label="Total">{pct(r.weight)}</td>
              <td data-label="Direct">{pct(r.viaDirect)}</td><td data-label="Via funds">{pct(r.viaFunds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* Lead with the number a person can act on; keep the index for anyone
          who wants to check the arithmetic. */}
      <p>
        <Term k="concentration">Concentration</Term>: your money behaves like{' '}
        <strong>
          <Term k="effective n">{Number(d.concentration.effectiveN).toFixed(1)} effective holdings</Term>
        </strong>{' '}
        across {d.concentration.nominalN} names.{' '}
        <span className="muted">
          <Term k="hhi">HHI</Term> {Number(d.concentration.hhi).toFixed(3)}
        </span>
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
      <table className="responsive">
        <tbody>
          <tr><td data-label="Return"><Term k="twr">Time-weighted return (TWR)</Term></td><td data-label="Value">{pct(d.twr, 3)}</td></tr>
          <tr><td data-label="Return"><Term k="mwr">Money-weighted return (MWR / XIRR)</Term></td><td data-label="Value">{pct(d.mwr, 3)}</td></tr>
          <tr><td data-label="Return">Max drawdown</td><td data-label="Value">{pct(d.max_drawdown)}</td></tr>
          <tr><td data-label="Return">Current drawdown</td><td data-label="Value">{pct(d.current_drawdown)}</td></tr>
        </tbody>
      </table>
      <h4>What the holding did, and what the exchange rate did</h4>
      <p className="summary-line">
        Split per pricing currency, so you can see how much of your return was the investment and
        how much was {portfolio.base_currency} moving.
      </p>
      <table className="responsive">
        <thead><tr><th>Currency</th><th>Local return</th><th>FX return</th></tr></thead>
        <tbody>
          {(d.currency_decomposition ?? []).map((c) => (
            <tr key={c.currency}>
              <td data-label="Currency">{c.currency}</td>
              <td data-label="Local return">{pct(c.localReturn, 3)}</td>
              <td data-label="FX return">{pct(c.fxReturn, 3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {resp.gaps.length > 0 && resp.gaps.map((g, i) => <div key={i} className="gaps">⚠ {g.reason}</div>)}
    </div>
  );
}

// CSV import UI lives in import-csv.tsx (shared with onboarding).
