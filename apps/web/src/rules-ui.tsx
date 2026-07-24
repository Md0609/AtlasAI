/**
 * Rules & Adherence (F-05, §14.6): each rule shows current value, limit,
 * status, breach duration, and — critically — the reason the user gave when
 * they set it, quoted back. Removal requires writing a reason: the friction
 * is the feature.
 */
import { useEffect, useState } from 'react';
import { api, ApiError, type RuleRow, type RuleSuggestion } from './api';

const pctOrRaw = (v: string | null, type: string) => {
  if (v === null) return '—';
  if (['max_positions', 'min_holding_period', 'no_buy_list'].includes(type)) return v;
  return `${(Number(v) * 100).toFixed(1)}%`;
};

function breachDuration(since: string | null): string {
  if (!since) return '';
  const days = Math.floor((Date.now() - Date.parse(since)) / 86_400_000);
  if (days < 1) return 'today';
  if (days < 14) return `${days} day(s)`;
  return `${Math.floor(days / 7)} week(s)`;
}

export function RulesPanel() {
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [suggestions, setSuggestions] = useState<RuleSuggestion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeReason, setRemoveReason] = useState('');

  const refresh = () => api.get<{ data: RuleRow[] }>('/v1/rules').then((r) => setRules(r.data));
  useEffect(() => {
    refresh();
    api
      .get<{ data: RuleSuggestion[] }>('/v1/rules/suggestions')
      .then((r) => setSuggestions(r.data))
      .catch(() => setSuggestions([]));
  }, []);

  const adopt = async (s: RuleSuggestion, reason: string) => {
    setError(null);
    try {
      await api.post('/v1/rules', { type: s.type, params: s.params, stated_reason: reason });
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.problem.detail ?? e.problem.title : String(e));
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await api.del(`/v1/rules/${id}`, { reason: removeReason });
      setRemoving(null);
      setRemoveReason('');
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.problem.detail ?? e.problem.title : String(e));
    }
  };

  const active = new Set(rules.map((r) => r.type));

  return (
    <div>
      <div className="card">
        <h3>Your rules</h3>
        {rules.length === 0 && (
          <p className="muted">
            No rules yet. A rule is a commitment your future self is held to — Atlas evaluates every
            rule against your whole portfolio on every change, deterministically.
          </p>
        )}
        {rules.map((r) => (
          <div key={r.id} className={r.evaluation?.status === 'breach' ? 'rule breach' : 'rule'}>
            <div className="rule-head">
              <strong>{labelFor(r)}</strong>
              <span className={r.evaluation?.status === 'breach' ? 'status-breach' : 'status-ok'}>
                {r.evaluation
                  ? r.evaluation.status === 'breach'
                    ? `BREACH · ${breachDuration(r.evaluation.breach_since)}`
                    : r.evaluation.status
                  : 'not evaluated'}
              </span>
            </div>
            {r.evaluation?.observed.detail && <div className="muted">{r.evaluation.observed.detail}</div>}
            <blockquote>“{r.stated_reason}” <span className="muted">— you, when you set this rule</span></blockquote>
            {removing === r.id ? (
              <div className="inline">
                <input
                  aria-label="Why are you removing this rule?"
                  placeholder="Why are you removing this rule? (required)"
                  value={removeReason}
                  onChange={(e) => setRemoveReason(e.target.value)}
                />
                <button onClick={() => remove(r.id)} disabled={removeReason.trim().length === 0}>
                  Remove
                </button>
                <button className="link" onClick={() => setRemoving(null)}>Cancel</button>
              </div>
            ) : (
              <button className="link" onClick={() => { setRemoving(r.id); setRemoveReason(''); }}>
                Remove (requires a reason)
              </button>
            )}
          </div>
        ))}
        {error && <div className="error">{error}</div>}
      </div>

      {suggestions.filter((s) => !active.has(s.type)).length > 0 && (
        <div className="card">
          <h3>Suggested from your actual portfolio</h3>
          <ul className="plain">
            {suggestions
              .filter((s) => !active.has(s.type))
              .map((s) => (
                <SuggestionRow key={s.type} suggestion={s} onAdopt={adopt} />
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SuggestionRow({
  suggestion,
  onAdopt,
}: {
  suggestion: RuleSuggestion;
  onAdopt: (s: RuleSuggestion, reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  return (
    <li className="suggestion">
      <div>{suggestion.rationale}</div>
      {open ? (
        <div className="inline">
          <input
            aria-label="Why this rule?"
            placeholder="Why this rule? Your reason is quoted back at breach time."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button disabled={reason.trim().length === 0} onClick={() => onAdopt(suggestion, reason)}>
            Adopt
          </button>
          <button className="link" onClick={() => setOpen(false)}>Cancel</button>
        </div>
      ) : (
        <button className="link" onClick={() => setOpen(true)}>Adopt this rule →</button>
      )}
    </li>
  );
}

/**
 * A rule said the way its owner wrote it. Exported because Today has to name
 * the same rule in its open questions, and the two screens disagreeing about
 * what a rule is called would be its own small betrayal of trust.
 */
export function ruleLabel(type: string, params: Record<string, unknown> | undefined): string {
  const p = (params ?? {}) as { limit?: string; sector?: string; count?: number; months?: number; label?: string };
  switch (type) {
    case 'max_single_name':
      return `Max ${(Number(p.limit) * 100).toFixed(0)}% in a single name`;
    case 'max_sector':
      return `Max ${(Number(p.limit) * 100).toFixed(0)}% in ${p.sector}`;
    case 'min_cash':
      return `Keep at least ${(Number(p.limit) * 100).toFixed(0)}% cash`;
    case 'max_cash':
      return `Keep at most ${(Number(p.limit) * 100).toFixed(0)}% cash`;
    case 'no_buy_list':
      return `No-buy list${p.label ? `: ${p.label}` : ''}`;
    case 'max_positions':
      return `At most ${p.count} positions`;
    case 'min_holding_period':
      return `Hold at least ${p.months} months`;
    default:
      return type;
  }
}

function labelFor(r: RuleRow): string {
  return ruleLabel(r.type, r.params as Record<string, unknown>);
}

export { pctOrRaw };
