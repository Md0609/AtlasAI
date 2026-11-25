import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, type ExposureResponse, type PerformanceResponse, type Portfolio } from '../../api';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Spinner } from '../../components/Spinner';
import { formatDate, formatMoney, formatPct, isZeroDecimal, MISSING } from '../../components/format';

/**
 * Summary (objective.md AT-3): the first thing a portfolio shows. Four figures and one or two plain
 * sentences answering "how much do I have, where is it concentrated, how has it done, what don't we
 * know?". Every figure is a field of the engine's response, only formatted — nothing is recomputed,
 * re-sorted or normalised here (objective.md §6):
 *
 * - Total value            ← exposure `data.total_value_base` (+ `base_currency`).
 * - Period return          ← performance `data.twr` over `data.window`. `null` stays missing and
 *                            its gap is shown (ADR-001: unfunded purchases are never a 0 % return).
 * - Largest holding        ← exposure `data.concentration.topN[0]`: the engine's own ranking of
 *                            look-through single names by share of total value. Empty → no claim.
 * - Unknown                ← the exposure `data.look_through` row with `securityId: null`: the
 *                            engine's explicit unknown slice — value in funds whose holdings are
 *                            not known (lookthrough.ts `unknownWeight`). The engine emits that row
 *                            only when the slice is above zero, so its absence in a valued
 *                            portfolio is the engine reporting zero; it is not derived from the
 *                            other weights. This is NOT the sector `UNKNOWN` bucket, which also
 *                            counts names that lack a sector classification; that bucket is shown
 *                            next to it, labelled as such, never merged with it.
 *
 * Exposure and performance load independently: a failure in one never hides the other.
 */

type Load<T> =
  | { key: string; status: 'loading' }
  | { key: string; status: 'error'; title: string; traceId?: string }
  | { key: string; status: 'ok'; data: T };

/**
 * Fetches `path` and keeps the answer tagged with it. A response that arrives after the portfolio
 * changed is dropped (the effect is cancelled), and state tagged with another path reads as loading,
 * so figures of one portfolio never show under another.
 */
function useLoad<T>(path: string): { state: Load<T>; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const key = `${path}#${attempt}`;
  const [state, setState] = useState<Load<T>>({ key, status: 'loading' });

  useEffect(() => {
    let active = true;
    setState({ key, status: 'loading' });
    api
      .get<T>(path)
      .then((data) => active && setState({ key, status: 'ok', data }))
      .catch((e: unknown) => {
        if (!active) return;
        if (e instanceof ApiError) setState({ key, status: 'error', title: e.problem.title, traceId: e.problem.trace_id });
        else setState({ key, status: 'error', title: 'Could not reach the server' });
      });
    return () => {
      active = false;
    };
  }, [key]);

  return { state: state.key === key ? state : { key, status: 'loading' }, retry: () => setAttempt((n) => n + 1) };
}

function Kpi({
  id,
  label,
  value,
  children,
  source,
}: {
  id: string;
  label: string;
  value: ReactNode;
  children?: ReactNode;
  source?: ReactNode;
}) {
  return (
    <li className="kpi">
      <h3 className="kpi-label" id={`${id}-label`}>{label}</h3>
      <div className="kpi-value tnum">{value}</div>
      {children && <div className="kpi-note">{children}</div>}
      {source && (
        <details className="kpi-source">
          <summary>
            Source<span className="visually-hidden"> of {label}</span>
          </summary>
          {source}
        </details>
      )}
    </li>
  );
}

function LoadError({ what, state, onRetry }: { what: string; state: { title: string; traceId?: string }; onRetry: () => void }) {
  return (
    <div className="error" role="alert">
      Could not load {what}: {state.title}
      {state.traceId && <span className="muted"> (trace {state.traceId})</span>}{' '}
      <Button variant="secondary" onClick={onRetry}>Retry {what}</Button>
    </div>
  );
}

function ExposureSource({ resp, field }: { resp: ExposureResponse; field: string }) {
  return (
    <p className="provenance">
      field <code>{field}</code> · engine {resp.provenance.engineVersion} · {resp.provenance.methodology} · inputs{' '}
      {resp.provenance.inputHash.slice(0, 12)}… · prices as of {formatDate(resp.staleness.prices_as_of)} · holdings
      as of {formatDate(resp.staleness.holdings_as_of)}
    </p>
  );
}

