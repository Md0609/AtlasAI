/**
 * Atlas Copilot (§11.2) — the ambient assistant.
 *
 * The Copilot is NOT a generic chatbot. Every thread is bound to the
 * application context the user was viewing (a security, their portfolio, a
 * notification), and that context is loaded HERE, server-side, into the start
 * of the conversation. The user never re-establishes what they are looking at.
 *
 * Generation reuses the rest of the plane: runAgent (personal → never cached,
 * §40.4; traced + cost-metered), the deterministic fallback (§B8 — the mock
 * returns it, the real model degrades to it), and the egress Guard (§21.6 —
 * this module never imports the guard package directly; all guarding goes
 * through egress like every user-facing surface). Three honesty gates, none
 * model-trusted: the grounded
 * fallback, numeral-preservation against the loaded context, and the Guard.
 */
import { inputHash } from '@atlas/domain';
import { dec, fixed } from '@atlas/domain';
import type { ContextSignalValue, SecurityContext } from '@atlas/contracts';
import {
  getPrompt,
  getProvider,
  newTraceId,
  runAgent,
  type LlmMessage,
  type LlmProvider,
  type LlmToolSpec,
} from '@atlas/runtime';
import type { Db } from '@atlas/dataplane';
import { loadConsolidatedInputs } from '@atlas/dataplane';
import { computePortfolioSignals } from '@atlas/signal-engine';
import { makePgGuardRecorder, renderNarration } from '@atlas/egress';
import { buildSecurityContext, buildUserBundle, type UserBundle } from './context.js';
import { retrieveMemory } from './memory.js';
import './prompts.js'; // side-effect: register the copilot prompt

export type CopilotContextType = 'security' | 'portfolio' | 'notification' | 'global';

export interface CopilotContextRef {
  type: CopilotContextType;
  ref?: string | null;
}

export interface CopilotContext {
  type: CopilotContextType;
  ref: string | null;
  /** Human-readable thread title derived from the bound context. */
  title: string;
  /** The context bundle rendered as prose — shown to the model and the user. */
  preamble: string;
  /** Every numeral legitimately available (from the rendered bundle). */
  allowedNumerals: string[];
  /** User-quote spans present in the preamble (masked in the Guard). */
  quotedSpans: string[];
}

export interface CopilotTurnInput {
  userId: string;
  baseCurrency: string;
  context: CopilotContext;
  /** Prior turns of the thread (oldest first). */
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  userMessage: string;
  traceId?: string;
  provider?: LlmProvider;
}

export interface CopilotTurnResult {
  text: string;
  degraded: boolean;
  /**
   * false ⇒ no language model wrote this text. See NarrateResult for the full
   * truth table; the short version is that `degraded` reports a provider
   * falling back while `generative` reports whether a model wrote the words,
   * and the fixture is not degraded yet is still not analysis.
   */
  generative: boolean;
  model: string;
  guardApproved: boolean;
  traceId: string;
}

// ---------------------------------------------------------------------------
// Context loading (§11.2) — the whole point: the conversation begins with this
// already in hand.
// ---------------------------------------------------------------------------

export async function buildCopilotContext(
  db: Db,
  userId: string,
  baseCurrency: string,
  ref: CopilotContextRef,
): Promise<CopilotContext> {
  switch (ref.type) {
    case 'security':
      return securityContext(db, userId, baseCurrency, requireRef(ref));
    case 'portfolio':
      return portfolioContext(db, userId, baseCurrency, requireRef(ref));
    case 'notification':
      return notificationContext(db, userId, requireRef(ref));
    case 'global':
    default:
      return {
        type: 'global',
        ref: null,
        title: 'New conversation',
        preamble:
          'No specific item is open. This is the Copilot home; ask about a holding, your ' +
          'portfolio, or a notification and Atlas will load that context.',
        allowedNumerals: [],
        quotedSpans: [],
      };
  }
}

async function securityContext(
  db: Db,
  userId: string,
  baseCurrency: string,
  securityId: string,
): Promise<CopilotContext> {
  let sec: SecurityContext;
  try {
    sec = await buildSecurityContext(db, securityId);
  } catch {
    // buildSecurityContext throws a generic not-found; surface it as the typed
    // context error so the API maps it to 404 rather than 500.
    throw new CopilotContextError('security not found');
  }
  const user = await buildUserBundle(db, userId, baseCurrency, securityId);

  const lines: string[] = [`You are looking at ${sec.name}${sec.gicsSector ? ` (${sec.gicsSector})` : ''}.`];
  lines.push(...renderSignalLines(sec.signals));
  lines.push(...renderSignalLines(user.signals));

  const quotedSpans: string[] = [];
  if (user.thesis) {
    lines.push(`Your active thesis for this name reads: "${user.thesis.statement}"`);
    quotedSpans.push(user.thesis.statement);
  }
  for (const r of user.rules) {
    const status = r.status ? ` (currently ${r.status})` : '';
    lines.push(`You set a rule${status}. When you set it you wrote: "${r.statedReason}"`);
    quotedSpans.push(r.statedReason);
  }
  for (const c of user.metConditions) {
    lines.push(`One of your falsification conditions is met. You wrote: "${c.conditionNl}"`);
    quotedSpans.push(c.conditionNl);
  }

  const preamble = lines.join('\n');
  return {
    type: 'security',
    ref: securityId,
    title: sec.name,
    preamble,
    allowedNumerals: numeralsIn(preamble),
    quotedSpans,
  };
}

