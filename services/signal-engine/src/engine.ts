/**
 * Provenance (FR-5.5) and the engine entrypoint.
 *
 * Every output value is wrapped with { engineVersion, inputHash, methodology,
 * inputs-as-of }. inputHash is SHA-256 over the canonicalized engine inputs —
 * same inputs + same version ⇒ identical hash and identical outputs (FR-5.6).
 */
import type {
  ConcentrationResult,
  DomainEvent,
  ExposureSlice,
  LookThroughRow,
  Provenance,
  SignalRecomputedEvent,
  SignalValue,
  WeightRow,
} from '@atlas/contracts';
import { canonicalJson, inputHash, str } from '@atlas/domain';
import { ENGINE_VERSION } from './version.js';
import { FxTable, type EngineGap, type EngineInputs } from './types.js';
import { valuePortfolio } from './valuation.js';
import { lookThrough } from './lookthrough.js';
import { exposures } from './exposure.js';
import { concentration } from './concentration.js';
import { dec } from '@atlas/domain';

export interface PortfolioSignals {
  portfolioId: string;
  engineVersion: string;
  inputHash: string;
  totalValueBase: string;
  baseCurrency: string;
  weights: SignalValue<WeightRow[]>;
  lookThrough: SignalValue<LookThroughRow[]>;
  exposure: {
    sector: SignalValue<ExposureSlice[]>;
    country: SignalValue<ExposureSlice[]>;
    currency: SignalValue<ExposureSlice[]>;
  };
  concentration: SignalValue<ConcentrationResult>;
  cashWeight: string;
  gaps: EngineGap[];
  pricesAsOf: string | null;
  fxAsOf: string | null;
  holdingsAsOf: string | null;
  event: SignalRecomputedEvent;
}

function buildProvenance(
  methodology: string,
  hash: string,
  asOf: { pricesAsOf: string | null; fxAsOf: string | null; holdingsAsOf: string | null },
): Provenance {
  return {
    engineVersion: ENGINE_VERSION,
    inputHash: hash,
    methodology,
    inputs: asOf,
  };
}

/**
 * Deterministic event id derived from (portfolio, version, inputHash): the
 * same recomputation never produces two distinct events, which is what makes
 * at-least-once delivery safe to dedupe downstream (§24.3).
 */
function deterministicEventId(portfolioId: string, hash: string): string {
  return `sig-${portfolioId}-${hash.slice(0, 16)}`;
}

export function computePortfolioSignals(
  inputs: EngineInputs,
  computedAt: string,
): PortfolioSignals {
  const hash = inputHash({ engineVersion: ENGINE_VERSION, inputs: canonicalJson(inputs) });

  const valuation = valuePortfolio(inputs);
  const ltInput = valuation.weights
    .filter((w): w is WeightRow & { securityId: string } => w.securityId !== null)
    .map((w) => ({ securityId: w.securityId, weight: dec(w.weight) }));
  const lt = lookThrough(inputs, ltInput);

  const asOf = {
    pricesAsOf: valuation.pricesAsOf,
    fxAsOf: new FxTable(inputs.fx).asOf,
    holdingsAsOf: lt.holdingsAsOf,
  };

  const conc = concentration(lt);

  const event: SignalRecomputedEvent = {
    type: 'signal.recomputed',
    eventId: deterministicEventId(inputs.portfolioId, hash),
    occurredAt: computedAt,
    portfolioId: inputs.portfolioId,
    engineVersion: ENGINE_VERSION,
    inputHash: hash,
  };

  return {
    portfolioId: inputs.portfolioId,
    engineVersion: ENGINE_VERSION,
    inputHash: hash,
    totalValueBase: str(valuation.totalBase),
    baseCurrency: inputs.baseCurrency,
    weights: { value: valuation.weights, provenance: buildProvenance('weights.v1', hash, asOf) },
    lookThrough: { value: lt.rows, provenance: buildProvenance('lookthrough.v1', hash, asOf) },
    exposure: {
      sector: {
        value: exposures(inputs, valuation, lt, 'sector'),
        provenance: buildProvenance('exposure.sector.v1', hash, asOf),
      },
      country: {
        value: exposures(inputs, valuation, lt, 'country'),
        provenance: buildProvenance('exposure.country.v1', hash, asOf),
      },
      currency: {
        value: exposures(inputs, valuation, lt, 'currency'),
        provenance: buildProvenance('exposure.currency.v1', hash, asOf),
      },
    },
    concentration: { value: conc, provenance: buildProvenance('concentration.v1', hash, asOf) },
    cashWeight: str(valuation.cashWeight),
    gaps: valuation.gaps,
    pricesAsOf: valuation.pricesAsOf,
    fxAsOf: asOf.fxAsOf,
    holdingsAsOf: lt.holdingsAsOf,
    event,
  };
}

