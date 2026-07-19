/**
 * @atlas/runtime — Phase 4a slice of THE agent runtime (§A4.2): the prompt
 * registry (prompts are code, §38), agent-message tracing (§23.4), and
 * per-tenant cost accounting with enforced ceilings (§37.3). The execution
 * loop, model providers and the shared-analysis cache land in Phase 4b on
 * top of these primitives.
 */
export {
  allPrompts,
  clearRegistryForTests,
  composePrompt,
  getPrompt,
  registerPrompt,
  type PromptDefinition,
  type PromptSections,
  type RegisteredPrompt,
} from './registry.js';
export { PSA_BRIEF_NARRATOR } from './prompts.js';
export { newTraceId, recordAgentMessage, type AgentMessage } from './tracing.js';
export { COST_CEILINGS, addCost, checkCostCeiling, type CostCheck } from './cost.js';

// Phase 4b: the LLM provider boundary, the execution loop, and the shared cache.
export type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmMessage,
  LlmToolSpec,
  LlmToolCall,
  LlmDraft,
  LlmUsage,
  LlmStopReason,
  ModelTier,
} from './provider.js';
export { FixtureProvider } from './providers/fixture.js';
export { AnthropicProvider, AnthropicProviderNotConfiguredError } from './providers/anthropic.js';
export {
  getProvider,
  setProviderForTests,
  resetProviderCache,
  type ProviderName,
} from './providers/factory.js';
export { runAgent, type RunAgentInput, type RunAgentResult } from './run.js';
export {
  cacheGet,
  cachePut,
  cacheKey,
  cacheInvalidateInputHashPrefix,
  type CachedOutput,
} from './cache.js';
