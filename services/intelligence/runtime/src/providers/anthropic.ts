/**
 * AnthropicProvider — the production LLM, a drop-in replacement for
 * FixtureProvider (§39.4, D-021).
 *
 * Nothing above this file changes when you switch to it: it implements the
 * same `LlmProvider` interface and maps the §39 tiers to concrete Anthropic
 * model ids. Anthropic-specific knowledge (model strings, SDK shape, pricing)
 * is quarantined here.
 *
 * The generation path is fully written against the current Messages API. The
 * SDK is imported LAZILY via a non-literal specifier so this package builds
 * and the whole test suite runs on the FixtureProvider with NO Anthropic
 * dependency installed. Enabling the real model is therefore exactly:
 *
 *   1. npm i @anthropic-ai/sdk        (add the dependency)
 *   2. export ANTHROPIC_API_KEY=...   (EU inference + zero-retention org, §45.4)
 *   3. export ATLAS_LLM_PROVIDER=anthropic
 *
 * See docs/enabling-anthropic.md for the full checklist. Until then, complete()
 * throws a clear, actionable error and modelFor()/priceEur() work offline.
 */
import { dec, str } from '@atlas/domain';
import type {
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStopReason,
  LlmToolCall,
  LlmUsage,
  ModelTier,
} from '../provider.js';

/**
 * Tier → concrete model (skill: claude-api model catalogue, cached 2026-06).
 * large defaults to the most capable Opus; the Red Team (§22.9 "Opus always")
 * routes to `large`. `judge` (§21.6 cross-family L4) is a DIFFERENT model than
 * the mid-tier generators so a same-family blind spot is less likely; a truly
 * cross-VENDOR judge needs a second provider (D-021) — noted in the doc.
 */
const TIER_MODEL: Record<ModelTier, string> = {
  small: 'claude-haiku-4-5',
  mid: 'claude-sonnet-5',
  large: 'claude-opus-4-8',
  judge: 'claude-opus-4-8',
};

/**
 * Published per-million-token prices (skill catalogue). The cost ledger column
 * is named `eur`; these are the USD sticker numbers used as the rate — see
 * docs/enabling-anthropic.md § Currency for the FX note before go-live.
 */
const PRICE_PER_MTOK: Record<string, { input: string; output: string }> = {
  'claude-haiku-4-5': { input: '1.00', output: '5.00' },
  'claude-sonnet-5': { input: '3.00', output: '15.00' },
  'claude-opus-4-8': { input: '5.00', output: '25.00' },
};

export class AnthropicProviderNotConfiguredError extends Error {
  constructor(reason: string) {
    super(
      `AnthropicProvider is selected but not usable: ${reason}. ` +
        `See docs/enabling-anthropic.md — you need @anthropic-ai/sdk installed and ` +
        `ANTHROPIC_API_KEY set. Until then run with ATLAS_LLM_PROVIDER=fixture.`,
    );
    this.name = 'AnthropicProviderNotConfiguredError';
  }
}

/** The dynamic-import specifier as a variable so tsc does not require the module at build. */
const SDK_MODULE = '@anthropic-ai/sdk';

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = null;

  modelFor(tier: ModelTier): string {
    return TIER_MODEL[tier];
  }

  priceEur(model: string, usage: LlmUsage): string {
    const rate = PRICE_PER_MTOK[model];
    if (!rate) throw new Error(`no price for model ${model}`);
    const inCost = dec(usage.inputTokens).div(1_000_000).times(rate.input);
    const outCost = dec(usage.outputTokens).div(1_000_000).times(rate.output);
    return str(inCost.plus(outCost).toDecimalPlaces(6));
  }

  private async ensureClient(): Promise<void> {
    if (this.client) return;
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new AnthropicProviderNotConfiguredError('ANTHROPIC_API_KEY is not set');
    }
    let Anthropic: unknown;
    try {
      // Non-literal specifier: tsc does not statically resolve it, so this file
      // builds without the SDK installed. Resolved at call time only.
      const mod = (await import(SDK_MODULE)) as { default: unknown };
      Anthropic = mod.default;
    } catch {
      throw new AnthropicProviderNotConfiguredError(`cannot import ${SDK_MODULE} (run: npm i ${SDK_MODULE})`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctor = Anthropic as new () => any;
    this.client = new Ctor();
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    await this.ensureClient();
    const model = this.modelFor(req.tier);

    // Map the generic request onto the Messages API shape (skill: claude-api).
    const messages = req.messages.map((m) => toAnthropicMessage(m));
    const params: Record<string, unknown> = {
      model,
      max_tokens: req.maxTokens,
      system: req.jsonOutput
        ? `${req.system}\n\nRespond with a single JSON value and nothing else.`
        : req.system,
      messages,
    };
    if (req.tools && req.tools.length > 0) {
      params.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }

    let resp: AnthropicMessage;
    try {
      resp = (await this.client.messages.create(params)) as AnthropicMessage;
    } catch (err) {
      // Any provider error degrades to the deterministic template (§21.4/§26.4):
      // the runtime records the trace; callers never see a raw failure reach a user.
      return this.degraded(req, model, (err as Error).message);
    }

    if (resp.stop_reason === 'refusal') {
      return this.degraded(req, model, 'model refused');
    }

    const text = resp.content
      .filter((b): b is AnthropicTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const toolCalls: LlmToolCall[] = resp.content
      .filter((b): b is AnthropicToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));

    return {
      text,
      toolCalls,
      stopReason: mapStopReason(resp.stop_reason),
      usage: {
        inputTokens: resp.usage?.input_tokens ?? 0,
        outputTokens: resp.usage?.output_tokens ?? 0,
      },
      model,
      provider: this.name,
      degraded: false,
    };
  }

  private degraded(req: LlmRequest, model: string, _reason: string): LlmResponse {
    return {
      text: req.fallback.text,
      toolCalls: req.fallback.toolCalls ?? [],
      stopReason: req.fallback.stopReason ?? 'end',
      usage: { inputTokens: 0, outputTokens: 0 },
      model,
      provider: this.name,
      degraded: true,
    };
  }
}

// --- minimal structural types for the Anthropic response (avoids an SDK type dep) ---

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}
interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
interface AnthropicMessage {
  content: Array<AnthropicTextBlock | AnthropicToolUseBlock | { type: string }>;
  stop_reason: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function toAnthropicMessage(m: LlmMessage): Record<string, unknown> {
  if (m.role === 'tool_result') {
    return {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: m.toolUseId, content: m.content }],
    };
  }
  return { role: m.role, content: m.content };
}

function mapStopReason(reason: string): LlmStopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'end';
  }
}
