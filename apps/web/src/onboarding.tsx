/**
 * Adaptive onboarding (F-01, D-002, §6.1): portfolio-first, payoff
 * front-loaded. Order is a hard rule: no question before the Reality Check
 * except jurisdiction (captured at registration) and the capital band.
 *
 *   capital band → portfolio in (CSV / manual) → ⚡ REALITY CHECK ⚡
 *   → strategy (4 cards + a first-class "I don't know yet" that runs
 *     inference and presents a hypothesis, US-ONB-03)
 *   → risk scenarios calibrated to the user's actual money (US-ONB-04)
 *   → rules pre-filled from the portfolio (US-ONB-05)
 *   → profile summary.
 */
import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type Me,
  type Portfolio,
  type Profile,
  type RiskScenario,
  type RuleSuggestion,
  type Strategy,
  type StrategyInference,
} from './api';
import { ImportCsv } from './import-csv';
import { RealityCheck } from './reality-ui';

type Step = 'basics' | 'portfolio' | 'reality' | 'strategy' | 'scenarios' | 'rules' | 'summary';

/** Ordered so the user always knows where they are and how much is left. */
const STEP_ORDER: Step[] = ['basics', 'portfolio', 'reality', 'strategy', 'scenarios', 'rules', 'summary'];
const STEP_LABEL: Record<Step, string> = {
  basics: 'About you',
  portfolio: 'Your holdings',
  reality: 'Reality Check',
  strategy: 'Your approach',
  scenarios: 'How you react',
  rules: 'Your rules',
  summary: 'Done',
};

function Progress({ step, onBack }: { step: Step; onBack?: () => void }) {
  const i = STEP_ORDER.indexOf(step);
  const pct = ((i + 1) / STEP_ORDER.length) * 100;
  return (
    <div className="progress">
      {onBack ? (
        <button className="link" onClick={onBack} aria-label="Go back a step">← Back</button>
      ) : (
        <span />
      )}
      <div className="progress-track" role="progressbar" aria-valuemin={1} aria-valuemax={STEP_ORDER.length} aria-valuenow={i + 1} aria-label="Setup progress">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="progress-label">
        Step {i + 1} of {STEP_ORDER.length} · {STEP_LABEL[step]}
      </span>
    </div>
  );
}

const STRATEGY_CARDS: Array<{ key: Strategy; title: string; blurb: string }> = [
  {
    key: 'quality_growth',
    title: 'Quality growth',
    blurb: 'Great businesses, growing, bought at a fair price and held for years.',
  },
  {
    key: 'value',
    title: 'Value',
    blurb: 'Out-of-favour businesses bought below what they are worth, patiently.',
  },
  {
    key: 'dividend_income',
    title: 'Dividend income',
    blurb: 'Reliable cash flows now; the share price is secondary.',
  },
  {
    key: 'passive_index',
    title: 'Passive indexing',
    blurb: 'Own the whole market cheaply and let time do the work.',
  },
];

const CAPITAL_BANDS = ['<25k', '25k-100k', '100k-500k', '>500k'] as const;

