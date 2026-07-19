/**
 * Layer-1 specialist agents (§22.1–22.9) and the Red Team (§22.9).
 *
 * Each is a deterministic-draft producer wrapped in runAgent. The draft is the
 * §B8 template finding set, computed from the SecurityContext signals; the mock
 * returns it verbatim, the real model would generate richer findings in the
 * same schema. Output is cached per (agent, prompt_version, security-hash) —
 * user-agnostic by construction (userId: null), which is what makes the
 * shared-analysis cache safe and the work amortizable across every holder
 * (§21.2 / §40).
 */
import { inputHash } from '@atlas/domain';
import type { Finding, SecurityContext } from '@atlas/contracts';
import { runAgent, getPrompt, type ModelTier } from '@atlas/runtime';
import type { Db } from '@atlas/dataplane';
import { getProvider } from '@atlas/runtime';
import type { LlmProvider } from '@atlas/runtime';

export interface SpecialistOpts {
  traceId: string;
  parentSpanId?: string;
  provider?: LlmProvider;
}

interface FindingAgentSpec {
  agent: string;
  tier: ModelTier;
  surface: string;
  draft: (ctx: SecurityContext, findings: Finding[]) => Finding[];
}

async function runFindingAgent(
  db: Db,
  spec: FindingAgentSpec,
  ctx: SecurityContext,
  priorFindings: Finding[],
  opts: SpecialistOpts,
): Promise<Finding[]> {
  const prompt = getPrompt(spec.agent);
  const draft = spec.draft(ctx, priorFindings);
  const ih = inputHash({
    agent: spec.agent,
    promptHash: prompt.hash,
    security: ctx.securityId,
    signals: ctx.signals,
    priorKinds: priorFindings.map((f) => f.kind),
  });

  const result = await runAgent(db, {
    agent: spec.agent,
    tier: spec.tier,
    userId: null, // Layer-1: shared, cacheable, no user (§21.2)
    system: prompt.sections.system,
    messages: [{ role: 'user', content: buildTask(spec.agent, ctx, priorFindings) }],
    maxTokens: 1200,
    jsonOutput: true,
    fallback: { text: JSON.stringify(draft) },
    promptVersion: prompt.version,
    promptHash: prompt.hash,
    inputHash: ih,
    surface: spec.surface,
    traceId: opts.traceId,
    parentSpanId: opts.parentSpanId,
    provider: opts.provider ?? getProvider(),
  });

  return parseFindings(result.text, spec.agent, draft);
}

function buildTask(agent: string, ctx: SecurityContext, priorFindings: Finding[]): string {
  const bundle = Object.entries(ctx.signals)
    .map(([k, v]) => `- ${k} = ${v.value}${v.currency ? ` ${v.currency}` : ''}`)
    .join('\n');
  const prior = priorFindings.length
    ? `\n\nSynthesized findings so far:\n${priorFindings.map((f) => `- [${f.kind}] ${f.statement}`).join('\n')}`
    : '';
  return `Security: ${ctx.name} (sector: ${ctx.gicsSector ?? 'unknown'})\nSignal bundle:\n${bundle || '- (none)'}${prior}`;
}

function parseFindings(text: string, agent: string, draft: Finding[]): Finding[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return draft;
    const out: Finding[] = [];
    for (const f of parsed) {
      if (
        f &&
        typeof f === 'object' &&
        typeof (f as Finding).kind === 'string' &&
        typeof (f as Finding).statement === 'string' &&
        Array.isArray((f as Finding).signalRefs)
      ) {
        const ff = f as Finding;
        out.push({
          agent,
          kind: ff.kind,
          statement: ff.statement,
          signalRefs: ff.signalRefs,
          confidence: ff.confidence ?? 'medium',
        });
      }
    }
    return out.length > 0 ? out : draft;
  } catch {
    return draft; // §21.4 third-strike discipline: degrade to the template
  }
}

// ---------------------------------------------------------------------------
// Deterministic drafts (the template path, always guard-clean: no digits in
// prose, numbers referenced by signal id, no directives).
// ---------------------------------------------------------------------------

const financialSpec: FindingAgentSpec = {
  agent: 'financial_analysis',
  tier: 'mid',
  surface: 'shared_analysis',
  draft: (ctx) => {
    if (ctx.signals['fundamental.revenue_ttm']) {
      return [
        {
          agent: 'financial_analysis',
          kind: 'financial.trend',
          statement:
            'On a trailing-twelve-month basis, revenue is the reference figure for the health of this business.',
          signalRefs: ['fundamental.revenue_ttm'],
          confidence: 'medium',
        },
      ];
    }
    return [
      {
        agent: 'financial_analysis',
        kind: 'financial.gap',
        statement: 'No trailing revenue is on record for this security in this window.',
        signalRefs: [],
        confidence: 'insufficient',
      },
    ];
  },
};

const valuationSpec: FindingAgentSpec = {
  agent: 'valuation',
  tier: 'mid',
  surface: 'shared_analysis',
  draft: (ctx) => {
    if (ctx.signals['valuation.pe_ttm']) {
      return [
        {
          agent: 'valuation',
          kind: 'valuation.multiple',
          statement:
            'The trailing earnings multiple is the anchor for what the market is pricing into this name.',
          signalRefs: ['valuation.pe_ttm'],
          confidence: 'medium',
        },
      ];
    }
    return [
      {
        agent: 'valuation',
        kind: 'valuation.gap',
        statement: 'There is no positive trailing earnings figure, so an earnings multiple is undefined here.',
        signalRefs: [],
        confidence: 'insufficient',
      },
    ];
  },
};

const newsSpec: FindingAgentSpec = {
  agent: 'news_filings',
  tier: 'small',
  surface: 'shared_analysis',
  draft: () => [
    {
      agent: 'news_filings',
      kind: 'news.materiality',
      statement: 'No material filing change is on record for this security in the current window.',
      signalRefs: [],
      confidence: 'low',
    },
  ],
};

const redTeamSpec: FindingAgentSpec = {
  agent: 'red_team',
  tier: 'large', // §22.9 — Opus always
  surface: 'shared_analysis',
  draft: (ctx) => [
    {
      agent: 'red_team',
      kind: 'redteam.bear',
      statement:
        `The strongest case against the emerging read: the durability of this ${ctx.gicsSector ?? 'business'} position ` +
        'is the load-bearing assumption, and a multiple that looks reasonable today reprices quickly if that assumption breaks.',
      signalRefs: ctx.signals['valuation.pe_ttm'] ? ['valuation.pe_ttm'] : [],
      confidence: 'medium',
    },
  ],
};

export async function runFinancialAnalysis(db: Db, ctx: SecurityContext, opts: SpecialistOpts): Promise<Finding[]> {
  return runFindingAgent(db, financialSpec, ctx, [], opts);
}
export async function runValuation(db: Db, ctx: SecurityContext, opts: SpecialistOpts): Promise<Finding[]> {
  return runFindingAgent(db, valuationSpec, ctx, [], opts);
}
export async function runNewsFilings(db: Db, ctx: SecurityContext, opts: SpecialistOpts): Promise<Finding[]> {
  return runFindingAgent(db, newsSpec, ctx, [], opts);
}
export async function runRedTeam(
  db: Db,
  ctx: SecurityContext,
  priorFindings: Finding[],
  opts: SpecialistOpts,
): Promise<Finding[]> {
  return runFindingAgent(db, redTeamSpec, ctx, priorFindings, opts);
}