async function portfolioContext(
  db: Db,
  userId: string,
  baseCurrency: string,
  portfolioId: string,
): Promise<CopilotContext> {
  const { rows } = await db.query(
    `SELECT id, name, base_currency FROM portfolios WHERE id = $1 AND user_id = $2`,
    [portfolioId, userId],
  );
  if (rows.length === 0) throw new CopilotContextError('portfolio not found');
  const p = rows[0];

  const inputs = await loadConsolidatedInputs(db, userId, baseCurrency);
  const lines: string[] = [`You are looking at your portfolio "${p.name}" (${p.base_currency}).`];
  if (inputs.positions.length > 0 || inputs.cash.length > 0) {
    const s = computePortfolioSignals(inputs, new Date().toISOString());
    lines.push(`Total value: ${fixed(dec(s.totalValueBase), 2)} ${s.baseCurrency}.`);
    lines.push(`Cash weight: ${pct(s.cashWeight)}.`);
    lines.push(`Effective number of holdings: ${fixed(dec(s.concentration.value.effectiveN), 1)}.`);
    const sector = s.exposure.sector.value.find((x) => x.key !== 'UNKNOWN' && x.key !== 'CASH');
    if (sector) lines.push(`Largest sector exposure: ${sector.key} at ${pct(sector.weight)}.`);
  } else {
    lines.push('This portfolio has no valued positions yet.');
  }

  const preamble = lines.join('\n');
  return {
    type: 'portfolio',
    ref: portfolioId,
    title: p.name,
    preamble,
    allowedNumerals: numeralsIn(preamble),
    quotedSpans: [],
  };
}

async function notificationContext(db: Db, userId: string, briefId: string): Promise<CopilotContext> {
  const { rows } = await db.query(
    `SELECT b.id, b.class, b.headline, b.body, s.name AS security_name
       FROM briefs b LEFT JOIN securities s ON s.id = b.security_id
      WHERE b.id = $1 AND b.user_id = $2`,
    [briefId, userId],
  );
  if (rows.length === 0) throw new CopilotContextError('notification not found');
  const b = rows[0];
  const preamble =
    `You are looking at a notification Atlas sent you${b.security_name ? ` about ${b.security_name}` : ''}.\n` +
    `Headline: ${b.headline}\n${b.body}`;
  return {
    type: 'notification',
    ref: briefId,
    title: b.headline,
    preamble,
    // The brief already passed the Guard at generation; its numerals are the
    // provenanced ones the Copilot may reuse.
    allowedNumerals: numeralsIn(preamble),
    quotedSpans: [],
  };
}

// ---------------------------------------------------------------------------
// A generation turn.
// ---------------------------------------------------------------------------

