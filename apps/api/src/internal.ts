/**
 * API internals.
 *
 * This module used to be the API's shared surface for @atlas/workers, which
 * made a background worker depend on the whole HTTP application. Both halves
 * have since moved to packages either side can depend on:
 *
 *  - read loaders → @atlas/dataplane       (read-only; safe for the intelligence plane)
 *  - write paths  → @atlas/portfolio-core  (rule evaluation + brief enqueue)
 *
 * Nothing outside apps/api imports this module any more. The re-exports below
 * are kept so in-repo API code and any caller still pointing at
 * `@atlas/api/internal` keeps resolving; new code should import the packages
 * directly.
 */
export { ownedPortfolio } from './portfolios.js';

export { evaluateAndPersistUserRules } from '@atlas/portfolio-core';

export {
  loadEngineInputs,
  loadConsolidatedInputs,
  loadRadarContext,
  conditionSecurityIds,
  loadPeInputs,
  type Db,
} from '@atlas/dataplane';
