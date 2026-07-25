/**
 * runAgent — THE agent execution loop (§21.3, §37.3, §40, §23.4).
 *
 * Every LLM call in the product goes through here. It is provider-agnostic
 * (talks the LlmProvider interface) and enforces, in order:
 *
 *   1. Shared-analysis cache probe — for user-agnostic Layer-1 work only
 *      (userId === null). A hit costs nothing (§40 amortization) and is traced
 *      as cache_hit.
 *   2. Cost ceiling — per-user pre-check (§37.3). Over the daily/monthly
 *      ceiling ⇒ degrade to the deterministic fallback WITHOUT calling the
 *      provider (the model never gets a chance to spend).
 *   3. Provider call — the mock returns the fallback verbatim; the real model
 *      generates and degrades to the fallback on failure/refusal.
 *   4. Trace — one agent_message span with model, prompt version, tokens,
 *      cost, cache status (§23.4). Recorded on every path, always.
 *   5. Cost ledger — accrue the spend against the user's surface budget.
 *   6. Cache write — store shared Layer-1 output for the next holder.
 *
 * The result carries the text/toolCalls plus whether it was a cache hit or a
 * degradation, so callers can surface honest banners (§26.4).
 */
import { dec } from '@atlas/domain';
import { cacheGet, cacheKey, cachePut, type Db } from './cache.js';
import { addCost, checkCostCeiling } from './cost.js';

/**
 * How long any single provider call may take. Read per call so a deployment —
 * or a test — can set it without a rebuild. 30s is well beyond a healthy
 * completion and well inside the 300s job lease, so a timeout degrades the
 * turn rather than losing the job.
 */
function providerTimeoutMs(): number {
  return Number(process.env.ATLAS_LLM_TIMEOUT_MS ?? 30_000);
}
import { getProvider } from './providers/factory.js';
import { recordAgentMessage } from './tracing.js';
import type { LlmDraft, LlmProvider, LlmToolCall, LlmToolSpec, LlmMessage, ModelTier } from './provider.js';

export interface RunAgentInput {
  agent: string;
  tier: ModelTier;
  /** null ⇒ shared, cacheable, user-agnostic Layer-1 work (§21.2). */
  userId: string | null;
  system: string;
  messages: LlmMessage[];
  maxTokens: number;
  jsonOutput?: boolean;
  tools?: LlmToolSpec[];
  /** Deterministic template output (§B8) — mock returns it, real degrades to it. */
  fallback: LlmDraft;
  promptVersion: string;
  promptHash: string;
  /** Canonical hash of the typed inputs — cache key + reproducibility (§23.4). */
  inputHash: string;
  /** Cost-ledger surface, e.g. 'brief_narration', 'copilot', 'deep_analysis'. */
  surface: string;
  traceId: string;
  parentSpanId?: string;
  /** Estimated spend for the pre-check; defaults to a conservative €0.05. */
  estCostEur?: string;
  /** Volatility-adjusted TTL for shared caching (§40.2). Default 4h. */
  cacheTtlSeconds?: number;
  /** Override the provider (tests / multi-provider routing). */
  provider?: LlmProvider;
}

export interface RunAgentResult {
  text: string;
  toolCalls: LlmToolCall[];
  model: string;
  inputTokens: number;
  outputTokens: number;
  costEur: string;
  cacheHit: boolean;
  degraded: boolean;
  /**
   * False when no language model wrote this text — the fixture provider, or any
   * degradation that returned the caller's deterministic template. Distinct
   * from `degraded`, which says only that the real provider fell back; a demo
   * or replay backend is not degraded and is still not analysis.
   */
  generative: boolean;
  spanId: string;
}