const LOOKUP_TOOL: LlmToolSpec = {
  name: 'get_context_facts',
  description:
    'Return the provenanced facts already loaded for what the user is viewing. Read-only; ' +
    'use it to ground an answer in exact figures rather than guessing.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

const MAX_TOOL_HOPS = 3;

export async function answerCopilot(db: Db, input: CopilotTurnInput): Promise<CopilotTurnResult> {
  const prompt = getPrompt('copilot');
  const traceId = input.traceId ?? newTraceId();
  const provider = input.provider ?? getProvider();
  const fallback = groundedFallback(input.context, input.userMessage);

  // Memory injection (FR-10.3): the user's own rules/theses/decisions (pinned)
  // plus relevant past conversation, retrieved under a token budget and injected
  // into context. Tenant-isolated by construction (retrieveMemory scopes to the
  // user). Its numerals are the user's own provenanced figures, so they join the
  // allow-list for the numeral-preservation gate.
  const memory = await retrieveMemory(db, {
    userId: input.userId,
    query: input.userMessage,
    securityId: input.context.type === 'security' ? input.context.ref : null,
  });
  const allowedNumerals = [...input.context.allowedNumerals, ...numeralsIn(memory.text)];

  // Context is ALWAYS loaded (§11.2): it rides in the system prompt for this
  // call, so the model has it on turn one without the user restating anything.
  const system =
    `${prompt.sections.system}\n\nCONTEXT BUNDLE (ground truth):\n${input.context.preamble}` +
    (memory.text ? `\n\nMEMORY (what Atlas remembers about this user):\n${memory.text}` : '');

  const messages: LlmMessage[] = [
    ...input.history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: input.userMessage },
  ];

  let text = fallback;
  let degraded = false;
  let generative = false;
  let model = provider.name;

  // Bounded tool loop (§11.2 "tool-use through the provider"). Tools are
  // read-only context lookups; the fixture never calls them, so under the mock
  // this is a single pass returning the grounded fallback.
  for (let hop = 0; hop <= MAX_TOOL_HOPS; hop++) {
    const result = await runAgent(db, {
      agent: 'copilot',
      tier: 'mid',
      userId: input.userId, // personal — never cached (§40.4)
      system,
      messages,
      maxTokens: 1200,
      tools: [LOOKUP_TOOL],
      fallback: { text: fallback },
      promptVersion: prompt.version,
      promptHash: prompt.hash,
      inputHash: inputHash({ agent: 'copilot', ctx: input.context.ref, msg: input.userMessage, hop }),
      surface: 'copilot',
      traceId,
      provider,
    });
    model = result.model;
    degraded = result.degraded;
    generative = result.generative;
    text = result.text;

    if (result.toolCalls.length === 0 || hop === MAX_TOOL_HOPS) break;
    // Execute the read-only tools and feed the results back.
    messages.push({ role: 'assistant', content: text });
    for (const call of result.toolCalls) {
      messages.push({
        role: 'tool_result',
        content: call.name === 'get_context_facts' ? input.context.preamble : 'unknown tool',
        toolUseId: call.id,
      });
    }
  }

  // Gate 2: numeral-preservation — the answer may only use figures the context
  // or memory actually contains (guardText does not run the structural check).
  if (!numeralsSubset(text, allowedNumerals)) {
    text = fallback;
    degraded = true;
    // The user now reads the deterministic fallback, whatever wrote the draft.
    generative = false;
  }

  // Gate 3: the Guard (via egress — the sole guard caller).
  const guarded = await renderNarration({
    text,
    quotedSpans: input.context.quotedSpans,
    userId: input.userId,
    recordDecision: makePgGuardRecorder(db),
    generator: { agent: 'copilot', promptVersion: prompt.version, model },
  });

  if (!guarded.approved) {
    return {
      text:
        'Atlas can only describe what it can source for this, and it could not do that here ' +
        'without crossing into advice. Try asking about a specific figure Atlas already shows you.',
      degraded: true,
      // A refusal string written by Atlas, not by a model.
      generative: false,
      model,
      guardApproved: false,
      traceId,
    };
  }
  return { text: guarded.text, degraded, generative, model, guardApproved: true, traceId };
}

// ---------------------------------------------------------------------------
// Deterministic grounded fallback (§B8) — what the mock returns and the real
// model degrades to. Grounded in the loaded context, guard-clean, no directive.
// ---------------------------------------------------------------------------

function groundedFallback(context: CopilotContext, _userMessage: string): string {
  if (context.type === 'global') {
    return (
      'Ask Atlas about one of your holdings, your portfolio, or a notification and it will ' +
      'load that context. Open an item first and Atlas starts already knowing what you mean.'
    );
  }
  return (
    `Here is what Atlas can see for this, drawn only from your own data:\n\n${context.preamble}\n\n` +
    'Atlas can walk through any of these figures, surface where they sit against your own rules ' +
    'and thesis, and be plain about what it cannot know. The decision is always yours — what ' +
    'would you like to look at?'
  );
}

// ---------------------------------------------------------------------------
// Rendering + numerals helpers.
// ---------------------------------------------------------------------------

const SIGNAL_RENDER: Record<string, (v: ContextSignalValue) => string> = {
  'valuation.pe_ttm': (v) => `Trailing P/E: ${fixed(dec(v.value), 1)}×.`,
  'fundamental.revenue_ttm': (v) => `Trailing revenue: ${v.value}${v.currency ? ` ${v.currency}` : ''}.`,
  'fundamental.eps_diluted_ttm': (v) => `Trailing diluted EPS: ${v.value}${v.currency ? ` ${v.currency}` : ''}.`,
  'portfolio.look_through_weight': (v) => `Your look-through weight in this name: ${pct(v.value)}.`,
  'portfolio.cash_weight': (v) => `Portfolio cash weight: ${pct(v.value)}.`,
  'portfolio.effective_n': (v) => `Effective number of holdings: ${fixed(dec(v.value), 1)}.`,
  'portfolio.top_sector_weight': (v) => `Top sector weight: ${pct(v.value)}.`,
};

function renderSignalLines(signals: Record<string, ContextSignalValue>): string[] {
  const out: string[] = [];
  for (const [id, v] of Object.entries(signals)) {
    const render = SIGNAL_RENDER[id];
    if (render) out.push(render(v));
  }
  return out;
}

const pct = (v: string): string => `${fixed(dec(v).times(100), 1)}%`;

/** Numeric tokens, comma-stripped so 1,234.5 and 1234.5 compare equal. */
function numeralsIn(s: string): string[] {
  return (s.match(/\d[\d.,]*/g) ?? []).map((n) => n.replace(/,/g, ''));
}

function numeralsSubset(text: string, allowed: string[]): boolean {
  const set = new Set(allowed);
  return numeralsIn(text).every((n) => set.has(n));
}

function requireRef(ref: CopilotContextRef): string {
  if (!ref.ref) throw new CopilotContextError(`context type '${ref.type}' requires a ref`);
  return ref.ref;
}

export class CopilotContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CopilotContextError';
  }
}

export type { SecurityContext, UserBundle };
