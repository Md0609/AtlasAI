/**
 * Portfolio Reality Check — Surprise Detector (surprise.v1), F-09 / §14.3.
 *
 * "The Surprise Detector's job is ranking, not detection — detection is
 * trivial." Detectors fire deterministically; each finding is scored
 * magnitude × unawareness prior and only the top 3 are surfaced. The prior
 * ranks by *information the user could not have had*: hidden fund exposure
 * outranks a big position they typed in themselves.
 *
 * Narration is template v0 (Design §B1 Phase 2): every numeral in the
 * rendered strings is computed here and also returned machine-readable in
 * `values`. LLM narration arrives in Phase 4b behind the Guard; these
 * templates then become the permanent degradation path (§B10).
 */
import type {
  CorrelationResult,
  RealityCheckResult,
  Strategy,
  Surprise,
  SurpriseKind,
} from '@atlas/contracts';
import { Dec, ZERO, dec, fixed, str } from '@atlas/domain';
import type { PortfolioSignals } from './engine.js';

/** Unawareness priors (§14.3): rank what the broker UI cannot show first. */
const PRIOR: Record<SurpriseKind, string> = {
  lookthrough_gap: '0.9',
  correlation_cluster: '0.8',
  foreign_currency: '0.7',
  effective_n: '0.6',
  strategy_mismatch: '0.5',
  single_name_concentration: '0.3',
};

const LOOKTHROUGH_GAP_MIN = dec('0.03'); // D1: >3pp arriving via funds
const EFFECTIVE_N_RATIO = dec('0.5'); // D2: effective < half of nominal
const SINGLE_NAME_LIMIT = dec('0.15'); // D4
const FOREIGN_CCY_LIMIT = dec('0.5'); // D5
const CLUSTER_LIMIT = dec('0.25'); // D8

/**
 * Magnitudes are normalized to 0..1 per detector (excess over the trigger,
 * relative to a per-detector scale) so that magnitude × prior is comparable
 * across detectors. Without this, detectors with naturally larger raw
 * numbers would always win the ranking regardless of the prior.
 */
function normalized(excess: Dec, scale: Dec): Dec {
  const m = excess.div(scale);
  return m.gt(1) ? dec(1) : m.lt(0) ? ZERO : m;
}

export interface SurpriseContext {
  signals: PortfolioSignals;
  correlation: CorrelationResult | null;
  /** From the profile, when one exists — enables D6. */
  statedStrategy: Strategy | null;
  inferredStrategy: Strategy | null;
  baseCurrency: string;
}

const pct = (d: Dec, dp = 1) => `${fixed(d.times(100), dp)}%`;

