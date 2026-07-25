/**
 * The generic LLM provider boundary (Phase 4b, §39.4 "the model is a swappable
 * dependency").
 *
 * NOTHING in the business layer (agents, PSA, Copilot, orchestrator) knows
 * about any specific model vendor. It speaks this interface. Two things make
 * that real:
 *
 *  1. Logical model TIERS, not vendor model ids. The business layer asks for
 *     `small | mid | large | judge` (the §39 routing table); the provider
 *     resolves the tier to whatever concrete model it serves. Anthropic model
 *     strings live only inside the Anthropic provider.
 *
 *  2. A `fallback` draft on every request. The business layer always computes
 *     a deterministic, schema-valid result first (the §B8 template path — the
 *     permanent degradation path under load/outage). It hands that to the
 *     provider as `fallback`. The MOCK provider returns it verbatim (which is
 *     why the mock is deterministic and needs zero canned-fixture files); the
 *     REAL provider ignores it for generation and the runtime uses it only as
 *     the degradation target when the model fails guard/schema/ceiling. The
 *     provider never has to understand ContextualizationDoc or Finding[] — the
 *     draft is opaque text (JSON when jsonOutput is set).
 *
 * Swapping FixtureProvider → AnthropicProvider is a single factory decision
 * (see providers/factory.ts). No other file changes.
 */

/** The §39 routing tiers. The provider maps each to a concrete model. */
export type ModelTier = 'small' | 'mid' | 'large' | 'judge';

export type LlmStopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal';

export interface LlmToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface LlmMessage {
  role: 'user' | 'assistant' | 'tool_result';
  content: string;
  /** Set on a tool_result message: which tool call it answers. */
  toolUseId?: string;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * The deterministic stand-in the business layer always computes. Opaque to the
 * provider. For JSON agents, `text` is the JSON string of the drafted output.
 */
export interface LlmDraft {
  text: string;
  toolCalls?: LlmToolCall[];
  stopReason?: LlmStopReason;
}

export interface LlmRequest {
  tier: ModelTier;
  system: string;
  messages: LlmMessage[];
  maxTokens: number;
  /** Ask the provider to constrain output to JSON (schema is described in the prompt). */
  jsonOutput?: boolean;
  tools?: LlmToolSpec[];
  /** For tracing (§23.4). Never used to route or price. */
  agent: string;
  promptVersion: string;
  /** The deterministic template output (§B8). Mock returns it; real provider degrades to it. */
  fallback: LlmDraft;
  /**
   * Aborted when the caller stops waiting. A real provider MUST pass this to
   * its HTTP client: the runtime stops waiting on its own either way, but
   * without this the request stays alive on the socket, still costing money
   * and still holding a connection nobody will read.
   */
  signal?: AbortSignal;
}

export interface LlmResponse {
  text: string;
  toolCalls: LlmToolCall[];
  stopReason: LlmStopReason;
  usage: LlmUsage;
  /** The concrete model id that served the request (for tracing). */
  model: string;
  provider: string;
  /** True when the provider returned the deterministic fallback rather than a fresh generation. */
  degraded: boolean;
}

export interface LlmProvider {
  readonly name: string;
  /** Resolve a logical tier to the concrete model id this provider serves. */
  modelFor(tier: ModelTier): string;
  /** Price in EUR (decimal string, §27.3.2) for a usage on a concrete model. */
  priceEur(model: string, usage: LlmUsage): string;
  /** One-shot completion. Streaming (Copilot) is layered on top in Phase 4b step 5. */
  complete(req: LlmRequest): Promise<LlmResponse>;
}
