/**
 * LLM narration for template surfaces (Phase 4b, §B1 / §B10).
 *
 * The Reality Check and the daily briefs are computed deterministically —
 * every number is provenanced — and rendered as template prose (surprise.v1).
 * This module lets a model REPHRASE that prose into something more natural,
 * held to the narration guard (lexical + classifier: no directive/rating/
 * prediction may leak), with the template as the permanent degradation path.
 *
 * Three things keep narration honest, none of which rely on the model:
 *   1. The fallback IS the template. The mock returns it verbatim; the real
 *      model degrades to it on failure, refusal, or over the cost ceiling.
 *   2. Numeral preservation. Every numeral in the narrated text must already
 *      appear in the template (the provenanced source). guardText does not run
 *      the structural "numbers are references" check — that check is for the
 *      ContextualizationDoc — so this deterministic subset check is what stops
 *      a real model from inventing or altering a figure in free prose.
 *   3. The guard. renderNarration (in @atlas/egress, the guard's sole caller)
 *      screens the text and records the decision either way. On rejection the
 *      caller keeps the template — never a bypass.
 */
import { inputHash } from '@atlas/domain';
import type { GuardVerdict } from '@atlas/contracts';
import { getPrompt, getProvider, newTraceId, runAgent, type LlmProvider } from '@atlas/runtime';
import type { Db } from '@atlas/dataplane';
import { makePgGuardRecorder, renderNarration } from '@atlas/egress';
import './prompts.js'; // side-effect: register the narrator prompt

export interface NarrateInput {
  userId: string;
  /** Cost-ledger + trace surface, e.g. 'reality_check', 'brief'. */
  surface: string;
  /** The deterministic template prose — both the thing to rephrase and the fallback. */
  template: string;
  /** Machine-readable facts behind the template; given to the model as context. */
  facts?: Record<string, string | number>;
  /** Verbatim user-quote spans to mask in the guard, if the prose contains any. */
  quotedSpans?: string[];
  traceId?: string;
  parentSpanId?: string;
  provider?: LlmProvider;
}

export interface NarrateResult {
  /** Narrated prose, or the template verbatim when narration degraded or was rejected. */
  text: string;
  /** true ⇒ the template was used (provider degraded, numeral drift, or guard rejection). */
  degraded: boolean;
  model: string;
  guard: GuardVerdict;
}

/** Numeric tokens, normalised so 1,234.5 and 1234.5 compare equal by their digit runs. */
function numerals(s: string): string[] {
  return (s.match(/\d[\d.,]*/g) ?? []).map((n) => n.replace(/,/g, ''));
}

/** Every numeral in `narrated` must be present in `source` — no invented figures. */
function preservesNumerals(narrated: string, source: string): boolean {
  const allowed = new Set(numerals(source));
  return numerals(narrated).every((n) => allowed.has(n));
}

/**
 * Narrate one template finding. Never throws for content reasons: any failure
 * degrades to the template, which is guard-clean by construction.
 */
export async function narrate(db: Db, input: NarrateInput): Promise<NarrateResult> {
  const prompt = getPrompt('narrator');
  const traceId = input.traceId ?? newTraceId();
  const factLines = input.facts
    ? Object.entries(input.facts)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join('\n')
    : '';
  const task =
    `Rephrase this finding, keeping every number identical:\n"${input.template}"` +
    (factLines ? `\n\nThe figures behind it:\n${factLines}` : '');

  const ih = inputHash({ agent: 'narrator', promptHash: prompt.hash, template: input.template });

  const result = await runAgent(db, {
    agent: 'narrator',
    tier: 'small', // §39 routing: narration is the cheapest tier
    userId: input.userId, // personal surface — never cached (§40.4)
    system: prompt.sections.system,
    messages: [{ role: 'user', content: task }],
    maxTokens: 600,
    fallback: { text: input.template },
    promptVersion: prompt.version,
    promptHash: prompt.hash,
    inputHash: ih,
    surface: input.surface,
    traceId,
    parentSpanId: input.parentSpanId,
    provider: input.provider ?? getProvider(),
  });

  const recordDecision = makePgGuardRecorder(db);
  const generator = { agent: 'narrator', promptVersion: prompt.version, model: result.model };

  // Numeral drift ⇒ treat as a degradation before the text ever reaches a user.
  const candidate = preservesNumerals(result.text, input.template) ? result.text : input.template;
  const degradedBefore = result.degraded || candidate !== result.text;

  const guarded = await renderNarration({
    text: candidate,
    quotedSpans: input.quotedSpans,
    userId: input.userId,
    recordDecision,
    generator,
  });

  if (!guarded.approved) {
    // Guard rejected the narration — keep the template (already provenanced &
    // guard-clean). The rejection is recorded in guard_decisions above.
    return { text: input.template, degraded: true, model: result.model, guard: guarded.verdict };
  }
  return { text: guarded.text, degraded: degradedBefore, model: result.model, guard: guarded.verdict };
}
