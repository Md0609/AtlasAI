/**
 * FixtureProvider — the deterministic mock LLM (§B8 "mock first, replace
 * later"). This is the ONLY provider used in development and tests.
 *
 * It returns the request's `fallback` draft verbatim. That is exactly the
 * deterministic template the business layer computed, so:
 *   - output is always schema-valid (the agent built it),
 *   - the same inputs always produce the same bytes (FR-5.6 discipline),
 *   - no canned fixture files to maintain — the "fixture" is derived from the
 *     request the orchestration already assembled.
 *
 * Token counts and cost are estimated deterministically from text length so
 * the tracing (§23.4) and cost-ceiling (§37.3) machinery is exercised exactly
 * as it will be with the real provider — only the numbers are synthetic.
 */
import { dec, str } from '@atlas/domain';
import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmUsage,
  ModelTier,
} from '../provider.js';

const TIER_MODEL: Record<ModelTier, string> = {
  small: 'fixture-small',
  mid: 'fixture-mid',
  large: 'fixture-large',
  judge: 'fixture-judge',
};

/** Synthetic per-1k-token EUR rates, scaled to the §37 tier ordering. */
const RATES: Record<string, { inPer1k: string; outPer1k: string }> = {
  'fixture-small': { inPer1k: '0.0002', outPer1k: '0.0008' },
  'fixture-mid': { inPer1k: '0.0010', outPer1k: '0.0040' },
  'fixture-large': { inPer1k: '0.0040', outPer1k: '0.0160' },
  'fixture-judge': { inPer1k: '0.0010', outPer1k: '0.0040' },
};

/** ~4 chars per token, floored at 1 — deterministic, no tokenizer dependency. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export class FixtureProvider implements LlmProvider {
  readonly name = 'fixture';
  /** Nothing here is model-written: the "fixture" is the caller's own template. */
  readonly generative = false;

  modelFor(tier: ModelTier): string {
    return TIER_MODEL[tier];
  }

  priceEur(model: string, usage: LlmUsage): string {
    const rate = RATES[model] ?? RATES['fixture-mid']!;
    const inCost = dec(usage.inputTokens).div(1000).times(rate.inPer1k);
    const outCost = dec(usage.outputTokens).div(1000).times(rate.outPer1k);
    return str(inCost.plus(outCost).toDecimalPlaces(6));
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const inputText = req.system + req.messages.map((m) => m.content).join('\n');
    const usage: LlmUsage = {
      inputTokens: estimateTokens(inputText),
      outputTokens: estimateTokens(req.fallback.text),
    };
    return {
      text: req.fallback.text,
      toolCalls: req.fallback.toolCalls ?? [],
      stopReason: req.fallback.stopReason ?? (req.fallback.toolCalls?.length ? 'tool_use' : 'end'),
      usage,
      model: this.modelFor(req.tier),
      provider: this.name,
      // The fixture always serves the deterministic draft — that IS its answer,
      // not a degradation. `degraded` marks the real provider falling back.
      degraded: false,
      // …but it is not analysis either, and that must survive to the caller.
      generative: false,
    };
  }
}
