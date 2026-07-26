/**
 * Portfolio Strategy Agent (§22.11) — the Layer-2 chokepoint. Every finding
 * passes through here before reaching a user; personalisation is a property of
 * the system, not a feature of one output.
 *
 * The PSA builds a ContextualizationDoc: facts by signal reference, tensions
 * anchored to the user's own rows (§28.2), the Red Team's countercase, and the
 * honest unknown. It runs through runAgent (personal, NEVER cached — §40.4)
 * and then through the egress module, the sole constructor of
 * UserFacingContent, which runs the Guard. The mock's deterministic draft is
 * guard-clean by construction; the real model's output is held to the same
 * gate, and on rejection the orchestrator degrades to the template.
 */
import { inputHash } from '@atlas/domain';
import type {
  ContextConfidence,
  ContextSection,
  ContextSignalValue,
  ContextualizationDoc,
  Finding,
  SecurityContext,
} from '@atlas/contracts';
import { getPrompt, getProvider, runAgent, type LlmMessage, type LlmProvider } from '@atlas/runtime';
import type { Db } from '@atlas/dataplane';
import {
  isRejected,
  makePgGuardRecorder,
  makePgQuoteVerifier,
  renderUserFacingContent,
  type EgressResult,
} from '@atlas/egress';
import { buildUserBundle, mergeSignals, type UserBundle } from './context.js';
import { correctionForViolations, withRegeneration } from './regeneration.js';

const CONCENTRATION_RULES = new Set(['max_single_name', 'max_sector', 'min_cash', 'max_cash', 'max_positions']);

export interface PsaResult {
  doc: ContextualizationDoc;
  egress: EgressResult;
  model: string;
  degraded: boolean;
  /**
   * false ⇒ no language model wrote this document (N-7).
   *
   * The third prose surface, and the one W2 missed: narration and the Copilot
   * carry this, the PSA did not. It matters most here, because these documents
   * are now PERSISTED for the v1.1 Scorecard — recording a fixture-written
   * claim as model analysis would be a permanent error in the record the whole
   * calibration rests on.
   */
  generative: boolean;
  /** §21.6: how many regenerations the Guard forced (0..2). */
  regenerations: number;
  /**
   * Which prompt produced this. Needed by the persisted record (P0-8): a
   * recalibration has to know what it is recalibrating, and "the PSA" is not
   * an answer once the prompt has been revised.
   */
  promptVersion: string;
}

export async function runPsa(
  db: Db,
  userId: string,
  baseCurrency: string,
  security: SecurityContext,
  findings: Finding[],
  opts: { traceId: string; parentSpanId?: string; provider?: LlmProvider },
): Promise<PsaResult> {
  const user = await buildUserBundle(db, userId, baseCurrency, security.securityId);
  const signals = mergeSignals(security, user);
  const draft = buildDraftDoc(userId, security, findings, user, signals);

  const prompt = getPrompt('psa');
  const ih = inputHash({
    agent: 'psa',
    promptHash: prompt.hash,
    userId,
    security: security.securityId,
    findings: findings.map((f) => [f.kind, f.statement]),
    rules: user.rules.map((r) => [r.id, r.status]),
    thesis: user.thesis?.id ?? null,
    met: user.metConditions.map((c) => c.id),
  });

  const verifyQuote = makePgQuoteVerifier(db);
  const recordDecision = makePgGuardRecorder(db);
  const baseMessages: LlmMessage[] = [{ role: 'user', content: buildTask(security, findings) }];
  const provider = opts.provider ?? getProvider();

  // §21.6: generate → guard → regenerate ≤2 (feeding the specific violations
  // back) → degrade. Each attempt is a real, traced generation; its verdict is
  // recorded with the regeneration index.
  const gen = await withRegeneration(async (attemptIndex, priorViolations) => {
    const messages: LlmMessage[] =
      priorViolations.length > 0
        ? [...baseMessages, { role: 'user', content: correctionForViolations(priorViolations) }]
        : baseMessages;
    const result = await runAgent(db, {
      agent: 'psa',
      tier: 'mid',
      userId, // personal — never cached (§40.4)
      system: prompt.sections.system,
      messages,
      maxTokens: 2000,
      jsonOutput: true,
      fallback: { text: JSON.stringify(draft) },
      promptVersion: prompt.version,
      promptHash: prompt.hash,
      inputHash: ih,
      surface: 'contextualize',
      traceId: opts.traceId,
      parentSpanId: opts.parentSpanId,
      provider,
    });
    const doc = parseDoc(result.text, draft);
    const egress = await renderUserFacingContent(doc, {
      verifyQuote,
      recordDecision,
      regenerated: attemptIndex,
    });
    return {
      approved: !isRejected(egress),
      result: {
        doc,
        egress,
        model: result.model,
        degraded: result.degraded,
        generative: result.generative,
      },
      violations: isRejected(egress) ? egress.verdict.violations : [],
    };
  });

  if (gen.approved) {
    return {
      doc: gen.result.doc,
      egress: gen.result.egress,
      model: gen.result.model,
      degraded: gen.result.degraded,
      generative: gen.result.generative,
      regenerations: gen.regenerations,
      promptVersion: prompt.version,
    };
  }

  // §21.6: retries exhausted → degrade to a minimal, guaranteed-clean doc
  // (facts + unknown only, no user quotes) rather than surface nothing.
  const safe = buildSafeDoc(userId, security, findings, signals);
  const safeEgress = await renderUserFacingContent(safe, {
    verifyQuote,
    recordDecision,
    regenerated: gen.regenerations,
  });
  // The safe doc is assembled from findings and signals by Atlas, not written
  // by a model, whatever produced the rejected draft.
  return {
    doc: safe,
    egress: safeEgress,
    model: gen.result.model,
    degraded: true,
    generative: false,
    regenerations: gen.regenerations,
    promptVersion: prompt.version,
  };
}

