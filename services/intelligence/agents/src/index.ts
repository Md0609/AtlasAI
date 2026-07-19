/**
 * @atlas/agents — the intelligence plane (§21–§22): Layer-1 specialists +
 * Red Team, the Layer-2 PSA chokepoint, and the static-plan orchestrator.
 * Built on @atlas/runtime (provider, cache, ceilings, tracing) and gated by
 * @atlas/egress (the sole constructor of UserFacingContent).
 */
import './prompts.js'; // register agent prompts on package load

export {
  buildSecurityContext,
  buildUserBundle,
  mergeSignals,
  type UserBundle,
  type UserRuleRow,
  type UserThesisRow,
} from './context.js';
export {
  runFinancialAnalysis,
  runValuation,
  runNewsFilings,
  runRedTeam,
  type SpecialistOpts,
} from './specialists.js';
export { runPsa, type PsaResult } from './psa.js';
export {
  contextualize,
  deepAnalysis,
  type OrchestratorRequest,
  type OrchestratorResult,
} from './orchestrator.js';
export {
  FINANCIAL_ANALYSIS,
  VALUATION,
  NEWS_FILINGS,
  RED_TEAM,
  PSA,
  REGISTERED,
} from './prompts.js';
