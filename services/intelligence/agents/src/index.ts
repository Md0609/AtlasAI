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
export { narrate, type NarrateInput, type NarrateResult } from './narration.js';
export {
  buildCopilotContext,
  answerCopilot,
  CopilotContextError,
  type CopilotContext,
  type CopilotContextRef,
  type CopilotContextType,
  type CopilotTurnInput,
  type CopilotTurnResult,
} from './copilot.js';
// Re-export the trace-id minter so API surfaces can correlate a whole request
// tree without taking a direct dependency on @atlas/runtime internals.
export { newTraceId } from '@atlas/runtime';
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
  NARRATOR,
  COPILOT,
  REGISTERED,
} from './prompts.js';