export async function runAgent(db: Db, input: RunAgentInput): Promise<RunAgentResult> {
  const provider = input.provider ?? getProvider();
  const shared = input.userId === null;
  const key = cacheKey(input.agent, input.promptVersion, input.inputHash);

  // 1. Shared cache probe (Layer-1 only).
  if (shared) {
    const hit = await cacheGet(db, key);
    if (hit) {
      const spanId = await recordAgentMessage(db, {
        traceId: input.traceId,
        parentSpanId: input.parentSpanId,
        userId: null,
        agent: input.agent,
        promptVersion: input.promptVersion,
        promptHash: input.promptHash,
        model: hit.model,
        inputHash: input.inputHash,
        output: { text: hit.text, toolCalls: hit.toolCalls },
        inputTokens: hit.inputTokens,
        outputTokens: hit.outputTokens,
        costEur: '0',
        cacheHit: true,
      });
      return {
        text: hit.text,
        toolCalls: hit.toolCalls,
        model: hit.model,
        inputTokens: hit.inputTokens,
        outputTokens: hit.outputTokens,
        costEur: '0',
        cacheHit: true,
        degraded: false,
        // Only generative output is ever written to the shared cache; a
        // degraded or fixture turn returns before the cache write.
        generative: true,
        spanId,
      };
    }
  }

  // 2. Per-user cost ceiling (§37.3) — degrade rather than spend over the cap.
  if (input.userId) {
    const check = await checkCostCeiling(db, input.userId, input.estCostEur ?? '0.05');
    if (!check.allowed) {
      const spanId = await recordAgentMessage(db, {
        traceId: input.traceId,
        parentSpanId: input.parentSpanId,
        userId: input.userId,
        agent: input.agent,
        promptVersion: input.promptVersion,
        promptHash: input.promptHash,
        model: 'degraded:cost_ceiling',
        inputHash: input.inputHash,
        output: { text: input.fallback.text, toolCalls: input.fallback.toolCalls ?? [] },
        gaps: [{ component: input.agent, reason: check.reason ?? 'cost ceiling' }],
        costEur: '0',
        cacheHit: false,
      });
      return degradedResult(input.fallback, 'degraded:cost_ceiling', spanId);
    }
  }

  // 3. Provider call, bounded (P1-5).
  //
  // A hung provider used to hang us: no timeout, no signal, so a request that
  // never came back held its caller forever. In a worker that is a lease-
  // holding job; on the Copilot path it is an HTTP handler.
  //
  // Two mechanisms, both needed. The signal lets a provider that honours it
  // actually cancel — freeing the socket and stopping the meter. The race
  // guarantees WE stop waiting even if it does not, because a provider that
  // ignores its signal is precisely the one that hangs.
  //
  // A timeout degrades to the deterministic template rather than throwing:
  // that is what §B8 asks for and what the cost ceiling above already does.
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  // Which side won the race decides which error surfaces: a provider that
  // aborts cleanly rejects with its own message, one that ignores the signal
  // loses to the timer. Both are timeouts, so the trace must say so either way
  // or the same failure appears under two names.
  let timedOut = false;
  let resp: Awaited<ReturnType<typeof provider.complete>>;
  try {
    resp = await Promise.race([
      provider.complete({
        tier: input.tier,
        system: input.system,
        messages: input.messages,
        maxTokens: input.maxTokens,
        jsonOutput: input.jsonOutput,
        tools: input.tools,
        agent: input.agent,
        promptVersion: input.promptVersion,
        fallback: input.fallback,
        signal: controller.signal,
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error(`llm timeout after ${providerTimeoutMs()}ms`));
        }, providerTimeoutMs());
      }),
    ]);
  } catch (err) {
    controller.abort();
    const reason = timedOut
      ? `llm timeout after ${providerTimeoutMs()}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    const spanId = await recordAgentMessage(db, {
      traceId: input.traceId,
      parentSpanId: input.parentSpanId,
      userId: input.userId,
      agent: input.agent,
      promptVersion: input.promptVersion,
      promptHash: input.promptHash,
      model: 'degraded:provider_error',
      inputHash: input.inputHash,
      output: { text: input.fallback.text, toolCalls: input.fallback.toolCalls ?? [] },
      gaps: [{ component: input.agent, reason }],
      costEur: '0',
      cacheHit: false,
    });
    return degradedResult(input.fallback, 'degraded:provider_error', spanId);
  } finally {
    clearTimeout(timer);
  }
  const costEur = resp.degraded ? '0' : provider.priceEur(resp.model, resp.usage);

  // 4. Trace (always).
  const spanId = await recordAgentMessage(db, {
    traceId: input.traceId,
    parentSpanId: input.parentSpanId,
    userId: input.userId,
    agent: input.agent,
    promptVersion: input.promptVersion,
    promptHash: input.promptHash,
    model: resp.degraded ? `degraded:${resp.model}` : resp.model,
    inputHash: input.inputHash,
    output: { text: resp.text, toolCalls: resp.toolCalls },
    inputTokens: resp.usage.inputTokens,
    outputTokens: resp.usage.outputTokens,
    costEur,
    cacheHit: false,
  });

  // 5. Cost ledger.
  if (input.userId && dec(costEur).gt(0)) {
    await addCost(db, input.userId, input.surface, costEur);
  }

  // 6. Shared cache write (Layer-1, real generation only).
  if (shared && !resp.degraded) {
    await cachePut(db, {
      key,
      agent: input.agent,
      promptVersion: input.promptVersion,
      inputHash: input.inputHash,
      model: resp.model,
      text: resp.text,
      toolCalls: resp.toolCalls,
      inputTokens: resp.usage.inputTokens,
      outputTokens: resp.usage.outputTokens,
      ttlSeconds: input.cacheTtlSeconds ?? 4 * 3600,
    });
  }

  return {
    text: resp.text,
    toolCalls: resp.toolCalls,
    model: resp.model,
    inputTokens: resp.usage.inputTokens,
    outputTokens: resp.usage.outputTokens,
    costEur,
    cacheHit: false,
    degraded: resp.degraded,
    generative: resp.generative,
    spanId,
  };
}

function degradedResult(fallback: LlmDraft, model: string, spanId: string): RunAgentResult {
  return {
    text: fallback.text,
    toolCalls: fallback.toolCalls ?? [],
    model,
    inputTokens: 0,
    outputTokens: 0,
    costEur: '0',
    cacheHit: false,
    degraded: true,
    // A degradation returns the caller's own template. No model wrote it.
    generative: false,
    spanId,
  };
}