export function Summary({ portfolio }: { portfolio: Portfolio }) {
  const exposure = useLoad<ExposureResponse>(`/v1/portfolios/${portfolio.id}/exposure?dimension=sector`);
  const performance = useLoad<PerformanceResponse>(`/v1/portfolios/${portfolio.id}/performance?method=both`);
  const ex = exposure.state.status === 'ok' ? exposure.state.data : null;
  const pf = performance.state.status === 'ok' ? performance.state.data : null;

  // --- exposure-derived figures (selection only, no arithmetic) -----------------------------------
  const d = ex?.data;
  const nothingValued = d ? isZeroDecimal(d.total_value_base) !== false : false;
  const top = d?.concentration.topN[0] ?? null;
  const unknownRow = d?.look_through.find((r) => r.securityId === null) ?? null;
  const sectorUnknown = d?.slices.find((s) => s.key === 'UNKNOWN') ?? null;
  /** The unknown share as the engine states it; `null` when there is nothing valued to speak of. */
  const unknownWeight = !d || nothingValued ? null : unknownRow ? unknownRow.weight : '0';

  // --- performance figures --------------------------------------------------------------------------
  const p = pf?.data ?? null;
  const twr = p?.twr ?? null;
  const window = p?.window;

  // --- deterministic sentences ----------------------------------------------------------------------
  const sentences: string[] = [];
  if (d) {
    if (nothingValued) {
      sentences.push('Nothing is valued yet: import transactions or record a deposit to see where the money is.');
    } else if (top) {
      sentences.push(
        `${top.label} is the largest underlying holding at ${formatPct(top.weight)} of the portfolio; ` +
          (unknownRow
            ? `${formatPct(unknownRow.weight)} sits in funds without holdings data and is shown as unknown, not spread across other names.`
            : 'the holdings of every fund are known, so no share is unknown.'),
      );
    } else if (unknownRow) {
      sentences.push(
        `No single names are visible yet; ${formatPct(unknownRow.weight)} sits in funds without holdings data and is shown as unknown.`,
      );
    } else {
      sentences.push('The portfolio holds no single names yet.');
    }
  }
  if (pf) {
    if (!p) sentences.push('There is not enough history yet to measure a return.');
    else if (twr !== null && twr !== undefined)
      sentences.push(
        `From ${formatDate(window?.from)} to ${formatDate(window?.to)} the time-weighted return was ${formatPct(twr)}.`,
      );
    else
      sentences.push(
        `No time-weighted return is shown for ${formatDate(window?.from)} to ${formatDate(window?.to)} because of a data gap (see below).`,
      );
  }

  const perfGapReason = pf?.gaps.find((g) => /TWR/.test(g.reason))?.reason ?? pf?.gaps[0]?.reason;
  const exLoading = exposure.state.status === 'loading';
  const pfLoading = performance.state.status === 'loading';

  return (
    <section className="card summary" aria-labelledby="summary-title">
      <h2 id="summary-title" className="summary-title">Summary</h2>

      {exposure.state.status === 'error' && (
        <LoadError what="exposure" state={exposure.state} onRetry={exposure.retry} />
      )}
      {performance.state.status === 'error' && (
        <LoadError what="performance" state={performance.state} onRetry={performance.retry} />
      )}

      {sentences.length > 0 && (
        <p className="summary-text" data-testid="summary-text">{sentences.join(' ')}</p>
      )}

      <ul className="kpis">
        <Kpi
          id="kpi-total"
          label={`Total value (${d?.base_currency ?? portfolio.base_currency})`}
          value={exLoading ? <Spinner /> : d ? formatMoney(d.total_value_base, d.base_currency) : MISSING}
          source={ex && <ExposureSource resp={ex} field="total_value_base" />}
        >
          {d && <span className="muted">Prices as of {formatDate(ex!.staleness.prices_as_of)}</span>}
          {exposure.state.status === 'error' && <span className="muted">Exposure unavailable.</span>}
        </Kpi>

        <Kpi
          id="kpi-return"
          label="Period return (TWR)"
          value={pfLoading ? <Spinner /> : twr !== null && twr !== undefined ? formatPct(twr) : MISSING}
          source={
            pf?.provenance && (
              <p className="provenance">
                field <code>twr</code> over <code>window</code> · engine {pf.provenance.engineVersion} ·{' '}
                {pf.provenance.methodology} · inputs {pf.provenance.inputHash.slice(0, 12)}… · prices as of{' '}
                {formatDate(pf.staleness.prices_as_of)}
              </p>
            )
          }
        >
          {p && (
            <span className="muted">
              {formatDate(window?.from)} → {formatDate(window?.to)}
            </span>
          )}
          {pf && !p && <span className="muted">Not enough history yet.</span>}
          {pf && p && (twr === null || twr === undefined) && perfGapReason && (
            <div><Badge tone="warning">Data gap</Badge> {perfGapReason}</div>
          )}
          {performance.state.status === 'error' && <span className="muted">Performance unavailable.</span>}
        </Kpi>

        <Kpi
          id="kpi-top"
          label="Largest holding (% of total)"
          value={exLoading ? <Spinner /> : top ? formatPct(top.weight) : MISSING}
          source={ex && <ExposureSource resp={ex} field="concentration.topN[0]" />}
        >
          {top && <span>{top.label} <span className="muted">· direct and via funds</span></span>}
          {d && !top && <span className="muted">No single names valued yet.</span>}
        </Kpi>

        <Kpi
          id="kpi-unknown"
          label="Unknown (% of total)"
          value={exLoading ? <Spinner /> : unknownWeight !== null ? formatPct(unknownWeight) : MISSING}
          source={ex && <ExposureSource resp={ex} field="look_through[securityId = null].weight" />}
        >
          {d && !nothingValued && (
            <span className="muted">
              {unknownRow ? 'Held in funds without holdings data.' : 'Every fund’s holdings are known.'}
            </span>
          )}
          {d && nothingValued && <span className="muted">Nothing valued yet.</span>}
          {d && unknownRow && (
            <span className="muted">Fund holdings as of {formatDate(ex!.staleness.holdings_as_of)}</span>
          )}
          {sectorUnknown && (
            <div className="muted">
              Sector not classified: {formatPct(sectorUnknown.weight)} (includes the unknown share above and names
              without a sector).
            </div>
          )}
        </Kpi>
      </ul>

      {((ex && ex.gaps.length > 0) || (pf && pf.gaps.length > 0)) && (
        <div className="gaps" aria-label="Data gaps">
          {ex?.gaps.map((g, i) => (
            <div key={`e${i}`}><Badge tone="warning">Data gap</Badge> {g.reason}</div>
          ))}
          {pf?.gaps.map((g, i) => (
            <div key={`p${i}`}><Badge tone="warning">Data gap</Badge> {g.reason}</div>
          ))}
        </div>
      )}
    </section>
  );
}
