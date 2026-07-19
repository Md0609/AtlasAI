/**
 * The Orchestrator (§21.3, D-009). Control flow is a static, named plan — not
 * a model-generated plan. Agents are pipeline stages: no agent decides what
 * runs next, spawns another, or talks to a user. This buys the benefits of
 * decomposition (cost topology, adversarial separation, auditability) without
 * the chaos of autonomy.
 *
 * MVP plans (§21.3 subset): `contextualize` — the "is X right for me" path;
 * `deep_analysis` — the full fan-out. With three MVP specialists the two share
 * a body today; deep_analysis is the seam where Competitive/Management/Macro/
 * Technical/ESG attach in v1.1.
 */
import type { Finding, SecurityContext } from '@atlas/contracts';
import { newTraceId, type LlmProvider } from '@atlas/runtime';
import type { Db } from '@atlas/dataplane';
import type { EgressResult } from '@atlas/egress';
import { buildSecurityContext } from './context.js';
import {
  runFinancialAnalysis,
  runNewsFilings,
  runRedTeam,
  runValuation,
} from './specialists.js';
import { runPsa, type PsaResult } from './psa.js';
import './prompts.js'; // side-effect: register the agent prompts

export interface OrchestratorRequest {
  userId: string;
  baseCurrency: string;
  securityId: string;
  traceId?: string;
  provider?: LlmProvider;
}

export interface OrchestratorResult {
  traceId: string;
  security: SecurityContext;
  findings: Finding[];
  psa: PsaResult;
  egress: EgressResult;
}

/** Named plan `contextualize` (§21.3). */
export async function contextualize(db: Db, req: OrchestratorRequest): Promise<OrchestratorResult> {
  const traceId = req.traceId ?? newTraceId();
  const security = await buildSecurityContext(db, req.securityId);
  const opts = { traceId, provider: req.provider };

  // Layer 1 — shared, cacheable, fanned out. Each is user-agnostic, so the
  // second holder of this security hits the cache (§40 amortization).
  const [financial, valuation, news] = await Promise.all([
    runFinancialAnalysis(db, security, opts),
    runValuation(db, security, opts),
    runNewsFilings(db, security, opts),
  ]);
  const l1 = [...financial, ...valuation, ...news];

  // Red Team attacks the synthesized view (§22.9), then everything flows to
  // the PSA chokepoint and the egress guard.
  const redTeam = await runRedTeam(db, security, l1, opts);
  const findings = [...l1, ...redTeam];

  const psa = await runPsa(db, req.userId, req.baseCurrency, security, findings, opts);
  return { traceId, security, findings, psa, egress: psa.egress };
}

/** Named plan `deep_analysis` (§21.3). All specialists + Red Team + PSA. */
export async function deepAnalysis(db: Db, req: OrchestratorRequest): Promise<OrchestratorResult> {
  // At MVP the specialist set is the same three; deep_analysis is the named
  // seam where the remaining §22 specialists attach in v1.1.
  return contextualize(db, req);
}