export function Onboarding({ me, onComplete }: { me: Me; onComplete: () => void }) {
  const [step, setStep] = useState<Step>('basics');
  const [error, setError] = useState<string | null>(null);

  // Collected along the way; submitted once at the end (FR-2.5: one explicit
  // user action writes the profile).
  const [capitalBand, setCapitalBand] = useState<(typeof CAPITAL_BANDS)[number] | ''>('');
  const [experience, setExperience] = useState('');
  // Answered, not blank. The field was empty while its placeholder read "10",
  // so the CTA was disabled for a question the user believed they had answered.
  const [horizon, setHorizon] = useState<number | ''>(10);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [statedStrategy, setStatedStrategy] = useState<Strategy | null>(null);
  const [inference, setInference] = useState<StrategyInference | null>(null);
  const [acceptedInference, setAcceptedInference] = useState(false);
  const [riskStated, setRiskStated] = useState(3);
  const [savedProfile, setSavedProfile] = useState<Profile | null>(null);
  const [scenarios, setScenarios] = useState<RiskScenario[]>([]);
  const [scenarioIdx, setScenarioIdx] = useState(0);
  const [scenarioBasis, setScenarioBasis] = useState<'portfolio' | 'capital_band'>('capital_band');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [suggestions, setSuggestions] = useState<RuleSuggestion[]>([]);
  const [adoptedRules, setAdoptedRules] = useState<Record<string, string>>({}); // type → reason

  const fail = (e: unknown) =>
    setError(e instanceof ApiError ? e.problem.detail ?? e.problem.title : String(e));

  const startPortfolio = async () => {
    setError(null);
    try {
      const p = await api.post<Portfolio>('/v1/portfolios', {
        name: 'My portfolio',
        type: 'taxable',
        base_currency: me.base_currency,
      });
      setPortfolio(p);
      setStep('portfolio');
    } catch (e) {
      fail(e);
    }
  };

  const toStrategy = async () => {
    setError(null);
    setStep('strategy');
    try {
      if (portfolio) {
        const r = await api.get<{ data: StrategyInference }>(
          `/v1/portfolios/${portfolio.id}/strategy-inference`,
        );
        setInference(r.data);
      }
    } catch {
      setInference(null);
    }
  };

  const toScenarios = async () => {
    setError(null);
    try {
      // Always send the band, even with a portfolio: an empty portfolio falls
      // back to the band midpoint server-side, and sending only portfolio_id
      // meant that fallback silently used the DEFAULT band rather than the one
      // the user just picked — calibrating "your" scenario to someone else's
      // money.
      const qs = [
        portfolio ? `portfolio_id=${portfolio.id}` : '',
        capitalBand ? `capital_band=${encodeURIComponent(capitalBand)}` : '',
      ]
        .filter(Boolean)
        .join('&');
      const r = await api.get<{ data: RiskScenario[]; basis: 'portfolio' | 'capital_band' }>(
        `/v1/profile/scenarios?${qs}`,
      );
      setScenarios(r.data);
      setScenarioBasis(r.basis ?? 'capital_band');
      setStep('scenarios');
    } catch (e) {
      fail(e);
    }
  };

  const toRules = async () => {
    setError(null);
    try {
      const r = await api.get<{ data: RuleSuggestion[] }>('/v1/rules/suggestions');
      setSuggestions(r.data);
      setStep('rules');
    } catch {
      setSuggestions([]);
      setStep('rules');
    }
  };

  const finish = async () => {
    setError(null);
    try {
      for (const s of suggestions) {
        const reason = adoptedRules[s.type];
        if (reason) {
          await api.post('/v1/rules', { type: s.type, params: s.params, stated_reason: reason });
        }
      }
      const saved = await api.post<{ data: Profile }>('/v1/profile', {
        experience_level: experience,
        horizon_years: horizon,
        capital_band: capitalBand,
        stated_strategy: statedStrategy ?? undefined,
        accepted_inference:
          acceptedInference && inference
            ? { hypothesis: inference.hypothesis, confidence: inference.confidence }
            : undefined,
        risk_stated: riskStated,
        scenario_answers: scenarios
          .filter((s) => answers[s.scenarioId])
          .map((s) => ({ scenario_id: s.scenarioId, prompt: s.prompt, answer: answers[s.scenarioId]! })),
      });
      setSavedProfile(saved.data);
      setStep('summary');
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div className="shell">
      <header>
        <h1>Atlas</h1>
        <span className="muted">Let's find out what you actually own.</span>
      </header>

      <Progress
        step={step}
        onBack={
          STEP_ORDER.indexOf(step) > 0 && step !== 'summary'
            ? () => setStep(STEP_ORDER[STEP_ORDER.indexOf(step) - 1]!)
            : undefined
        }
      />

      {step === 'basics' && (
        <div className="card">
          <h3>Three quick questions.</h3>
          <p className="muted">
            They calibrate what Atlas shows you. Then your portfolio — the interesting part comes fast.
          </p>
          <label>
            Roughly how much are you investing?
            <select value={capitalBand} onChange={(e) => setCapitalBand(e.target.value as never)}>
              <option value="">Choose…</option>
              {CAPITAL_BANDS.map((b) => <option key={b}>{b}</option>)}
            </select>
            <span className="field-note">Only used to size the examples Atlas shows you.</span>
          </label>
          <label>
            How long have you been investing?
            <select value={experience} onChange={(e) => setExperience(e.target.value)}>
              <option value="">Choose…</option>
              <option value="beginner">I'm new to this</option>
              <option value="intermediate">A few years</option>
              <option value="advanced">A long time, seriously</option>
              <option value="professional">Professionally</option>
            </select>
          </label>
          <label>
            When will you need this money? (years)
            <input
              type="number"
              min={1}
              max={80}
              value={horizon}
              placeholder="10"
              onChange={(e) => setHorizon(e.target.value === '' ? '' : Number(e.target.value))}
            />
          </label>
          <button onClick={startPortfolio} disabled={!capitalBand || !experience || !horizon}>
            Now the important part: what do you own? →
          </button>
          {(!capitalBand || !experience || !horizon) && (
            <p className="field-note">Answer the three above and this opens.</p>
          )}
          {error && <div className="error">{error}</div>}
        </div>
      )}

      {step === 'portfolio' && portfolio && (
        <div>
          <p className="muted">
            Import a CSV of your transactions — or skip and add positions later. The Reality Check
            works with whatever you give it.
          </p>
          <ImportCsv portfolio={portfolio} onDone={() => setStep('reality')} />
          <button className="link" onClick={() => setStep('reality')}>Skip for now →</button>
        </div>
      )}

      {step === 'reality' && portfolio && (
        <div>
          <RealityCheck portfolio={portfolio} />
          <button onClick={toStrategy}>Now I can make this useful. A few quick questions →</button>
        </div>
      )}

      {step === 'strategy' && (
        <div className="card">
          <h3>Which of these sounds most like you?</h3>
          <div className="strategy-grid">
            {STRATEGY_CARDS.map((c) => (
              <button
                key={c.key}
                className={statedStrategy === c.key && !acceptedInference ? 'strategy-card active' : 'strategy-card'}
                onClick={() => {
                  setStatedStrategy(c.key);
                  setAcceptedInference(false);
                }}
              >
                <strong>{c.title}</strong>
                <span className="muted">{c.blurb}</span>
              </button>
            ))}
            <button
              className={acceptedInference ? 'strategy-card active' : 'strategy-card'}
              onClick={() => {
                setStatedStrategy(null);
                setAcceptedInference(true);
              }}
            >
              <strong>I don't know yet</strong>
              <span className="muted">Completely fine. Atlas will tell you what your portfolio says.</span>
            </button>
          </div>
          {acceptedInference && inference && (
            <div className="card inner">
              <h4>
                Here's what your portfolio says you believe
                {inference.hypothesis !== 'unknown'
                  ? `: ${STRATEGY_CARDS.find((c) => c.key === inference.hypothesis)?.title ?? inference.hypothesis}`
                  : ''}
              </h4>
              {inference.hypothesis === 'unknown' ? (
                <p className="muted">
                  The portfolio doesn't clearly match any archetype yet — that's an honest answer,
                  and Atlas will refine it as your history grows.
                </p>
              ) : (
                <p className="muted">
                  Confidence {(Number(inference.confidence) * 100).toFixed(0)}%. This is a hypothesis
                  for you to confirm or correct — Atlas never changes your profile on its own.
                </p>
              )}
              <ul className="plain">
                {inference.evidence.map((ev) => <li key={ev.metric}>· {ev.observation}</li>)}
              </ul>
              {inference.gaps.map((g, i) => <div key={i} className="gaps">⚠ {g.reason}</div>)}
            </div>
          )}
          <button onClick={toScenarios} disabled={!statedStrategy && !acceptedInference}>
            Continue →
          </button>
          {error && <div className="error">{error}</div>}
        </div>
      )}

      {/* One situation at a time. These answers are a behavioural measurement,
          not a form to clear: putting all three plus a self-rating on one
          screen invites pattern-matching down the column instead of actually
          picturing each one. */}
      {step === 'scenarios' && (
        <div className="card">
          {scenarioIdx < scenarios.length ? (
            (() => {
              const s = scenarios[scenarioIdx]!;
              const answered = Boolean(answers[s.scenarioId]);
              return (
                <>
                  <div className="muted small">
                    Situation {scenarioIdx + 1} of {scenarios.length}
                  </div>
                  <h3>{s.prompt}</h3>
                  <p className="muted">
                    {scenarioBasis === 'portfolio'
                      ? 'This uses your actual portfolio value.'
                      : 'This uses an example figure based on the range you gave — you have not added holdings yet.'}{' '}
                    What you'd really do matters more than what you'd rate yourself.
                  </p>
                  <div className="scenario">
                    {s.options.map((o) => (
                      <label key={o.key} className="option">
                        <input
                          type="radio"
                          name={s.scenarioId}
                          checked={answers[s.scenarioId] === o.key}
                          onChange={() => setAnswers({ ...answers, [s.scenarioId]: o.key })}
                        />{' '}
                        {o.label}
                      </label>
                    ))}
                  </div>
                  <div className="inline">
                    <button disabled={!answered} onClick={() => setScenarioIdx((i) => i + 1)}>
                      {scenarioIdx + 1 === scenarios.length ? 'Last question →' : 'Next →'}
                    </button>
                    {scenarioIdx > 0 && (
                      <button className="link" onClick={() => setScenarioIdx((i) => i - 1)}>
                        Back
                      </button>
                    )}
                  </div>
                  {!answered && <p className="field-note">Pick the one closest to the truth.</p>}
                </>
              );
            })()
          ) : (
            <>
              <h3>And how would you rate your own risk tolerance?</h3>
              <p className="muted">
                1 cautious … 5 aggressive. Atlas compares this with what you just chose — the gap
                between the two is usually the interesting part.
              </p>
              <label>
                Your own rating
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={riskStated}
                  onChange={(e) => setRiskStated(Math.min(5, Math.max(1, Number(e.target.value) || 3)))}
                />
              </label>
              <div className="inline">
                <button onClick={toRules} disabled={scenarios.some((s) => !answers[s.scenarioId])}>
                  Continue →
                </button>
                <button className="link" onClick={() => setScenarioIdx(scenarios.length - 1)}>
                  Back
                </button>
              </div>
            </>
          )}
          {error && <div className="error">{error}</div>}
        </div>
      )}

      {step === 'rules' && (
        <div className="card">
          <h3>Any rules you want Atlas to hold you to?</h3>
          <p className="muted">
            Suggestions come from your actual portfolio. Each needs a reason in your own words —
            it will be quoted back to you if you ever breach the rule. Skippable.
          </p>
          {suggestions.length === 0 && <p className="muted">No suggestions without portfolio data — you can add rules any time.</p>}
          {suggestions.map((s) => (
            <div key={s.type} className="suggestion">
              <label className="option">
                <input
                  type="checkbox"
                  checked={s.type in adoptedRules}
                  onChange={(e) => {
                    const next = { ...adoptedRules };
                    if (e.target.checked) next[s.type] = '';
                    else delete next[s.type];
                    setAdoptedRules(next);
                  }}
                />{' '}
                {s.rationale}
              </label>
              {s.type in adoptedRules && (
                <input
                  placeholder="Why this rule? (required — your future self will read it)"
                  value={adoptedRules[s.type]}
                  onChange={(e) => setAdoptedRules({ ...adoptedRules, [s.type]: e.target.value })}
                />
              )}
            </div>
          ))}
          <button
            onClick={finish}
            disabled={Object.values(adoptedRules).some((r) => r.trim().length === 0)}
          >
            Finish →
          </button>
          {error && <div className="error">{error}</div>}
        </div>
      )}

      {step === 'summary' && (
        <div className="card">
          <h3>Here's what Atlas learned about you.</h3>
          <ul className="plain">
            {savedProfile && savedProfile.riskRevealed != null && (
              <li>
                ·{' '}
                {savedProfile.riskDivergenceFlag
                  ? `You called yourself a ${riskStated} out of 5 on risk, but your answers behave like a ${savedProfile.riskRevealed}. Atlas keeps both and will tell you when they disagree — it will never quietly pick one.`
                  : `Your answers line up with how you describe yourself: about ${savedProfile.riskRevealed} out of 5 on risk. Atlas will tell you if that ever stops being true.`}
              </li>
            )}
            {acceptedInference && inference && inference.hypothesis !== 'unknown' && (
              <li>
                · Strategy recorded as inferred:{' '}
                {STRATEGY_CARDS.find((c) => c.key === inference.hypothesis)?.title ?? inference.hypothesis}{' '}
                ({(Number(inference.confidence) * 100).toFixed(0)}% confidence). Correct it any time.
              </li>
            )}
            {statedStrategy && (
              <li>
                · Strategy recorded as stated:{' '}
                {STRATEGY_CARDS.find((c) => c.key === statedStrategy)?.title ?? statedStrategy}.
              </li>
            )}
            <li>· Nothing here is locked in. Change any of it whenever you like — Atlas keeps the history so you can see how your thinking moved.</li>
            {Object.keys(adoptedRules).length > 0 && (
              <li>· {Object.keys(adoptedRules).length} rule(s) active, evaluated on every portfolio change.</li>
            )}
          </ul>
          <button onClick={onComplete}>Go to your portfolio →</button>
        </div>
      )}
    </div>
  );
}
