/**
 * API internals shared with @atlas/workers.
 *
 * Pure DB read loaders moved to @atlas/dataplane in Phase 4b (also used by the
 * intelligence plane). What stays here is the API-owned WRITE path — rule
 * evaluation enqueues brief generation, so it lives with the request handlers,
 * not in the read-only dataplane. Workers import loaders from @atlas/dataplane
 * directly and this helper from here.
 */
export { evaluateAndPersistUserRules } from './rules.js';
export { ownedPortfolio } from './portfolios.js';

// Convenience re-exports so existing importers of @atlas/api/internal keep
// resolving; the canonical home is now @atlas/dataplane.
export {
  loadEngineInputs,
  loadConsolidatedInputs,
  loadRadarContext,
  conditionSecurityIds,
  loadPeInputs,
  type Db,
} from '@atlas/dataplane';