export function detectSurprises(ctx: SurpriseContext): RealityCheckResult {
  const { signals } = ctx;
  const surprises: Surprise[] = [];
  const warnings: string[] = [...(ctx.correlation?.warnings ?? [])];
  const gaps: RealityCheckResult['gaps'] = [];

  const named = signals.lookThrough.value.filter((r) => r.securityId !== null);

  // D1 — look-through gap: exposure arriving through funds the broker UI hides.
  let bestGap: (typeof named)[number] | null = null;
  for (const r of named) {
    if (dec(r.viaFunds).gte(LOOKTHROUGH_GAP_MIN)) {
      if (!bestGap || dec(r.viaFunds).gt(bestGap.viaFunds)) bestGap = r;
    }
  }
  if (bestGap) {
    const direct = dec(bestGap.viaDirect);
    const total = dec(bestGap.weight);
    surprises.push(
      make('lookthrough_gap', normalized(dec(bestGap.viaFunds), dec('0.1')), {
        headline: `You own more ${bestGap.label} than you think.`,
        body: direct.gt(0)
          ? `Your direct ${bestGap.label} position is ${pct(direct)} of the portfolio. But your funds ` +
            `hold it too: the real exposure is ${pct(total)} — ${pct(dec(bestGap.viaFunds))} arrives ` +
            `through funds and is invisible in your broker.`
          : `You hold no ${bestGap.label} directly, but your funds do: ${pct(total)} of your ` +
            `portfolio is ${bestGap.label}, entirely through fund holdings — invisible in your broker.`,
        values: {
          security: bestGap.label,
          direct: str(direct),
          viaFunds: bestGap.viaFunds,
          total: str(total),
        },
      }),
    );
  }

  // D8 — correlation cluster over the limit.
  const topCluster = ctx.correlation?.clusters[0];
  if (topCluster && dec(topCluster.weight).gt(CLUSTER_LIMIT)) {
    const w = dec(topCluster.weight);
    surprises.push(
      make('correlation_cluster', normalized(w.minus(CLUSTER_LIMIT), CLUSTER_LIMIT), {
        headline: `${topCluster.members.length} of your holdings are really one bet.`,
        body:
          `${topCluster.members.map((m) => m.label).join(', ')} move together ` +
          `(pairwise correlation ≥ ${fixed(dec(topCluster.minPairCorrelation), 2)}). Together they are ` +
          `${pct(w)} of your portfolio. If that one bet is wrong, they fall together.`,
        values: {
          members: topCluster.members.map((m) => m.label).join(', '),
          weight: topCluster.weight,
          minPairCorrelation: topCluster.minPairCorrelation,
        },
      }),
    );
  }

  // D5 — foreign-currency exposure.
  let foreign = ZERO;
  for (const s of signals.exposure.currency.value) {
    if (s.key !== ctx.baseCurrency) foreign = foreign.plus(s.weight);
  }
  if (foreign.gt(FOREIGN_CCY_LIMIT)) {
    surprises.push(
      make('foreign_currency', normalized(foreign.minus(FOREIGN_CCY_LIMIT), FOREIGN_CCY_LIMIT), {
        headline: `You are a ${ctx.baseCurrency} investor with a foreign-currency portfolio.`,
        body:
          `${pct(foreign)} of your assets are priced in currencies other than ${ctx.baseCurrency}. ` +
          `Part of your return is an unhedged currency bet you may not have known you were making — ` +
          `the performance view separates it out.`,
        values: { foreignShare: str(foreign), baseCurrency: ctx.baseCurrency },
      }),
    );
  }

  // D2 — effective diversification vs nominal.
  const conc = signals.concentration.value;
  if (conc.nominalN >= 4) {
    const eff = dec(conc.effectiveN);
    const ratio = eff.div(conc.nominalN);
    if (ratio.lt(EFFECTIVE_N_RATIO)) {
      surprises.push(
        make('effective_n', dec(1).minus(ratio), {
          headline: `${conc.nominalN} names, but really about ${fixed(eff, 0)} bets.`,
          body:
            `Your effective diversification is ${fixed(eff, 1)} names, not ${conc.nominalN}: ` +
            `a few positions dominate the money at risk. "Diversified across ${conc.nominalN} names" ` +
            `won't protect you the way the count suggests.`,
          values: { nominalN: conc.nominalN, effectiveN: conc.effectiveN },
        }),
      );
    }
  }

  // D6 — stated vs inferred strategy.
  if (
    ctx.statedStrategy &&
    ctx.inferredStrategy &&
    ctx.statedStrategy !== 'unknown' &&
    ctx.inferredStrategy !== 'unknown' &&
    ctx.statedStrategy !== ctx.inferredStrategy
  ) {
    surprises.push(
      make('strategy_mismatch', dec('0.5'), {
        headline: `Your portfolio doesn't match the strategy you stated.`,
        body:
          `You said your strategy is "${label(ctx.statedStrategy)}", but the portfolio itself looks ` +
          `like "${label(ctx.inferredStrategy)}". Either the strategy is wrong or the portfolio is — ` +
          `both are fixable, but only deliberately.`,
        values: { stated: ctx.statedStrategy, inferred: ctx.inferredStrategy },
      }),
    );
  }

  // D4 — single-name concentration (lowest prior: the user typed it in).
  let biggest: (typeof named)[number] | null = null;
  for (const r of named) {
    if (!biggest || dec(r.weight).gt(biggest.weight)) biggest = r;
  }
  if (biggest && dec(biggest.weight).gt(SINGLE_NAME_LIMIT)) {
    const w = dec(biggest.weight);
    surprises.push(
      make('single_name_concentration', normalized(w.minus(SINGLE_NAME_LIMIT), SINGLE_NAME_LIMIT), {
        headline: `${biggest.label} is ${pct(w)} of everything.`,
        body:
          `A single name above ${pct(SINGLE_NAME_LIMIT, 0)} means one company's bad quarter moves ` +
          `your whole net worth. This includes exposure arriving through funds.`,
        values: { security: biggest.label, weight: biggest.weight },
      }),
    );
  }

  if (dec(signals.totalValueBase).lte(0)) {
    gaps.push({ component: 'reality_check', reason: 'portfolio has no valued positions' });
  }

  surprises.sort((a, b) => dec(b.score).cmp(dec(a.score)));
  return {
    top: surprises.slice(0, 3),
    others: surprises.slice(3).map((s) => ({ kind: s.kind, headline: s.headline })),
    warnings,
    gaps,
  };
}

function make(
  kind: SurpriseKind,
  magnitude: Dec,
  content: { headline: string; body: string; values: Surprise['values'] },
): Surprise {
  return {
    kind,
    magnitude: str(magnitude),
    score: str(magnitude.times(PRIOR[kind])),
    ...content,
  };
}

function label(s: Strategy): string {
  switch (s) {
    case 'quality_growth':
      return 'quality growth';
    case 'value':
      return 'value';
    case 'dividend_income':
      return 'dividend income';
    case 'passive_index':
      return 'passive indexing';
    case 'unknown':
      return 'unknown';
  }
}