function buildTask(security: SecurityContext, findings: Finding[]): string {
  return (
    `Contextualise ${security.name} for this user.\n` +
    `Findings:\n${findings.map((f) => `- [${f.kind}] ${f.statement}`).join('\n')}`
  );
}

function buildDraftDoc(
  userId: string,
  security: SecurityContext,
  findings: Finding[],
  user: UserBundle,
  signals: Record<string, ContextSignalValue>,
): ContextualizationDoc {
  const sections: ContextSection[] = [];

  // Facts from the specialist findings (prose only — numbers stay refs).
  for (const f of findings.filter((x) => x.agent !== 'red_team')) {
    sections.push({ type: 'fact', spans: [{ kind: 'text', text: f.statement }] });
  }

  // A fact that actually renders a number by reference (US-AI-02).
  if (signals['portfolio.look_through_weight']) {
    sections.push({
      type: 'fact',
      spans: [
        { kind: 'text', text: 'Your look-through exposure to this name is ' },
        { kind: 'signal', signalId: 'portfolio.look_through_weight', format: 'percent', dp: 1 },
        { kind: 'text', text: ' of your portfolio.' },
      ],
    });
  }

  // T1 tensions: each breached concentration rule, anchored + quoted (§28.2/§14.6).
  for (const r of user.rules) {
    if (r.status === 'breach' && CONCENTRATION_RULES.has(r.ruleType)) {
      sections.push({
        type: 'tension',
        tensionType: 'T1',
        anchor: { table: 'rules', id: r.id },
        spans: [
          { kind: 'text', text: 'This sits against a rule you set for yourself. When you set it, you wrote: ' },
          {
            kind: 'user_quote',
            text: r.statedReason,
            source: { table: 'rules', id: r.id, column: 'stated_reason' },
          },
        ],
      });
    }
  }

  // T2 tensions: met falsification conditions, anchored to the thesis (§6.2).
  for (const c of user.metConditions) {
    sections.push({
      type: 'tension',
      tensionType: 'T2',
      anchor: { table: 'theses', id: c.thesisId },
      spans: [
        { kind: 'text', text: 'Your own falsification condition is met. You wrote: ' },
        {
          kind: 'user_quote',
          text: c.conditionNl,
          source: { table: 'thesis_conditions', id: c.id, column: 'condition_nl' },
        },
      ],
    });
  }

  // Countercase from the Red Team.
  const bear = findings.find((f) => f.agent === 'red_team');
  if (bear) {
    sections.push({ type: 'countercase', spans: [{ kind: 'text', text: bear.statement }] });
  }

  // The honest unknown (never collapsed — §10.2 L6).
  sections.push({
    type: 'unknown',
    spans: [
      {
        kind: 'text',
        text:
          'What Atlas cannot tell you: whether the load-bearing assumption in the bear case holds. ' +
          'That is the whole question, and it is not answerable from the figures on record.',
      },
    ],
  });

  const confidence: ContextConfidence = {
    level: findings.some((f) => f.confidence === 'insufficient') ? 'low' : 'medium',
    basis: [
      {
        kind: 'text',
        text: 'Based on the figures on record for this security together with your own stated rules and thesis.',
      },
    ],
    whatWouldChangeIt: [
      'The next quarterly filing for this security',
      'A change you make to your own rules or thesis',
    ],
  };

  return {
    userId,
    subject: { scope: 'security', securityId: security.securityId },
    sections,
    confidence,
    signals,
    generator: { agent: 'psa', promptVersion: '1.0.0', model: 'fixture' },
  };
}

/** Minimal, guaranteed guard-clean doc: no user quotes, no directive surface. */
function buildSafeDoc(
  userId: string,
  security: SecurityContext,
  findings: Finding[],
  signals: Record<string, ContextSignalValue>,
): ContextualizationDoc {
  const sections: ContextSection[] = findings
    .filter((f) => f.agent !== 'red_team')
    .map((f) => ({ type: 'fact' as const, spans: [{ kind: 'text' as const, text: f.statement }] }));
  sections.push({
    type: 'unknown',
    spans: [{ kind: 'text', text: 'Atlas is showing only the facts it can source for this security.' }],
  });
  return {
    userId,
    subject: { scope: 'security', securityId: security.securityId },
    sections,
    confidence: {
      level: 'low',
      basis: [{ kind: 'text', text: 'Reduced to sourced facts after a compliance check.' }],
      whatWouldChangeIt: ['A fresh analysis pass'],
    },
    signals,
    generator: { agent: 'psa.safe', promptVersion: '1.0.0', model: 'template' },
  };
}

function parseDoc(text: string, draft: ContextualizationDoc): ContextualizationDoc {
  try {
    const parsed = JSON.parse(text) as ContextualizationDoc;
    if (
      parsed &&
      Array.isArray(parsed.sections) &&
      parsed.confidence &&
      Array.isArray(parsed.confidence.whatWouldChangeIt) &&
      parsed.signals
    ) {
      // The generator field is the truth of who produced it; keep the draft's
      // signal bundle so references always resolve regardless of model echo.
      return { ...parsed, signals: draft.signals };
    }
    return draft;
  } catch {
    return draft;
  }
}
